import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalizeUrl } from "../deduplication/url.js";
import { type AgentRequest, type AgentResult, emptyTrace, emptyUsage, type LlmPort, type ToolTrace } from "./port.js";
import type { PageCheck } from "../verification/fetch-check.js";

/**
 * Modo sessão (custo zero de API): o código continua sendo o orquestrador, mas as respostas dos agentes
 * vêm de arquivos escritos por uma sessão do Claude agendada.
 *
 * - collect: falta resposta → vira tarefa em tasks.json e a execução para em "awaiting_input".
 * - verify: usado no GitHub Actions. Nenhuma tarefa pode faltar, e as fontes citadas pelo verificador
 *   só contam como lidas se o próprio código abrir a página e encontrar o trecho citado.
 */
export interface PendingTask {
  id: string;
  agent: string;
  subject: string;
  output_file: string;
  needs_web: boolean;
  system_prompt_files: string[];
  prompt: string;
  output_json_schema: unknown;
}

const PROMPT_FILE: Record<string, string> = {
  researcher: "researcher.md", fact_checker: "fact-checker.md", risk_analyst: "risk-analyst.md",
  opportunity_analyst: "opportunity-analyst.md", clinic_strategy_analyst: "clinic-strategy.md", clinup_fit_analyst: "clinup-fit.md",
  editor: "editor.md", competitive_intelligence_analyst: "competitive-intelligence.md", weak_signal_analyst: "weak-signals.md",
  adversarial_reviewer: "adversarial-reviewer.md", final_auditor: "final-auditor.md", summary: "summary.md",
};

export function subjectFile(agent: string, subject: string): string {
  const safe = subject.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9#._-]+/g, "_").slice(0, 150);
  return join("outputs", agent, `${safe}.json`);
}

export type PageChecker = (url: string, excerpt: string | null) => Promise<PageCheck>;

export class ReplayLlm implements LlmPort {
  readonly pending: PendingTask[] = [];
  readonly checks: (PageCheck & { agent: string; subject: string })[] = [];
  /** Hash da entrada que cada resposta recebeu. Se a entrada mudar no Actions, a resposta não vale mais. */
  private readonly hashes: Record<string, string> = {};
  private readonly expected: Record<string, string> = {};

  constructor(private readonly inbox: string, private readonly mode: "collect" | "verify", private readonly checker?: PageChecker) {
    if (mode === "verify" && !checker) throw new Error("Modo verify exige verificador de páginas");
    if (mode === "verify") {
      const f = join(inbox, "input-hashes.json");
      if (existsSync(f)) Object.assign(this.expected, JSON.parse(readFileSync(f, "utf8")));
    }
  }

  spentUsd() { return 0; }
  pendingCount() { return this.mode === "collect" ? this.pending.length : 0; }
  capabilities() {
    return this.mode === "verify"
      ? ["agent_outputs_from_scheduled_session", "independent_page_fetch_by_code", "excerpt_match_by_code"]
      : ["agent_outputs_from_scheduled_session", "provisional_no_fetch_check"];
  }

  async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    const trace = emptyTrace(), usage = emptyUsage();
    const rel = subjectFile(req.agent, req.subject);
    const path = join(this.inbox, rel);
    if (!existsSync(path)) {
      if (this.mode === "collect") {
        if (!this.pending.some((p) => p.output_file === rel)) {
          this.pending.push({
            id: `${req.agent}:${req.subject}`, agent: req.agent, subject: req.subject, output_file: rel,
            needs_web: Boolean(req.web?.search || req.web?.fetch),
            system_prompt_files: ["agents/_common.md", `agents/${PROMPT_FILE[req.agent]}`],
            prompt: req.prompt,
            output_json_schema: z.toJSONSchema(req.schema),
          });
        }
        return { ok: false, error: "PENDING", trace, usage };
      }
      return { ok: false, error: `Resposta do agente ausente (${rel})`, trace, usage };
    }
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf8")); }
    catch (e) { return { ok: false, error: `JSON inválido em ${rel}: ${(e as Error).message}`, trace, usage }; }
    const sha = createHash("sha256").update(req.prompt).digest("hex");
    if (this.mode === "collect") this.hashes[rel] = sha;
    else if (this.expected[rel] !== sha) {
      return { ok: false, error: `Entrada de ${rel} mudou após a checagem de fontes; resposta descartada`, trace, usage };
    }
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: `Saída fora do contrato em ${rel}: ${parsed.error.message.slice(0, 300)}`, trace, usage };

    if (req.agent === "fact_checker") await this.traceFactCheck(req.subject, parsed.data as { evidence: { url: string; excerpt: string }[] }, trace, req.agent);
    return { ok: true, output: parsed.data, trace, usage, model_used: "scheduled-session" };
  }

  private async traceFactCheck(mainUrl: string, out: { evidence: { url: string; excerpt: string }[] }, trace: ToolTrace, agent: string) {
    const targets = new Map<string, string | null>();
    targets.set(mainUrl, null);
    for (const e of out.evidence) targets.set(e.url, e.excerpt);
    for (const [url, excerpt] of targets) {
      let cu: string;
      try { cu = canonicalizeUrl(url); } catch { continue; }
      if (this.mode === "collect") {
        // Provisório: a checagem real acontece no GitHub Actions. Nada é publicado neste modo.
        trace.fetched.set(cu, { retrieved_at: null, title: null, published_meta: null });
        continue;
      }
      const chk = await this.checker!(url, excerpt);
      this.checks.push({ ...chk, agent, subject: mainUrl });
      if (chk.ok && (excerpt === null || chk.excerpt_found !== false)) {
        trace.fetched.set(cu, { retrieved_at: chk.fetched_at, title: chk.title, published_meta: chk.published_meta });
      } else {
        trace.fetch_failures.push({ url, error: chk.ok ? "trecho citado não encontrado na página" : chk.error ?? "falha ao abrir" });
      }
    }
  }

  writeHashes() {
    writeFileSync(join(this.inbox, "input-hashes.json"), JSON.stringify(this.hashes, null, 2) + "\n");
  }

  writeTasks(): string {
    mkdirSync(this.inbox, { recursive: true });
    const file = join(this.inbox, "tasks.json");
    writeFileSync(file, JSON.stringify({ generated_at: new Date().toISOString(), tasks: this.pending }, null, 2) + "\n");
    return file;
  }
}
