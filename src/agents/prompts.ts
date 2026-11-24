import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentId } from "../llm/port.js";

const FILES: Record<AgentId, string> = {
  researcher: "researcher.md",
  fact_checker: "fact-checker.md",
  risk_analyst: "risk-analyst.md",
  opportunity_analyst: "opportunity-analyst.md",
  clinic_strategy_analyst: "clinic-strategy.md",
  clinup_fit_analyst: "clinup-fit.md",
  editor: "editor.md",
  competitive_intelligence_analyst: "competitive-intelligence.md",
  weak_signal_analyst: "weak-signals.md",
  adversarial_reviewer: "adversarial-reviewer.md",
  final_auditor: "final-auditor.md",
  summary: "summary.md",
};

export type PromptSet = Record<AgentId, string>;

export function loadPrompts(dir = "agents"): PromptSet {
  const common = readFileSync(join(dir, "_common.md"), "utf8");
  const out = {} as PromptSet;
  for (const [k, f] of Object.entries(FILES)) out[k as keyof PromptSet] = `${common}\n\n${readFileSync(join(dir, f), "utf8")}`;
  return out;
}

/** Embrulha dados externos para o modelo saber que é conteúdo, não instrução. */
export function asData(label: string, value: unknown): string {
  return `<dados rotulo="${label}">\n${JSON.stringify(value, null, 2)}\n</dados>`;
}
