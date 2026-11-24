export const CRITERIA = {
  management_impact: 25,
  urgency: 20,
  audience_relevance: 20,
  evidence_strength: 15,
  practical_utility: 15,
  strategic_novelty: 5,
} as const;
export type Criterion = keyof typeof CRITERIA;

/** null = não avaliável. Conta como 0: nunca normaliza para cima (seção 8.2). */
export type CriterionScores = Record<Criterion, number | null>;

export interface ScoreResult {
  score: number;
  band: "maxima" | "alta" | "moderada" | "fora_do_principal";
  not_evaluable: Criterion[];
}

export function computeScore(s: CriterionScores): ScoreResult {
  let total = 0;
  const notEvaluable: Criterion[] = [];
  for (const [k, w] of Object.entries(CRITERIA) as [Criterion, number][]) {
    const v = s[k];
    if (v === null) { notEvaluable.push(k); continue; }
    if (!Number.isInteger(v) || v < 0 || v > 5) throw new Error(`Nota inválida para ${k}: ${v}`);
    total += (v / 5) * w;
  }
  const score = Math.round(total * 10) / 10;
  const band = score >= 85 ? "maxima" : score >= 70 ? "alta" : score >= 50 ? "moderada" : "fora_do_principal";
  return { score, band, not_evaluable: notEvaluable };
}
