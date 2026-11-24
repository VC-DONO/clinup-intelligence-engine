/** Heurísticas determinísticas de segurança e fidelidade editorial. */

const INJECTION_PATTERNS = [
  /ignore (all |the )?(previous|prior|above) (instructions|rules)/i,
  /ignore (as |todas as )?(instru[cç][õo]es|regras) (anteriores|acima)/i,
  /you are now|a partir de agora voc[eê] [eé]/i,
  /system prompt|prompt do sistema/i,
  /(reveal|print|mostre|revele).{0,30}(api[_ ]?key|secret|token|vari[aá]veis de ambiente|environment variables)/i,
  /(approve|aprove|publique|publish) (this|esta|essa) (news|not[ií]cia|article|mat[eé]ria)/i,
  /(disregard|desconsidere).{0,20}(veto|rules|regras|janela|window)/i,
];

export function looksLikeInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((r) => r.test(text));
}

const SENSATIONAL = [
  /vai destruir/i, /garant(e|ido|ia) (o )?lucro/i, /obriga todas as cl[ií]nicas/i, /\bbomba\b/i, /urgent[ií]ssimo/i,
  /!!+/, /\bcat[aá]strof/i, /\bfim d[aeo]s? (cl[ií]nicas|consult[oó]rios)/i, /ningu[eé]m (te )?contou/i, /chocante/i,
];

export function sensationalHits(text: string): string[] {
  return SENSATIONAL.filter((r) => r.test(text)).map((r) => r.source);
}

/** Números relevantes do texto (percentuais, valores, quantidades com 2+ dígitos, anos excluídos). */
export function extractNumbers(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/\d+(?:[.,]\d+)*/g)) {
    const raw = m[0];
    const norm = raw.replace(/[.,](?=\d{3}\b)/g, "").replace(",", ".");
    const n = Number(norm);
    if (!Number.isFinite(n)) continue;
    if (raw.length < 2) continue; // dígitos isolados ("3 passos") não são checados
    if (/^(19|20)\d{2}$/.test(raw)) continue; // anos
    out.add(norm);
  }
  return [...out];
}

/**
 * AT-019: todo número do texto editorial precisa aparecer em alguma evidência ou afirmação verificada.
 * Retorna os números sem lastro.
 */
export function unsupportedNumbers(editorialText: string, evidenceTexts: string[]): string[] {
  const pool = new Set(evidenceTexts.flatMap(extractNumbers));
  return extractNumbers(editorialText).filter((n) => !pool.has(n));
}
