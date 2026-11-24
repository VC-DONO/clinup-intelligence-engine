/** Códigos de veto da seção 7.1. Vetos são eliminatórios e independem da pontuação. */
export const VETO_CODES = [
  "V001_OUT_OF_WINDOW",
  "V002_DATE_UNVERIFIED",
  "V003_NO_SUBSTANTIVE_UPDATE",
  "V004_SOURCE_INACCESSIBLE",
  "V005_UNSUPPORTED_CENTRAL_CLAIM",
  "V006_FALSE_OR_MISLEADING",
  "V007_UNRESOLVED_MATERIAL_CONFLICT",
  "V008_DUPLICATE_NO_NEW_DEVELOPMENT",
  "V009_LOW_AUDIENCE_RELEVANCE",
  "V010_REGULATORY_STATUS_UNCLEAR",
  "V011_EDITORIAL_FIDELITY_FAILURE",
  "V012_MISSING_EVIDENCE_LINK",
  "V013_TOOL_EXECUTION_NOT_CONFIRMED",
  "V014_UNSAFE_OR_UNAUTHORIZED_ACTION",
  "V015_PROMPT_INJECTION_OR_UNTRUSTED_INSTRUCTION",
] as const;

export type VetoCode = (typeof VETO_CODES)[number];

/**
 * V007 pode manter o assunto "em apuração" (fora do relatório principal).
 * V011 é corrigível: volta para revisão e só é liberado após nova auditoria.
 * Todos os vetos impedem a entrada no relatório principal enquanto ativos.
 */
export const CORRECTABLE_VETOES: ReadonlySet<VetoCode> = new Set(["V011_EDITORIAL_FIDELITY_FAILURE"]);
export const MONITORABLE_VETOES: ReadonlySet<VetoCode> = new Set(["V007_UNRESOLVED_MATERIAL_CONFLICT"]);

export interface Veto {
  code: VetoCode;
  reason: string;
  evidence_ids: string[];
  actor: string;
  at: string;
}

export function blocksMainReport(vetoes: readonly Veto[]): boolean {
  return vetoes.length > 0;
}
