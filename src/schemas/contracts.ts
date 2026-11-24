import { z } from "zod";
import { VETO_CODES } from "../vetoes/codes.js";

/** Contratos de dados (seção 5). Datas alegadas ficam separadas das confirmadas. */
const iso = z.string().min(1);
const nullableIso = iso.nullable();

export const SCHEMA_VERSION = "1.0.0";

export const AccessStatus = z.enum(["found", "opened", "content_extracted", "failed"]);

export const RunRequest = z.object({
  command: z.string().regex(/^REFRESH( [A-ZÁÉÍÓÚÂÊÔÃÕÇ]+)?$/),
  filters: z.object({
    topics: z.array(z.string()).default([]),
    specialties: z.array(z.string()).default([]),
    regions: z.array(z.string()).default([]),
    languages: z.array(z.string()).default([]),
  }).default({ topics: [], specialties: [], regions: [], languages: [] }),
  report_mode: z.enum(["standard", "executive", "full"]).default("standard"),
  max_main_news: z.number().int().min(0).max(30).default(10),
  compare_history: z.boolean().default(true),
});
export type RunRequest = z.infer<typeof RunRequest>;

export const RunContext = z.object({
  run_id: z.string().uuid(),
  started_at: iso,
  timezone: z.literal("America/Sao_Paulo"),
  window_start: iso,
  window_end: iso,
  freshness_window_hours: z.number().int().positive(),
  config_version: z.string(),
  execution_mode: z.enum(["multi_agent", "sequential_simulation"]),
  available_capabilities: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type RunContext = z.infer<typeof RunContext>;

export const CandidatePublication = z.object({
  candidate_id: z.string(),
  run_id: z.string(),
  title_original: z.string().min(1),
  title_translated: z.string().nullable().optional(),
  url_discovered: z.string().url(),
  canonical_url: z.string().url().nullable().optional(),
  publisher: z.string(),
  publisher_type: z.enum(["official", "news_outlet", "trade_press", "company", "research", "association", "other"]),
  language: z.string(),
  region: z.string(),
  published_at_claimed: nullableIso,
  updated_at_claimed: nullableIso,
  event_date_claimed: nullableIso,
  first_seen_at: iso,
  access_status: AccessStatus,
  content_excerpt: z.string().max(2000),
  search_queries: z.array(z.string()),
  topic_categories: z.array(z.string()),
  relevance_rationale: z.string(),
  provenance_parent_ids: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type CandidatePublication = z.infer<typeof CandidatePublication>;

export const EvidenceRecord = z.object({
  evidence_id: z.string(),
  run_id: z.string(),
  candidate_id: z.string().nullable(),
  event_id: z.string().nullable(),
  claim_id: z.string().nullable(),
  source_url: z.string().url(),
  canonical_url: z.string().url(),
  source_name: z.string(),
  source_type: z.enum(["primary", "secondary", "republication"]),
  accessed_at: iso,
  published_at: nullableIso,
  evidence_excerpt: z.string().max(600),
  document_locator: z.string().nullable(),
  supports_or_contradicts: z.enum(["supports", "contradicts", "context"]),
  independence_group: z.string(),
  reliability_notes: z.string(),
  content_hash: z.string().nullable(),
  access_status: AccessStatus,
});
export type EvidenceRecord = z.infer<typeof EvidenceRecord>;

export const ClaimRecord = z.object({
  claim_id: z.string(),
  event_id: z.string(),
  claim_text: z.string().min(1),
  claim_type: z.enum(["fact", "interpretation", "hypothesis", "recommendation"]),
  evidence_ids: z.array(z.string()),
  status: z.enum(["supported", "partially_supported", "contradicted", "unsupported"]),
  materiality: z.enum(["low", "medium", "high"]),
  qualification_required: z.boolean(),
  notes: z.string(),
});
export type ClaimRecord = z.infer<typeof ClaimRecord>;

export const VerificationStatus = z.enum([
  "verified", "partially_verified", "under_investigation", "false_or_misleading",
  "rejected_date", "rejected_insufficient_evidence", "rejected_irrelevant",
]);

export const VerificationReport = z.object({
  candidate_id: z.string(),
  status: VerificationStatus,
  original_publication_date: nullableIso,
  substantive_update_date: nullableIso,
  date_basis: z.string(),
  is_within_window: z.boolean(),
  event_id: z.string().nullable(),
  central_claims: z.array(z.string()),
  supporting_evidence_ids: z.array(z.string()),
  contradicting_evidence_ids: z.array(z.string()),
  independence_groups: z.array(z.string()),
  unresolved_conflicts: z.array(z.string()),
  limitations: z.array(z.string()),
  publication_conditions: z.array(z.string()),
  veto_codes: z.array(z.enum(VETO_CODES)),
  reasoning_summary: z.string().max(1500),
});
export type VerificationReport = z.infer<typeof VerificationReport>;

export const EventRecord = z.object({
  event_id: z.string(),
  canonical_event_key: z.string(),
  event_title: z.string(),
  event_summary: z.string(),
  first_known_date: iso,
  latest_development_date: iso,
  publication_ids: z.array(z.string()),
  development_ids: z.array(z.string()),
  topic_categories: z.array(z.string()),
  regions_affected: z.array(z.string()),
  specialties_affected: z.array(z.string()),
  status: z.enum(["active", "reported", "monitoring", "closed"]),
  created_at: iso,
  updated_at: iso,
});
export type EventRecord = z.infer<typeof EventRecord>;

export const DecisionRecord = z.object({
  decision_id: z.string(),
  run_id: z.string(),
  event_id: z.string().nullable(),
  candidate_id: z.string().nullable(),
  decision_type: z.enum(["approve", "reject", "veto", "reclassify", "correct", "downgrade"]),
  decision_status: z.string(),
  rule_id: z.string(),
  evidence_ids: z.array(z.string()),
  reason: z.string(),
  actor: z.string(),
  timestamp: iso,
  previous_status: z.string().nullable(),
  new_status: z.string(),
});
export type DecisionRecord = z.infer<typeof DecisionRecord>;

export const HistoryStatus = z.enum(["NEW", "MATERIAL_UPDATE", "ALREADY_REPORTED", "HISTORICAL_CONTEXT", "UNKNOWN_HISTORY"]);
export type HistoryStatus = z.infer<typeof HistoryStatus>;

/** Uma notícia como publicada no endpoint do site (seção 12.2). */
export const PublishedNews = z.object({
  event_id: z.string(),
  title: z.string(),
  priority: z.enum(["maxima", "alta", "moderada"]),
  score: z.number(),
  category: z.string(),
  published_at: iso,
  event_date: nullableIso,
  temporal_category: z.enum(["new_publication", "substantive_new_development"]),
  history_status: HistoryStatus,
  regions: z.array(z.string()),
  specialties: z.array(z.string()),
  audience_profiles: z.array(z.string()),
  verification_status: z.enum(["verified", "partially_verified"]),
  main_source: z.object({ name: z.string(), url: z.string().url() }),
  independent_confirmations: z.array(z.object({ name: z.string(), url: z.string().url() })),
  what_happened: z.string(),
  why_it_matters: z.string(),
  risks: z.array(z.string()),
  opportunities: z.array(z.string()),
  recommended_decision: z.enum(["act_now", "prepare", "monitor", "evaluate_opportunity", "no_immediate_action"]),
  actions: z.array(z.string()),
  indicators: z.array(z.string()),
  clinup_fit: z.object({ fit: z.enum(["high", "medium", "low", "none"]), note: z.string(), cta: z.string().nullable() }),
  editorial: z.object({ headline: z.string(), summary: z.string(), caveats: z.array(z.string()) }),
  sources: z.array(z.object({ claim: z.string(), name: z.string(), url: z.string().url() })).min(1),
});
export type PublishedNews = z.infer<typeof PublishedNews>;

export const PublishedReport = z.object({
  schema_version: z.literal(SCHEMA_VERSION),
  run_id: z.string(),
  run_state: z.enum(["completed", "completed_with_warnings"]),
  generated_at: iso,
  window: z.object({ start: iso, end: iso, hours: z.number(), timezone: z.string() }),
  coverage: z.object({ categories_searched: z.array(z.string()), categories_not_searched: z.array(z.string()), queries: z.number() }),
  limitations: z.array(z.string()),
  executive_summary: z.string(),
  news: z.array(PublishedNews),
  weak_signals: z.array(z.object({ hypothesis: z.string(), confidence: z.enum(["low", "medium", "high"]), signals: z.array(z.string()) })),
  competitive_moves: z.array(z.object({ organization: z.string(), move: z.string(), source_url: z.string().url(), confirmation: z.string() })),
  follow_up: z.array(z.string()),
  exclusions: z.object({ total_candidates: z.number(), by_veto: z.record(z.string(), z.number()) }),
});
export type PublishedReport = z.infer<typeof PublishedReport>;
