import type { z } from "zod";

export type AgentId =
  | "researcher" | "fact_checker" | "risk_analyst" | "opportunity_analyst" | "clinic_strategy_analyst"
  | "clinup_fit_analyst" | "editor" | "competitive_intelligence_analyst" | "weak_signal_analyst"
  | "adversarial_reviewer" | "final_auditor" | "summary";

export type Effort = "low" | "medium" | "high";

export interface AgentRequest<T> {
  agent: AgentId;
  /** Identificador estável do assunto (grupo, URL canônica ou event_key). Usado para replay e auditoria. */
  subject: string;
  model: string;
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  effort: Effort;
  web?: { search: number; fetch: number };
}

/** O que a ferramenta realmente fez: base para "busca encontrada não significa página lida". */
export interface ToolTrace {
  /** URLs abertas com sucesso pelo web_fetch nesta chamada, normalizadas. */
  fetched: Map<string, { retrieved_at: string | null; title: string | null; published_meta?: string | null }>;
  fetch_failures: { url: string | null; error: string }[];
  search_queries: string[];
  search_results: { url: string; title: string; page_age: string | null }[];
  search_errors: string[];
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  web_search_requests: number;
  web_fetch_requests: number;
  cost_usd: number;
}

export type AgentResult<T> =
  | { ok: true; output: T; trace: ToolTrace; usage: Usage; model_used: string }
  | { ok: false; error: string; trace: ToolTrace; usage: Usage };

export interface LlmPort {
  run<T>(req: AgentRequest<T>): Promise<AgentResult<T>>;
  /** Custo acumulado nesta execução. */
  spentUsd(): number;
  capabilities(): string[];
  /** Modo sessão: tarefas que ainda aguardam resposta de um agente. */
  pendingCount?(): number;
}

/** A execução parou porque há tarefas de agente aguardando resposta (modo sessão). */
export class AwaitingInputError extends Error {}

export class BudgetExceededError extends Error {}

export function emptyTrace(): ToolTrace {
  return { fetched: new Map(), fetch_failures: [], search_queries: [], search_results: [], search_errors: [] };
}
export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, web_search_requests: 0, web_fetch_requests: 0, cost_usd: 0 };
}
