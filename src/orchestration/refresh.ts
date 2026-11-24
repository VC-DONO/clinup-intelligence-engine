import { createHash, randomUUID } from "node:crypto";
import {
  AdversarialOutput, AuditOutput, CompetitiveOutput, EditorOutput, FactCheckOutput, FitOutput, OpportunityOutput,
  ResearchOutput, RiskOutput, StrategyOutput, SummaryOutput, WeakSignalOutput,
} from "../agents/schemas.js";
import { asData, type PromptSet } from "../agents/prompts.js";
import type { Config } from "../config/config.js";
import { canonicalizeUrl, dedupe, independentConfirmations } from "../deduplication/url.js";
import { type AgentRequest, type AgentResult, BudgetExceededError, type LlmPort, type Usage } from "../llm/port.js";
import { FileStore, historyStatusFor, loadHistory, type HistoryIndex } from "../persistence/store.js";
import {
  type CandidatePublication, type DecisionRecord, type EvidenceRecord, type HistoryStatus, PublishedReport,
  type PublishedNews, type RunContext, type RunRequest, SCHEMA_VERSION,
} from "../schemas/contracts.js";
import { computeScore, type ScoreResult } from "../scoring/score.js";
import { looksLikeInjection, sensationalHits, unsupportedNumbers } from "../security/guards.js";
import { classifyTemporal, computeWindow, type TemporalResult } from "../temporal/window.js";
import type { Veto, VetoCode } from "../vetoes/codes.js";
import { mapPool } from "./pool.js";
import { type RunState, RunStateMachine } from "./state.js";

export interface CoverageGroup {
  id: string; label: string; filter_keywords: string[]; themes: number[]; focus: string; sources_hint: string[];
}
export interface Catalog { approved: boolean; services: { id: string; name: string; solves?: string[]; limits?: string }[] }

export interface RefreshDeps {
  llm: LlmPort;
  store: FileStore;
  config: Config;
  prompts: PromptSet;
  coverage: CoverageGroup[];
  catalog: Catalog;
  now?: () => Date;
}

interface Item {
  candidate: CandidatePublication;
  vetoes: Veto[];
  temporal?: TemporalResult;
  fc?: FactCheckOutput;
  evidence: EvidenceRecord[];
  event_key?: string;
  history?: HistoryStatus;
  independent?: number;
  risk?: RiskOutput;
  opp?: OpportunityOutput;
  strategy?: StrategyOutput;
  fit?: FitOutput;
  score?: ScoreResult;
  draft?: EditorOutput;
  adversarial?: AdversarialOutput;
  audit?: AuditOutput;
  caveats: string[];
  incomplete?: string;
  downgraded?: boolean;
}

export interface RefreshOutcome {
  run_id: string;
  state: RunState;
  report: PublishedReport | null;
  warnings: string[];
  metrics: Record<string, unknown>;
}

const AT = () => new Date().toISOString();

function canon(u: string): string | null {
  try { return canonicalizeUrl(u); } catch { return null; }
}

