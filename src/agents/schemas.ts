import { z } from "zod";

/**
 * Esquemas das saídas dos agentes (o que o modelo devolve).
 * São simples de propósito (compatíveis com saída estruturada). O código valida as regras depois.
 */
const nstr = z.string().nullable();
const Materiality = z.enum(["low", "medium", "high"]);

export const ResearchOutput = z.object({
  candidates: z.array(z.object({
    title: z.string(),
    url: z.string(),
    publisher: z.string(),
    publisher_type: z.enum(["official", "news_outlet", "trade_press", "company", "research", "association", "other"]),
    language: z.string(),
    region: z.string(),
    published_at_claimed: nstr,
    updated_at_claimed: nstr,
    summary: z.string(),
    topic_categories: z.array(z.string()),
    relevance_rationale: z.string(),
    republication_of_url: nstr,
  })),
  coverage_gaps: z.array(z.string()),
});
export type ResearchOutput = z.infer<typeof ResearchOutput>;

export const FactCheckOutput = z.object({
  status: z.enum(["verified", "partially_verified", "under_investigation", "false_or_misleading",
    "rejected_date", "rejected_insufficient_evidence", "rejected_irrelevant"]),
  published_at_confirmed: nstr,
  date_basis: z.string(),
  updated_at_claimed: nstr,
  substantive_update: z.object({
    date: z.string(), previous_content: z.string(), new_fact: z.string(), why_it_matters: z.string(),
  }).nullable(),
  event_title: z.string(),
  canonical_event_key: z.string(),
  official_document_id: nstr,
  regulatory_stage: nstr,
  is_regulatory: z.boolean(),
  central_claims: z.array(z.object({
    text: z.string(),
    materiality: Materiality,
    status: z.enum(["supported", "partially_supported", "contradicted", "unsupported"]),
    evidence_urls: z.array(z.string()),
  })),
  evidence: z.array(z.object({
    url: z.string(),
    source_name: z.string(),
    source_type: z.enum(["primary", "secondary", "republication"]),
    published_at: nstr,
    excerpt: z.string(),
    locator: nstr,
    supports_or_contradicts: z.enum(["supports", "contradicts", "context"]),
    independence_group: z.string(),
  })),
  unresolved_conflicts: z.array(z.string()),
  limitations: z.array(z.string()),
  relevant_to_audience: z.boolean(),
  relevance_note: z.string(),
  suspicious_instructions_found: z.boolean(),
  reasoning_summary: z.string(),
});
export type FactCheckOutput = z.infer<typeof FactCheckOutput>;

export const RiskOutput = z.object({
  no_material_risk: z.boolean(),
  risks: z.array(z.object({
    risk: z.string(), supporting_fact: z.string(), mechanism: z.string(), conditions: z.string(),
    exposed_profiles: z.array(z.string()), severity: z.enum(["low", "medium", "high"]), mitigation: z.string(),
  })),
  cannot_conclude: z.array(z.string()),
});
export type RiskOutput = z.infer<typeof RiskOutput>;

export const OpportunityOutput = z.object({
  no_material_opportunity: z.boolean(),
  opportunities: z.array(z.object({
    opportunity: z.string(), evidence: z.string(), beneficiaries: z.array(z.string()), capture_conditions: z.string(),
    first_step: z.string(), metric: z.string(), horizon: z.string(),
  })),
  cannot_conclude: z.array(z.string()),
});
export type OpportunityOutput = z.infer<typeof OpportunityOutput>;

const Score = z.number().int().nullable();
export const StrategyOutput = z.object({
  category: z.string(),
  management_areas: z.array(z.string()),
  audience_profiles: z.array(z.string()),
  specialties: z.array(z.string()),
  regions: z.array(z.string()),
  decision: z.enum(["act_now", "prepare", "monitor", "evaluate_opportunity", "no_immediate_action"]),
  justification: z.string(),
  actions: z.array(z.string()),
  indicators: z.array(z.string()),
  data_needed: z.array(z.string()),
  assumptions: z.array(z.string()),
  uncertainty: z.enum(["low", "medium", "high"]),
  scores: z.object({
    management_impact: Score, urgency: Score, audience_relevance: Score,
    evidence_strength: Score, practical_utility: Score, strategic_novelty: Score,
  }),
});
export type StrategyOutput = z.infer<typeof StrategyOutput>;

export const FitOutput = z.object({
  fit: z.enum(["high", "medium", "low", "none"]),
  service_id: nstr,
  problem: z.string(),
  limits: z.string(),
  next_step: z.string(),
  cta: nstr,
  justification: z.string(),
});
export type FitOutput = z.infer<typeof FitOutput>;

export const EditorOutput = z.object({
  headline: z.string(),
  what_happened: z.string(),
  why_it_matters: z.string(),
  summary: z.string(),
  caveats: z.array(z.string()),
  claim_sources: z.array(z.object({ claim: z.string(), url: z.string() })),
});
export type EditorOutput = z.infer<typeof EditorOutput>;

export const AdversarialOutput = z.object({
  decision: z.enum(["keep", "correct", "downgrade", "state_uncertainty", "block"]),
  problems: z.array(z.string()),
  contrary_evidence: z.array(z.string()),
  fragile_assumptions: z.array(z.string()),
  required_corrections: z.array(z.string()),
  violated_rule: nstr,
});
export type AdversarialOutput = z.infer<typeof AdversarialOutput>;

export const AuditOutput = z.object({
  result: z.enum(["pass", "pass_with_warnings", "fail"]),
  unsupported_claims: z.array(z.string()),
  mismatched_dates_or_numbers: z.array(z.string()),
  omitted_caveats: z.array(z.string()),
  sensational_language: z.array(z.string()),
  required_corrections: z.array(z.string()),
  justification: z.string(),
});
export type AuditOutput = z.infer<typeof AuditOutput>;

export const CompetitiveOutput = z.object({
  signals: z.array(z.object({
    organization: z.string(), move: z.string(), source_url: z.string(), event_id: z.string(),
    competition: z.enum(["direct", "adjacent", "trend"]), confirmation: z.string(), implication: z.string(),
  })),
});
export type CompetitiveOutput = z.infer<typeof CompetitiveOutput>;

export const WeakSignalOutput = z.object({
  material_signal_found: z.boolean(),
  hypotheses: z.array(z.object({
    hypothesis: z.string(), component_event_ids: z.array(z.string()), contrary_evidence: z.array(z.string()),
    alternative_explanations: z.array(z.string()), confidence: z.enum(["low", "medium", "high"]),
    indicators_to_monitor: z.array(z.string()), invalidating_conditions: z.array(z.string()),
  })),
});
export type WeakSignalOutput = z.infer<typeof WeakSignalOutput>;

export const SummaryOutput = z.object({
  executive_summary: z.string(),
  follow_up: z.array(z.string()),
});
export type SummaryOutput = z.infer<typeof SummaryOutput>;
