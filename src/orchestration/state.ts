export const RUN_STATES = [
  "created", "planning", "searching", "normalizing", "deduplicating", "date_filtering",
  "fact_checking", "analyzing", "challenging", "editorial_review", "assembling_report",
  "completed", "completed_with_warnings", "failed", "cancelled",
] as const;
export type RunState = (typeof RUN_STATES)[number];

const PIPELINE: RunState[] = [
  "created", "planning", "searching", "normalizing", "deduplicating", "date_filtering",
  "fact_checking", "analyzing", "challenging", "editorial_review", "assembling_report",
];
const TERMINAL: ReadonlySet<RunState> = new Set(["completed", "completed_with_warnings", "failed", "cancelled"]);

/** Portões obrigatórios: sem eles a execução não pode terminar "completed" (seção 2.4). */
export const MANDATORY_GATES = ["temporal_filter", "fact_check", "final_audit", "report_integrity", "persistence"] as const;
export type Gate = (typeof MANDATORY_GATES)[number];

export class InvalidTransitionError extends Error {}

export class RunStateMachine {
  private _state: RunState = "created";
  readonly history: { from: RunState; to: RunState; at: string }[] = [];
  private readonly gates = new Set<Gate>();
  readonly warnings: string[] = [];

  get state(): RunState { return this._state; }

  passGate(g: Gate) { this.gates.add(g); }
  gatesMissing(): Gate[] { return MANDATORY_GATES.filter((g) => !this.gates.has(g)); }
  warn(msg: string) { this.warnings.push(msg); }

  transition(to: RunState, now = new Date()) {
    const from = this._state;
    if (TERMINAL.has(from)) throw new InvalidTransitionError(`Execução já encerrada em ${from}`);
    let ok = false;
    if (to === "failed" || to === "cancelled") ok = true;
    else if (to === "completed" || to === "completed_with_warnings") {
      if (from !== "assembling_report") throw new InvalidTransitionError(`Não é possível encerrar a partir de ${from}`);
      const missing = this.gatesMissing();
      if (missing.length) throw new InvalidTransitionError(`Portões obrigatórios pendentes: ${missing.join(", ")}`);
      if (to === "completed" && this.warnings.length) {
        throw new InvalidTransitionError("Há avisos registrados: use completed_with_warnings");
      }
      ok = true;
    } else {
      const i = PIPELINE.indexOf(from);
      // avança uma etapa, ou volta de editorial/assembling para editorial_review (correção)
      ok = PIPELINE[i + 1] === to || (to === "editorial_review" && (from === "challenging" || from === "assembling_report"));
    }
    if (!ok) throw new InvalidTransitionError(`Transição inválida: ${from} -> ${to}`);
    this._state = to;
    this.history.push({ from, to, at: now.toISOString() });
  }

  /** Encerra com o estado correto conforme avisos. */
  finish(now = new Date()) {
    this.transition(this.warnings.length ? "completed_with_warnings" : "completed", now);
  }
}