export async function refresh(request: RunRequest, deps: RefreshDeps): Promise<RefreshOutcome> {
  const { llm, store, config, prompts, catalog } = deps;
  const t0 = (deps.now ?? (() => new Date()))();
  const window = computeWindow(t0, config.freshness_window_hours);
  const run_id = randomUUID();
  const sm = new RunStateMachine();
  const decisions: DecisionRecord[] = [];
  const agentLog: { agent: string; subject: string; ok: boolean; error?: string; usage: Usage; at: string }[] = [];
  const stageTimes: Record<string, number> = {};
  let stageStart = Date.now();
  let budgetHit = false;
  const runDir = `runs/${t0.toISOString().slice(0, 10)}_${run_id.slice(0, 8)}`;

  const ctx: RunContext = {
    run_id,
    started_at: t0.toISOString(),
    timezone: "America/Sao_Paulo",
    window_start: window.windowStart.toISOString(),
    window_end: window.windowEnd.toISOString(),
    freshness_window_hours: config.freshness_window_hours,
    config_version: config.config_version,
    // Cada agente é uma chamada de API separada, com contexto isolado e sem ver o raciocínio dos demais.
    execution_mode: "multi_agent",
    available_capabilities: llm.capabilities(),
    limitations: [],
  };

  const go = (s: RunState) => {
    stageTimes[sm.state] = Date.now() - stageStart;
    stageStart = Date.now();
    sm.transition(s);
  };
  const decide = (d: Omit<DecisionRecord, "decision_id" | "run_id" | "timestamp" | "actor"> & { actor?: string }) => {
    decisions.push({ decision_id: randomUUID(), run_id, timestamp: AT(), actor: d.actor ?? "orchestrator", ...d });
  };
  const veto = (it: Item, code: VetoCode, reason: string, actor = "orchestrator", evidence_ids: string[] = []) => {
    it.vetoes.push({ code, reason, evidence_ids, actor, at: AT() });
    decide({ event_id: it.event_key ?? null, candidate_id: it.candidate.candidate_id, decision_type: "veto",
      decision_status: "blocked", rule_id: code, evidence_ids, reason, actor, previous_status: "candidate", new_status: "vetoed" });
  };

  async function call<T>(req: Omit<AgentRequest<T>, "system">, subject: string): Promise<AgentResult<T> | null> {
    if (budgetHit) return null;
    try {
      const res = await llm.run({ ...req, system: prompts[req.agent] });
      agentLog.push({ agent: req.agent, subject, ok: res.ok, error: res.ok ? undefined : res.error, usage: res.usage, at: AT() });
      if (!res.ok) sm.warn(`Agente ${req.agent} falhou em "${subject}": ${res.error}`);
      return res;
    } catch (e) {
      if (e instanceof BudgetExceededError) {
        if (!budgetHit) sm.warn(`Teto de custo atingido (US$ ${config.limits.max_cost_usd_per_run}); etapas restantes não executadas.`);
        budgetHit = true;
        return null;
      }
      throw e;
    }
  }

  const windowText = `Janela: de ${ctx.window_start} até T0 = ${ctx.window_end} (${config.freshness_window_hours} horas, fuso America/Sao_Paulo).`;
  let report: PublishedReport | null = null;
  const items: Item[] = [];
  const groupsSearched: string[] = [];
  const groupsNotSearched: string[] = [];
  const allQueries: string[] = [];

  try {
    // 1. Planejamento
    go("planning");
    const sub = request.command.replace(/^REFRESH\s*/, "").trim();
    const groups = sub ? deps.coverage.filter((g) => g.filter_keywords.includes(sub)) : deps.coverage;
    if (!groups.length) throw new Error(`Filtro desconhecido: ${sub}`);
    const history = request.compare_history ? await loadHistory(store) : { available: false as const, reason: "compare_history = false" };
    if (!history.available) ctx.limitations.push(`Histórico indisponível: ${history.reason}. Nada é marcado como inédito.`);

    // 2. Pesquisa (com segunda rodada para grupos sem resultado)
    go("searching");
    const research = async (g: CoverageGroup, round: number) => {
      const res = await call({
        agent: "researcher", model: config.models.research, schema: ResearchOutput, effort: "medium",
        web: { search: 12, fetch: 8 },
        prompt: [
          windowText,
          `Hoje (T0) em São Paulo: ${t0.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}.`,
          round > 1 ? "Segunda rodada: a primeira não trouxe candidatos. Tente outras consultas, fontes e idiomas." : "",
          asData("grupo_tematico", { id: g.id, tema: g.label, foco: g.focus, fontes_sugeridas: g.sources_hint, idiomas: config.languages, regioes: config.regions }),
        ].join("\n\n"),
      }, `grupo ${g.id} (rodada ${round})`);
      if (res) allQueries.push(...res.trace.search_queries);
      return res;
    };
    const researchResults = new Map<string, AgentResult<ResearchOutput> | null>();
    await mapPool(groups, config.concurrency, async (g) => { researchResults.set(g.id, await research(g, 1)); });
    for (const g of groups) {
      const r = researchResults.get(g.id);
      if (r?.ok && r.output.candidates.length === 0 && !budgetHit) researchResults.set(g.id, (await research(g, 2)) ?? r);
    }
    for (const g of groups) {
      const r = researchResults.get(g.id);
      if (r?.ok) groupsSearched.push(g.label);
      else { groupsNotSearched.push(g.label); ctx.limitations.push(`Pesquisa do grupo "${g.label}" não concluída: ${r ? r.error : "não executada"}`); }
      if (r?.ok) for (const gap of r.output.coverage_gaps) ctx.limitations.push(`Lacuna em "${g.label}": ${gap}`);
    }
    for (const g of deps.coverage) if (!groups.includes(g)) groupsNotSearched.push(`${g.label} (fora do filtro ${request.command})`);
    if (!groupsSearched.length) throw new Error("Nenhuma pesquisa foi concluída: execução não pode ser apresentada como completa");

    // 3. Normalização
    go("normalizing");
    for (const g of groups) {
      const r = researchResults.get(g.id);
      if (!r?.ok) continue;
      for (const c of r.output.candidates) {
        const cu = canon(c.url);
        if (!cu) { ctx.limitations.push(`URL inválida descartada: ${c.url.slice(0, 120)}`); continue; }
        const candidate: CandidatePublication = {
          candidate_id: randomUUID(), run_id, title_original: c.title, title_translated: null,
          url_discovered: c.url, canonical_url: cu, publisher: c.publisher, publisher_type: c.publisher_type,
          language: c.language, region: c.region,
          published_at_claimed: c.published_at_claimed, updated_at_claimed: c.updated_at_claimed, event_date_claimed: null,
          first_seen_at: AT(), access_status: r.trace.fetched.has(cu) ? "content_extracted" : "found",
          content_excerpt: c.summary.slice(0, 2000), search_queries: r.trace.search_queries,
          topic_categories: [...c.topic_categories, g.id], relevance_rationale: c.relevance_rationale,
          provenance_parent_ids: c.republication_of_url ? [canon(c.republication_of_url) ?? c.republication_of_url] : [],
          limitations: [],
        };
        const it: Item = { candidate, vetoes: [], evidence: [], caveats: [] };
        items.push(it);
        if (looksLikeInjection(`${c.title}\n${c.summary}`)) {
          veto(it, "V015_PROMPT_INJECTION_OR_UNTRUSTED_INSTRUCTION", "Conteúdo do candidato contém instruções ao sistema", "orchestrator");
        }
      }
    }

    // 4. Deduplicação de publicações
    go("deduplicating");
    const live = () => items.filter((i) => !i.vetoes.length && !i.incomplete);
    const links = dedupe(live().map((i) => ({ id: i.candidate.candidate_id, url: i.candidate.url_discovered, title: i.candidate.title_original })));
    for (const l of links) {
      const it = items.find((i) => i.candidate.candidate_id === l.id)!;
      if (l.duplicate_of) veto(it, "V008_DUPLICATE_NO_NEW_DEVELOPMENT", `Mesma URL canônica de ${l.duplicate_of}`, "deduplication");
      // "possible_same_event_as" fica para a chave de acontecimento do verificador; não fundimos por título.
    }

    // 5. Pré-filtro temporal sobre a data alegada (economiza verificação de itens claramente antigos)
    go("date_filtering");
    for (const it of live()) {
      const pre = classifyTemporal(
        { published_at_confirmed: it.candidate.published_at_claimed, updated_at_claimed: it.candidate.updated_at_claimed },
        window, config.future_date_tolerance_minutes,
      );
      if (pre.veto === "V001_OUT_OF_WINDOW") veto(it, "V001_OUT_OF_WINDOW", `Data alegada fora da janela: ${pre.reason}`, "temporal_filter");
    }
    const queue = live().sort((a, b) => rank(b) - rank(a));
    for (const it of queue.slice(config.max_candidates_to_verify)) {
      it.incomplete = "Não verificado: limite de candidatos por execução";
    }
    if (queue.length > config.max_candidates_to_verify) {
      ctx.limitations.push(`${queue.length - config.max_candidates_to_verify} candidatos não foram verificados por limite operacional.`);
    }

    // 6. Verificação independente + vetos determinísticos
    go("fact_checking");
    await mapPool(live(), config.concurrency, async (it) => {
      const c = it.candidate;
      const res = await call({
        agent: "fact_checker", model: config.models.verification, schema: FactCheckOutput, effort: "medium",
        web: { search: 6, fetch: 6 },
        prompt: [windowText,
          "A publicação abaixo foi encontrada por outro agente. O resumo dele é só uma pista e pode estar errado.",
          asData("candidato", { titulo: c.title_original, url: c.url_discovered, veiculo: c.publisher, tipo: c.publisher_type,
            data_alegada: c.published_at_claimed, atualizacao_alegada: c.updated_at_claimed, resumo_do_pesquisador: c.content_excerpt }),
        ].join("\n\n"),
      }, c.title_original);
      if (!res) { it.incomplete = "Verificação não executada (teto de custo)"; return; }
      if (!res.ok) { it.incomplete = `Verificação falhou: ${res.error}`; return; }
      applyFactCheck(it, res.output, res.trace.fetched, res.trace.fetch_failures.length);
    });
    sm.passGate("temporal_filter");

    // Deduplicação por acontecimento dentro da execução + histórico
    const byEvent = new Map<string, Item[]>();
    for (const it of live()) {
      const k = it.event_key!;
      byEvent.set(k, [...(byEvent.get(k) ?? []), it]);
    }
    for (const [k, group] of byEvent) {
      group.sort((a, b) => (b.independent ?? 0) - (a.independent ?? 0) || b.evidence.length - a.evidence.length);
      for (const dup of group.slice(1)) veto(dup, "V008_DUPLICATE_NO_NEW_DEVELOPMENT", `Mesmo acontecimento (${k}) já coberto nesta execução`, "deduplication");
      const keep = group[0]!;
      keep.history = historyStatusFor(history, k, keep.temporal?.category === "substantive_new_development");
      if (keep.history === "ALREADY_REPORTED") veto(keep, "V008_DUPLICATE_NO_NEW_DEVELOPMENT", "Já publicado em execução anterior, sem desenvolvimento material", "history");
    }
    sm.passGate("fact_check");

    // 7. Análises (risco e oportunidade independentes; depois estratégia e aderência)
    go("analyzing");
    await mapPool(live(), config.concurrency, async (it) => {
      const dossier = dossierOf(it);
      const [risk, opp] = await Promise.all([
        call({ agent: "risk_analyst", model: config.models.analysis, schema: RiskOutput, effort: "low", prompt: asData("dossie", dossier) }, it.event_key!),
        call({ agent: "opportunity_analyst", model: config.models.analysis, schema: OpportunityOutput, effort: "low", prompt: asData("dossie", dossier) }, it.event_key!),
      ]);
      if (!risk?.ok || !opp?.ok) { it.incomplete = "Análise crítica ou de oportunidades indisponível"; return; }
      it.risk = risk.output; it.opp = opp.output;
      const strat = await call({
        agent: "clinic_strategy_analyst", model: config.models.analysis, schema: StrategyOutput, effort: "medium",
        prompt: [asData("dossie", dossier), asData("analise_critica", it.risk), asData("analise_oportunidades", it.opp)].join("\n\n"),
      }, it.event_key!);
      if (!strat?.ok) { it.incomplete = "Análise estratégica indisponível"; return; }
      it.strategy = strat.output;
      try { it.score = computeScore(strat.output.scores); } catch (e) { it.incomplete = `Pontuação inválida: ${(e as Error).message}`; return; }
      const catalogUsable = catalog.approved && catalog.services.length > 0;
      const fit = catalogUsable ? await call({
        agent: "clinup_fit_analyst", model: config.models.analysis, schema: FitOutput, effort: "low",
        prompt: [asData("catalogo_clinup", catalog.services), asData("dossie", dossier), asData("estrategia", it.strategy)].join("\n\n"),
      }, it.event_key!) : null;
      it.fit = enforceFit(fit?.ok ? fit.output : null, catalog, catalogUsable);
    });

    // 8. Redação + contraditório
    go("challenging");
    await mapPool(live(), config.concurrency, async (it) => {
      const draft = await editorRun(it, []);
      if (!draft) return;
      it.draft = draft;
      const adv = await call({
        agent: "adversarial_reviewer", model: config.models.analysis, schema: AdversarialOutput, effort: "medium",
        prompt: [asData("dossie", dossierOf(it)), asData("estrategia", it.strategy), asData("texto_proposto", it.draft)].join("\n\n"),
      }, it.event_key!);
      if (!adv?.ok) { it.incomplete = "Contraditório indisponível: não é possível alegar revisão completa"; return; }
      it.adversarial = adv.output;
      const d = adv.output.decision;
      if (d === "block") {
        if (adv.output.violated_rule) {
          const code = (/V0\d\d_[A-Z_]+/.exec(adv.output.violated_rule)?.[0] as VetoCode | undefined) ?? "V011_EDITORIAL_FIDELITY_FAILURE";
          veto(it, code, `Contraditório: ${adv.output.violated_rule}. ${adv.output.problems.join("; ")}`, "adversarial_reviewer");
          return;
        }
        // Bloqueio sem regra apontada não vale (seção 4.11): vira ressalva.
        it.caveats.push(...adv.output.problems);
      } else if (d === "correct") {
        const fixed = await editorRun(it, adv.output.required_corrections);
        if (fixed) it.draft = fixed;
      } else if (d === "downgrade") {
        it.downgraded = true;
      } else if (d === "state_uncertainty") {
        it.caveats.push(...adv.output.problems);
      }
      decide({ event_id: it.event_key!, candidate_id: it.candidate.candidate_id, decision_type: d === "keep" ? "approve" : d === "downgrade" ? "downgrade" : "correct",
        decision_status: d, rule_id: "4.11", evidence_ids: [], reason: adv.output.problems.join("; ") || "sem problemas materiais",
        actor: "adversarial_reviewer", previous_status: "drafted", new_status: d });
    });

    // 9. Auditoria final (código + agente), com um ciclo de correção
    go("editorial_review");
    await mapPool(live(), config.concurrency, async (it) => {
      if (!it.draft) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        const codeIssues = codeAudit(it);
        const aud = await call({
          agent: "final_auditor", model: config.models.analysis, schema: AuditOutput, effort: "medium",
          prompt: [asData("registros_de_evidencia", it.evidence.map((e) => ({ url: e.source_url, fonte: e.source_name, data: e.published_at, trecho: e.evidence_excerpt, sustenta: e.supports_or_contradicts }))),
            asData("afirmacoes_verificadas", it.fc!.central_claims), asData("ressalvas_obrigatorias", [...it.fc!.limitations, ...it.caveats]),
            asData("texto_final", it.draft)].join("\n\n"),
        }, it.event_key!);
        if (!aud?.ok) { it.incomplete = "Auditoria final indisponível"; return; }
        it.audit = aud.output;
        const fails = [...codeIssues.blocking, ...(aud.output.result === "fail" ? aud.output.required_corrections.length ? aud.output.required_corrections : [aud.output.justification] : [])];
        if (!fails.length) return;
        if (attempt === 0) {
          const fixed = await editorRun(it, fails);
          if (!fixed) return;
          it.draft = fixed;
          continue;
        }
        const code: VetoCode = codeIssues.missingLinks ? "V012_MISSING_EVIDENCE_LINK" : "V011_EDITORIAL_FIDELITY_FAILURE";
        veto(it, code, `Auditoria final reprovou após correção: ${fails.join("; ")}`, "final_auditor");
      }
    });
    sm.passGate("final_audit");

    // 10. Montagem do relatório
    go("assembling_report");
    const approved = live().filter((i) => i.draft && i.audit && i.score);
    for (const it of items.filter((i) => i.incomplete && !i.vetoes.length)) {
      decide({ event_id: it.event_key ?? null, candidate_id: it.candidate.candidate_id, decision_type: "reject", decision_status: "incomplete",
        rule_id: "2.4", evidence_ids: [], reason: it.incomplete!, previous_status: "candidate", new_status: "not_published" });
    }
    const ranked = approved
      .map((it) => ({ it, band: it.downgraded ? capBand(it.score!.band) : it.score!.band }))
      .filter((x) => x.band !== "fora_do_principal")
      .sort((a, b) => b.it.score!.score - a.it.score!.score)
      .slice(0, Math.min(request.max_main_news, config.max_main_news));
    for (const it of approved.filter((a) => !ranked.some((r) => r.it === a))) {
      decide({ event_id: it.event_key!, candidate_id: it.candidate.candidate_id, decision_type: "reject", decision_status: "below_threshold",
        rule_id: "8.3", evidence_ids: [], reason: `Pontuação ${it.score!.score} abaixo do corte ou fora do limite editorial`, previous_status: "audited", new_status: "stored_only" });
    }
    const news = ranked.map(({ it, band }) => toPublished(it, band as PublishedNews["priority"]));
    for (const n of news) {
      decide({ event_id: n.event_id, candidate_id: null, decision_type: "approve", decision_status: "published", rule_id: "12",
        evidence_ids: n.sources.map((s) => s.url), reason: `Aprovada com pontuação ${n.score}`, previous_status: "audited", new_status: "published" });
    }

    const compact = news.map((n) => ({ event_id: n.event_id, titulo: n.title, o_que: n.what_happened, fonte: n.main_source, categoria: n.category, data: n.published_at }));
    let competitive: PublishedReport["competitive_moves"] = [];
    let weak: PublishedReport["weak_signals"] = [];
    if (news.length && config.enable_competitive_intelligence) {
      const r = await call({ agent: "competitive_intelligence_analyst", model: config.models.analysis, schema: CompetitiveOutput, effort: "low", prompt: asData("noticias_aprovadas", compact) }, "semana");
      if (r?.ok) {
        const allowed = new Set(news.flatMap((n) => [n.main_source.url, ...n.sources.map((s) => s.url)]).map((u) => canon(u)));
        competitive = r.output.signals.filter((s) => allowed.has(canon(s.source_url)))
          .map((s) => ({ organization: s.organization, move: s.move, source_url: s.source_url, confirmation: s.confirmation }));
      }
    }
    if (news.length >= 2 && config.enable_weak_signals) {
      const r = await call({ agent: "weak_signal_analyst", model: config.models.analysis, schema: WeakSignalOutput, effort: "medium", prompt: asData("noticias_aprovadas", compact) }, "semana");
      if (r?.ok && r.output.material_signal_found) {
        const ids = new Set(news.map((n) => n.event_id));
        weak = r.output.hypotheses
          .filter((h) => new Set(h.component_event_ids.filter((x) => ids.has(x))).size >= 2)
          .map((h) => ({ hypothesis: h.hypothesis, confidence: h.confidence, signals: h.component_event_ids }));
      }
    }
    let summary = { executive_summary: "", follow_up: [] as string[] };
    if (news.length) {
      const r = await call({ agent: "summary", model: config.models.editorial, schema: SummaryOutput, effort: "low", prompt: asData("noticias_aprovadas", compact) }, "resumo");
      if (r?.ok) summary = r.output;
    }
    if (!summary.executive_summary) {
      summary.executive_summary = news.length
        ? news.map((n) => n.editorial.summary).join(" ")
        : "Nenhuma notícia passou por todos os critérios de data, evidência e revisão nesta semana. Veja as pesquisas realizadas e as limitações.";
    }

    const byVeto: Record<string, number> = {};
    for (const it of items) for (const v of it.vetoes) byVeto[v.code] = (byVeto[v.code] ?? 0) + 1;

    const runState = sm.warnings.length ? "completed_with_warnings" : "completed";
    const candidateReport = {
      schema_version: SCHEMA_VERSION,
      run_id,
      run_state: runState,
      generated_at: AT(),
      window: { start: ctx.window_start, end: ctx.window_end, hours: config.freshness_window_hours, timezone: ctx.timezone },
      coverage: { categories_searched: groupsSearched, categories_not_searched: groupsNotSearched, queries: allQueries.length },
      limitations: [...ctx.limitations, ...sm.warnings],
      executive_summary: summary.executive_summary,
      news,
      weak_signals: weak,
      competitive_moves: competitive,
      follow_up: summary.follow_up,
      exclusions: { total_candidates: items.length, by_veto: byVeto },
    };
    // Integridade: contrato válido e nenhum item vetado no relatório principal.
    report = PublishedReport.parse(candidateReport);
    const vetoedKeys = new Set(items.filter((i) => i.vetoes.length).map((i) => i.event_key).filter(Boolean));
    const keptKeys = new Set(approved.map((i) => i.event_key));
    for (const n of report.news) if (vetoedKeys.has(n.event_id) && !keptKeys.has(n.event_id)) throw new Error(`Integridade: ${n.event_id} vetado aparece no relatório`);
    sm.passGate("report_integrity");

    // 11. Persistência
    await persistRun();
    await updateHistory(report);
    sm.passGate("persistence");
    sm.finish();
    await store.writeJson(`${runDir}/run.json`, runSummary());
  } catch (e) {
    sm.warn(`Falha: ${(e as Error).message}`);
    if (sm.state !== "failed" && !["completed", "completed_with_warnings"].includes(sm.state)) sm.transition("failed");
    report = null;
    try { await persistRun(); await store.writeJson(`${runDir}/run.json`, runSummary()); }
    catch (pe) { sm.warnings.push(`Falha ao persistir auditoria: ${(pe as Error).message}`); }
  }

  return { run_id, state: sm.state, report, warnings: sm.warnings, metrics: metrics() };

  // ---------- funções internas ----------

  function rank(it: Item): number {
    let s = 0;
    if (it.candidate.publisher_type === "official") s += 3;
    if (it.candidate.publisher_type === "trade_press" || it.candidate.publisher_type === "news_outlet") s += 1;
    if (it.candidate.access_status === "content_extracted") s += 1;
    if (it.candidate.published_at_claimed) s += 1;
    return s;
  }

  function applyFactCheck(it: Item, fc: FactCheckOutput, fetched: Map<string, unknown>, fetchFailures: number) {
    it.fc = fc;
    it.event_key = slug(fc.canonical_event_key) || `evt-${it.candidate.candidate_id.slice(0, 8)}`;
    const c = it.candidate;
    // Evidência só conta se a página foi aberta nesta verificação (V013 para o resto).
    const dropped: string[] = [];
    for (const e of fc.evidence) {
      const cu = canon(e.url);
      if (!cu || !fetched.has(cu)) { dropped.push(e.url); continue; }
      if (looksLikeInjection(e.excerpt)) { c.limitations.push(`Evidência descartada por conter instruções: ${e.url}`); continue; }
      it.evidence.push({
        evidence_id: `ev-${createHash("sha256").update(cu).digest("hex").slice(0, 12)}`,
        run_id, candidate_id: c.candidate_id, event_id: it.event_key, claim_id: null,
        source_url: e.url, canonical_url: cu, source_name: e.source_name, source_type: e.source_type,
        accessed_at: AT(), published_at: e.published_at, evidence_excerpt: e.excerpt.slice(0, 600),
        document_locator: e.locator, supports_or_contradicts: e.supports_or_contradicts,
        independence_group: e.independence_group || cu, reliability_notes: "", content_hash: null, access_status: "content_extracted",
      });
    }
    if (dropped.length) c.limitations.push(`Evidências citadas sem abertura confirmada (descartadas): ${dropped.join(", ")}`);
    if (fetchFailures) c.limitations.push(`${fetchFailures} tentativa(s) de abrir páginas falharam na verificação`);
    const main = canon(c.url_discovered);
    if (main && fetched.has(main)) c.access_status = "content_extracted";

    if (fc.suspicious_instructions_found && main && looksLikeInjection(c.content_excerpt)) {
      veto(it, "V015_PROMPT_INJECTION_OR_UNTRUSTED_INSTRUCTION", "Página principal tenta instruir o sistema", "fact_checker");
    }
    const supporting = it.evidence.filter((e) => e.supports_or_contradicts === "supports");
    if (!supporting.length) {
      veto(it, "V004_SOURCE_INACCESSIBLE", "Nenhuma página de evidência foi efetivamente aberta e confirmada", "fact_checker");
    }

    const evidenceUrls = new Set(it.evidence.map((e) => e.canonical_url));
    const t = classifyTemporal({
      published_at_confirmed: fc.published_at_confirmed,
      updated_at_claimed: fc.updated_at_claimed ?? c.updated_at_claimed,
      substantive_update: fc.substantive_update ? {
        ...fc.substantive_update,
        evidence_ids: it.evidence.filter((e) => e.supports_or_contradicts === "supports").map((e) => e.evidence_id),
        verified_by_fact_checker: fc.status === "verified" || fc.status === "partially_verified",
      } : null,
    }, window, config.future_date_tolerance_minutes);
    it.temporal = t;
    if (t.veto) veto(it, t.veto, `${t.reason}. Base: ${fc.date_basis}`, "temporal_filter");

    switch (fc.status) {
      case "false_or_misleading": veto(it, "V006_FALSE_OR_MISLEADING", fc.reasoning_summary, "fact_checker"); break;
      case "rejected_insufficient_evidence": veto(it, "V005_UNSUPPORTED_CENTRAL_CLAIM", fc.reasoning_summary, "fact_checker"); break;
      case "rejected_irrelevant": veto(it, "V009_LOW_AUDIENCE_RELEVANCE", fc.relevance_note, "fact_checker"); break;
      case "rejected_date": if (!t.veto) veto(it, "V002_DATE_UNVERIFIED", fc.date_basis, "fact_checker"); break;
      case "under_investigation":
        veto(it, fc.unresolved_conflicts.length ? "V007_UNRESOLVED_MATERIAL_CONFLICT" : "V005_UNSUPPORTED_CENTRAL_CLAIM",
          fc.unresolved_conflicts.join("; ") || fc.reasoning_summary, "fact_checker");
        break;
      default: break;
    }
    if (!fc.relevant_to_audience && fc.status !== "rejected_irrelevant") veto(it, "V009_LOW_AUDIENCE_RELEVANCE", fc.relevance_note, "fact_checker");
    for (const cl of fc.central_claims) {
      if (cl.materiality === "low") continue;
      const linked = cl.evidence_urls.some((u) => { const cu = canon(u); return cu != null && evidenceUrls.has(cu); });
      if (cl.status === "contradicted" || cl.status === "unsupported" || !linked) {
        veto(it, "V005_UNSUPPORTED_CENTRAL_CLAIM", `Afirmação central sem sustentação rastreável: "${cl.text}"`, "fact_checker");
        break;
      }
      if (cl.status === "partially_supported") it.caveats.push(`Parcialmente confirmado: ${cl.text}`);
    }
    if (fc.unresolved_conflicts.length && fc.status !== "under_investigation") it.caveats.push(...fc.unresolved_conflicts);
    if (fc.is_regulatory && config.require_primary_source_for_regulatory && !supporting.some((e) => e.source_type === "primary")) {
      veto(it, "V010_REGULATORY_STATUS_UNCLEAR", "Notícia regulatória sem documento oficial aberto", "fact_checker");
    }
    it.independent = independentConfirmations(supporting.map((e) => ({ id: e.evidence_id, provenance_root: e.independence_group })));
    if (!it.vetoes.length) {
      decide({ event_id: it.event_key, candidate_id: c.candidate_id, decision_type: "approve", decision_status: fc.status, rule_id: "6+7",
        evidence_ids: supporting.map((e) => e.evidence_id), reason: `${t.reason}; ${fc.reasoning_summary}`, actor: "fact_checker",
        previous_status: "candidate", new_status: "verified" });
    }
  }

  function dossierOf(it: Item) {
    const fc = it.fc!;
    return {
      event_id: it.event_key, titulo: fc.event_title, data_publicacao: fc.published_at_confirmed,
      categoria_temporal: it.temporal?.category, desenvolvimento_material: fc.substantive_update,
      etapa_regulatoria: fc.regulatory_stage,
      afirmacoes_verificadas: fc.central_claims.filter((c) => c.status === "supported" || c.status === "partially_supported").map((c) => ({ texto: c.text, status: c.status })),
      evidencias: it.evidence.map((e) => ({ url: e.source_url, fonte: e.source_name, tipo: e.source_type, data: e.published_at, trecho: e.evidence_excerpt })),
      confirmacoes_independentes: it.independent, conflitos: fc.unresolved_conflicts, limitacoes: [...fc.limitations, ...it.caveats],
      regiao: it.candidate.region, idioma: it.candidate.language,
    };
  }

  async function editorRun(it: Item, corrections: string[]): Promise<EditorOutput | null> {
    const r = await call({
      agent: "editor", model: config.models.editorial, schema: EditorOutput, effort: "medium",
      prompt: [asData("dossie", dossierOf(it)), asData("analise_critica", it.risk), asData("analise_oportunidades", it.opp),
        asData("estrategia", it.strategy), asData("aderencia_clinup", it.fit), asData("ressalvas_obrigatorias", [...it.fc!.limitations, ...it.caveats]),
        corrections.length ? asData("correcoes_exigidas", corrections) : ""].join("\n\n"),
    }, it.event_key!);
    if (!r?.ok) { it.incomplete = "Redação indisponível"; return null; }
    return r.output;
  }

  function codeAudit(it: Item): { blocking: string[]; missingLinks: boolean } {
    const d = it.draft!;
    const blocking: string[] = [];
    const evidenceUrls = new Set(it.evidence.map((e) => e.canonical_url));
    const badLinks = d.claim_sources.filter((s) => { const cu = canon(s.url); return !cu || !evidenceUrls.has(cu); });
    const missingLinks = d.claim_sources.length === 0 || badLinks.length > 0;
    if (d.claim_sources.length === 0) blocking.push("Texto sem nenhuma afirmação ligada a evidência");
    if (badLinks.length) blocking.push(`Fontes citadas fora dos registros de evidência: ${badLinks.map((b) => b.url).join(", ")}`);
    const pool = [...it.evidence.map((e) => e.evidence_excerpt), ...it.fc!.central_claims.map((c) => c.text), it.fc!.event_title];
    const nums = unsupportedNumbers(`${d.headline}\n${d.what_happened}\n${d.summary}`, pool);
    if (nums.length) blocking.push(`Números sem lastro nas evidências: ${nums.join(", ")}`);
    const sens = sensationalHits(`${d.headline}\n${d.summary}\n${d.why_it_matters}`);
    if (sens.length) blocking.push(`Linguagem sensacionalista: ${sens.join(", ")}`);
    const required = [...it.fc!.limitations, ...it.caveats].filter((x) => x.trim());
    if (required.length && d.caveats.length === 0) blocking.push("Ressalvas materiais foram removidas do texto");
    return { blocking, missingLinks };
  }

  function toPublished(it: Item, band: PublishedNews["priority"]): PublishedNews {
    const d = it.draft!, s = it.strategy!, fc = it.fc!;
    const supporting = it.evidence.filter((e) => e.supports_or_contradicts === "supports");
    const main = supporting.find((e) => e.canonical_url === canon(it.candidate.url_discovered))
      ?? supporting.find((e) => e.source_type === "primary") ?? supporting[0]!;
    const groupsSeen = new Set([main.independence_group]);
    const independents = supporting.filter((e) => {
      if (groupsSeen.has(e.independence_group)) return false;
      groupsSeen.add(e.independence_group); return true;
    });
    return {
      event_id: it.event_key!,
      title: d.headline,
      priority: band,
      score: it.score!.score,
      category: s.category,
      published_at: fc.published_at_confirmed!,
      event_date: fc.substantive_update?.date ?? null,
      temporal_category: it.temporal!.category as PublishedNews["temporal_category"],
      history_status: it.history ?? "UNKNOWN_HISTORY",
      regions: s.regions,
      specialties: s.specialties,
      audience_profiles: s.audience_profiles,
      verification_status: fc.status === "verified" ? "verified" : "partially_verified",
      main_source: { name: main.source_name, url: main.source_url },
      independent_confirmations: independents.map((e) => ({ name: e.source_name, url: e.source_url })),
      what_happened: d.what_happened,
      why_it_matters: d.why_it_matters,
      risks: it.risk!.no_material_risk ? [] : it.risk!.risks.map((r) => `${r.risk} (${r.severity === "high" ? "alta" : r.severity === "medium" ? "média" : "baixa"} gravidade): ${r.mitigation}`),
      opportunities: it.opp!.no_material_opportunity ? [] : it.opp!.opportunities.map((o) => `${o.opportunity}. Primeiro passo: ${o.first_step}`),
      recommended_decision: it.downgraded && s.decision === "act_now" ? "prepare" : s.decision,
      actions: s.actions,
      indicators: s.indicators,
      clinup_fit: { fit: it.fit!.fit, note: it.fit!.justification, cta: it.fit!.cta },
      editorial: { headline: d.headline, summary: d.summary, caveats: d.caveats },
      sources: d.claim_sources.map((cs) => {
        const ev = it.evidence.find((e) => e.canonical_url === canon(cs.url))!;
        return { claim: cs.claim, name: ev.source_name, url: ev.source_url };
      }),
    };
  }

  async function persistRun() {
    await store.writeJson(`${runDir}/context.json`, ctx);
    await store.writeJson(`${runDir}/candidates.json`, items.map((i) => ({
      candidate: i.candidate, event_key: i.event_key ?? null, temporal: i.temporal ?? null, history_status: i.history ?? null,
      vetoes: i.vetoes, incomplete: i.incomplete ?? null, score: i.score ?? null,
    })));
    await store.writeJson(`${runDir}/evidence.json`, items.flatMap((i) => i.evidence));
    await store.writeJson(`${runDir}/verifications.json`, items.filter((i) => i.fc).map((i) => ({ candidate_id: i.candidate.candidate_id, event_key: i.event_key, verification: i.fc })));
    await store.writeJson(`${runDir}/analyses.json`, items.filter((i) => i.strategy).map((i) => ({
      event_key: i.event_key, risk: i.risk, opportunity: i.opp, strategy: i.strategy, clinup_fit: i.fit,
      draft: i.draft ?? null, adversarial: i.adversarial ?? null, audit: i.audit ?? null, caveats: i.caveats,
    })));
    await store.writeJson(`${runDir}/decisions.json`, decisions);
    await store.writeJson(`${runDir}/agent-calls.json`, agentLog);
    if (report) await store.writeJson(`${runDir}/report.json`, report);
  }

  async function updateHistory(rep: PublishedReport) {
    const h = await loadHistory(store);
    const index: HistoryIndex = h.available ? h.index : { schema_version: "1.0.0", updated_at: AT(), events: {} };
    for (const n of rep.news) {
      const prev = index.events[n.event_id];
      index.events[n.event_id] = {
        event_id: n.event_id, canonical_event_key: n.event_id, event_title: n.title,
        first_known_date: prev?.first_known_date ?? n.published_at,
        latest_development_date: n.event_date ?? n.published_at,
        status: "reported", reported_in_runs: [...(prev?.reported_in_runs ?? []), run_id],
      };
    }
    index.updated_at = AT();
    await store.writeJson("history/events.json", index);
  }

  function metrics() {
    const usage = agentLog.reduce((a, l) => ({
      input_tokens: a.input_tokens + l.usage.input_tokens, output_tokens: a.output_tokens + l.usage.output_tokens,
      web_search_requests: a.web_search_requests + l.usage.web_search_requests, web_fetch_requests: a.web_fetch_requests + l.usage.web_fetch_requests,
    }), { input_tokens: 0, output_tokens: 0, web_search_requests: 0, web_fetch_requests: 0 });
    const withDate = items.filter((i) => i.temporal && i.temporal.category !== "date_unverified").length;
    const verified = items.filter((i) => i.fc).length;
    return {
      duration_ms_by_stage: stageTimes,
      queries: allQueries.length,
      candidates: items.length,
      verified,
      pct_candidates_with_verifiable_date: verified ? Math.round((withDate / verified) * 100) : null,
      vetoes: items.reduce((a, i) => a + i.vetoes.length, 0),
      incomplete: items.filter((i) => i.incomplete).length,
      published: report?.news.length ?? 0,
      agent_calls: agentLog.length,
      agent_failures: agentLog.filter((l) => !l.ok).length,
      cost_usd: Math.round(llm.spentUsd() * 100) / 100,
      ...usage,
    };
  }

  function runSummary() {
    return { run_id, request, state: sm.state, transitions: sm.history, gates_missing: sm.gatesMissing(), warnings: sm.warnings, metrics: metrics() };
  }
}

function slug(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

function capBand(b: ScoreResult["band"]): ScoreResult["band"] {
  return b === "maxima" || b === "alta" ? "moderada" : b;
}

/** Aderência CLIN-UP: só serviços do catálogo aprovado; CTA apenas com aderência high/medium (AT-021, AT-022). */
export function enforceFit(fit: FitOutput | null, catalog: Catalog, catalogUsable: boolean): FitOutput {
  const none: FitOutput = {
    fit: "none", service_id: null, problem: "", limits: "", next_step: "", cta: null,
    justification: catalogUsable ? "Sem aderência legítima identificada." : "Catálogo de serviços do CLIN-UP ainda não aprovado; sem CTA comercial.",
  };
  if (!fit || !catalogUsable) return none;
  if (fit.fit === "none") return { ...fit, service_id: null, cta: null };
  if (!fit.service_id || !catalog.services.some((s) => s.id === fit.service_id)) {
    return { ...none, justification: `Serviço citado não existe no catálogo aprovado (${fit.service_id ?? "nenhum"}); aderência descartada.` };
  }
  return fit.fit === "low" ? { ...fit, cta: null } : fit;
}
