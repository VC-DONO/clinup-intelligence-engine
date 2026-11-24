import { mkdtemp, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config/config.js";
import { canonicalizeUrl, dedupe, independentConfirmations } from "../../src/deduplication/url.js";
import { InvalidTransitionError, MANDATORY_GATES, RunStateMachine } from "../../src/orchestration/state.js";
import { FileStore, historyStatusFor, loadHistory } from "../../src/persistence/store.js";
import { computeScore } from "../../src/scoring/score.js";

describe("configuração", () => {
  it("defaults.yaml valida e nunca permite publicar em redes/e-mail", () => {
    const c = loadConfig();
    expect(c.timezone).toBe("America/Sao_Paulo");
    expect(c.publish_to_social_or_email).toBe(false);
  });
});

describe("estados da execução (seção 2.4)", () => {
  const advance = (m: RunStateMachine) => {
    for (const s of ["planning", "searching", "normalizing", "deduplicating", "date_filtering", "fact_checking",
      "analyzing", "challenging", "editorial_review", "assembling_report"] as const) m.transition(s);
  };
  it("recusa pular etapas", () => {
    const m = new RunStateMachine();
    expect(() => m.transition("fact_checking")).toThrow(InvalidTransitionError);
  });
  it("não conclui sem os portões obrigatórios", () => {
    const m = new RunStateMachine();
    advance(m);
    expect(() => m.transition("completed")).toThrow(/Portões/);
  });
  it("conclui com warnings quando há aviso; completed é recusado", () => {
    const m = new RunStateMachine();
    advance(m);
    MANDATORY_GATES.forEach((g) => m.passGate(g));
    m.warn("busca internacional indisponível");
    expect(() => m.transition("completed")).toThrow();
    m.finish();
    expect(m.state).toBe("completed_with_warnings");
  });
  it("estado terminal não muda", () => {
    const m = new RunStateMachine();
    m.transition("failed");
    expect(() => m.transition("planning")).toThrow();
  });
});

describe("pontuação (seção 8)", () => {
  it("nota máxima em tudo = 100", () => {
    expect(computeScore({ management_impact: 5, urgency: 5, audience_relevance: 5, evidence_strength: 5, practical_utility: 5, strategic_novelty: 5 }).score).toBe(100);
  });
  it("não avaliável conta zero, sem normalizar para cima", () => {
    const r = computeScore({ management_impact: 5, urgency: null, audience_relevance: 5, evidence_strength: 5, practical_utility: 5, strategic_novelty: 5 });
    expect(r.score).toBe(80);
    expect(r.not_evaluable).toEqual(["urgency"]);
    expect(r.band).toBe("alta");
  });
  it("rejeita nota fora de 0..5", () => {
    expect(() => computeScore({ management_impact: 6, urgency: 0, audience_relevance: 0, evidence_strength: 0, practical_utility: 0, strategic_novelty: 0 })).toThrow();
  });
});

describe("deduplicação e proveniência", () => {
  it("normaliza URL canônica", () => {
    expect(canonicalizeUrl("http://www.Exemplo.com.br/noticia/?utm_source=x&id=2#top")).toBe("https://exemplo.com.br/noticia?id=2");
  });
  it("AT-009 cinco republicações da mesma origem contam como uma confirmação", () => {
    const srcs = [1, 2, 3, 4, 5].map((i) => ({ id: `r${i}`, provenance_root: "agencia-x" }));
    expect(independentConfirmations(srcs)).toBe(1);
    expect(independentConfirmations([...srcs, { id: "apuracao-propria" }])).toBe(2);
  });
  it("marca duplicata certa e só sugere mesmo evento para títulos parecidos", () => {
    const links = dedupe([
      { id: "a", url: "https://site.com/a?utm_x=1", title: "ANS publica nova regra de reajuste para planos" },
      { id: "b", url: "https://www.site.com/a", title: "qualquer" },
      { id: "c", url: "https://outro.com/z", title: "ANS publica nova regra de reajuste de planos" },
      { id: "d", url: "https://outro.com/y", title: "CFM muda regra de publicidade médica" },
    ]);
    expect(links.find((l) => l.id === "b")?.duplicate_of).toBe("a");
    expect(links.find((l) => l.id === "c")?.possible_same_event_as).toBe("a");
    expect(links.find((l) => l.id === "c")?.duplicate_of).toBeUndefined();
    expect(links.find((l) => l.id === "d")).toEqual({ id: "d" });
  });
});

describe("persistência e histórico", () => {
  it("histórico sobrevive a nova instância (reinício)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clinup-"));
    await new FileStore(dir).writeJson("history/events.json", {
      schema_version: "1.0.0", updated_at: "x",
      events: { "ans-reajuste": { event_id: "e1", canonical_event_key: "ans-reajuste", event_title: "t", first_known_date: "x", latest_development_date: "x", status: "reported", reported_in_runs: ["r1"] } },
    });
    const h = await loadHistory(new FileStore(dir));
    expect(historyStatusFor(h, "ans-reajuste", false)).toBe("ALREADY_REPORTED");
    expect(historyStatusFor(h, "ans-reajuste", true)).toBe("MATERIAL_UPDATE");
    expect(historyStatusFor(h, "outro", false)).toBe("NEW");
  });
  it("AT-026 histórico ilegível vira UNKNOWN_HISTORY, nunca NEW", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clinup-"));
    await mkdir(join(dir, "history"));
    await writeFile(join(dir, "history/events.json"), "{corrompido");
    const h = await loadHistory(new FileStore(dir));
    expect(h.available).toBe(false);
    expect(historyStatusFor(h, "qualquer", false)).toBe("UNKNOWN_HISTORY");
  });
  it("AT-027 falha de gravação é reportada, não engolida", async () => {
    if (process.getuid?.() === 0) return; // root ignora permissões
    const dir = await mkdtemp(join(tmpdir(), "clinup-"));
    await chmod(dir, 0o500);
    await expect(new FileStore(dir).writeJson("x/y.json", {})).rejects.toThrow();
  });
});
