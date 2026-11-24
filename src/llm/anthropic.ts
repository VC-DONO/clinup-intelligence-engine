import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { canonicalizeUrl } from "../deduplication/url.js";
import {
  type AgentRequest, type AgentResult, BudgetExceededError, emptyTrace, emptyUsage, type LlmPort, type ToolTrace, type Usage,
} from "./port.js";

/** US$ por milhão de tokens (tabela oficial em 2026-11). Busca web: US$ 10 por mil buscas. */
const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  "claude-opus-5-5": { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  "claude-sonnet-5-5": { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
};
const WEB_SEARCH_USD = 10 / 1000;
const MAX_CONTINUATIONS = 6;

function safeCanon(u: string): string {
  try { return canonicalizeUrl(u); } catch { return u; }
}

export class AnthropicLlm implements LlmPort {
  private spent = 0;
  private readonly client: Anthropic;

  constructor(private readonly budgetUsd: number, client?: Anthropic) {
    // Credenciais vêm do ambiente (ANTHROPIC_API_KEY). Nunca são logadas nem gravadas.
    this.client = client ?? new Anthropic({ timeout: 15 * 60_000, maxRetries: 3 });
  }

  spentUsd() { return this.spent; }
  capabilities() { return ["web_search", "web_fetch", "structured_outputs", "independent_agent_calls"]; }

  private addUsage(acc: Usage, model: string, u: Anthropic.Beta.BetaUsage) {
    const p = PRICES[model] ?? PRICES["claude-opus-5-5"]!;
    const inTok = u.input_tokens ?? 0, outTok = u.output_tokens ?? 0;
    const cr = u.cache_read_input_tokens ?? 0, cw = u.cache_creation_input_tokens ?? 0;
    const ws = u.server_tool_use?.web_search_requests ?? 0, wf = u.server_tool_use?.web_fetch_requests ?? 0;
    const cost = (inTok * p.in + outTok * p.out + cr * p.cacheRead + cw * p.cacheWrite) / 1e6 + ws * WEB_SEARCH_USD;
    acc.input_tokens += inTok; acc.output_tokens += outTok;
    acc.cache_read_input_tokens += cr; acc.cache_creation_input_tokens += cw;
    acc.web_search_requests += ws; acc.web_fetch_requests += wf;
    acc.cost_usd += cost;
    this.spent += cost;
  }

  private collect(trace: ToolTrace, content: Anthropic.Beta.BetaContentBlock[]) {
    for (const b of content) {
      if (b.type === "server_tool_use" && b.name === "web_search") {
        const q = (b.input as { query?: unknown })?.query;
        if (typeof q === "string") trace.search_queries.push(q);
      } else if (b.type === "web_search_tool_result") {
        if (Array.isArray(b.content)) {
          for (const r of b.content) trace.search_results.push({ url: r.url, title: r.title, page_age: r.page_age ?? null });
        } else trace.search_errors.push(b.content.error_code);
      } else if (b.type === "web_fetch_tool_result") {
        const c = b.content;
        if (c.type === "web_fetch_result") {
          const title = (c.content as { title?: string | null }).title ?? null;
          trace.fetched.set(safeCanon(c.url), { retrieved_at: c.retrieved_at ?? null, title });
        } else trace.fetch_failures.push({ url: null, error: c.error_code });
      }
    }
  }

  async run<T>(req: AgentRequest<T>): Promise<AgentResult<T>> {
    const trace = emptyTrace();
    const usage = emptyUsage();
    if (this.spent >= this.budgetUsd) {
      throw new BudgetExceededError(`Teto de US$ ${this.budgetUsd} atingido antes de ${req.agent}`);
    }
    const tools: Anthropic.Beta.BetaToolUnion[] = [];
    if (req.web?.search) tools.push({ type: "web_search_20260209", name: "web_search", max_uses: req.web.search });
    if (req.web?.fetch) tools.push({ type: "web_fetch_20260209", name: "web_fetch", max_uses: req.web.fetch, max_content_tokens: 12000 });

    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: req.prompt }];
    try {
      for (let i = 0; i <= MAX_CONTINUATIONS; i++) {
        const res = await this.client.beta.messages.parse({
          model: req.model,
          max_tokens: 32000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages,
          ...(tools.length ? { tools } : {}),
          output_config: { effort: req.effort, format: betaZodOutputFormat(req.schema as never) },
        });
        this.addUsage(usage, req.model, res.usage);
        this.collect(trace, res.content);
        if (res.stop_reason === "pause_turn") {
          messages.push({ role: "assistant", content: res.content });
          continue;
        }
        if (res.stop_reason === "refusal") {
          return { ok: false, error: `Recusa do modelo (${res.stop_details?.category ?? "sem categoria"})`, trace, usage };
        }
        if (res.stop_reason === "max_tokens") return { ok: false, error: "Resposta truncada (max_tokens)", trace, usage };
        const parsed = res.parsed_output as T | null;
        if (parsed == null) return { ok: false, error: "Saída estruturada ausente ou inválida", trace, usage };
        const check = req.schema.safeParse(parsed);
        if (!check.success) return { ok: false, error: `Saída fora do contrato: ${check.error.message.slice(0, 300)}`, trace, usage };
        return { ok: true, output: check.data, trace, usage, model_used: res.model };
      }
      return { ok: false, error: "Excesso de continuações (pause_turn)", trace, usage };
    } catch (e) {
      if (e instanceof BudgetExceededError) throw e;
      if (e instanceof Anthropic.AuthenticationError) throw new Error("ANTHROPIC_API_KEY ausente ou inválida");
      const msg = e instanceof Anthropic.APIError ? `API ${e.status}: ${e.message}` : (e as Error).message;
      return { ok: false, error: msg.slice(0, 400), trace, usage };
    }
  }
}
