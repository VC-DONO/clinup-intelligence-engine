import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const ConfigSchema = z
  .object({
    config_version: z.string(),
    timezone: z.literal("America/Sao_Paulo"),
    freshness_window_hours: z.number().int().positive().max(24 * 31),
    max_main_news: z.number().int().min(0).max(30),
    min_main_news: z.number().int().min(0),
    min_score_main_report: z.number().min(0).max(100),
    languages: z.array(z.string()).min(1),
    regions: z.array(z.string()).min(1),
    require_primary_source_for_regulatory: z.boolean(),
    require_editorial_review: z.boolean(),
    enable_competitive_intelligence: z.boolean(),
    enable_weak_signals: z.boolean(),
    publish_to_site_endpoint: z.boolean(),
    publish_to_social_or_email: z.literal(false),
    future_date_tolerance_minutes: z.number().min(0).max(60),
    limits: z.object({
      max_cost_usd_per_run: z.number().positive(),
      max_search_queries_per_run: z.number().int().positive(),
    }),
    models: z.object({
      research: z.string(),
      verification: z.string(),
      analysis: z.string(),
      editorial: z.string(),
    }),
    max_candidates_to_verify: z.number().int().positive().max(100),
    concurrency: z.number().int().min(1).max(10),
  })
  .strict()
  .refine((c) => c.min_main_news <= c.max_main_news, {
    message: "min_main_news não pode exceder max_main_news",
  });

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(path = "config/defaults.yaml"): Config {
  return ConfigSchema.parse(parse(readFileSync(path, "utf8")));
}
