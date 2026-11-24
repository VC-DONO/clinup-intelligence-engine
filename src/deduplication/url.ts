const TRACKING = /^(utm_|fbclid$|gclid$|mc_|igshid$|ref$|ref_src$|amp$|_ga$|cmpid$|xtor$)/i;

/** URL canônica normalizada: https, sem www, sem fragmento, sem parâmetros de rastreio, sem barra final. */
export function canonicalizeUrl(raw: string): string {
  const u = new URL(raw.trim());
  u.hash = "";
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "").replace(/^amp\./, "");
  if ((u.port === "443") || (u.port === "80")) u.port = "";
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  u.pathname = u.pathname.replace(/\/amp\/?$/, "/").replace(/\/+$/, "") || "/";
  return u.toString();
}

function normTitle(t: string): string[] {
  return t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2);
}

/** Similaridade de Jaccard entre títulos (camada 3 da deduplicação). */
export function titleSimilarity(a: string, b: string): number {
  const A = new Set(normTitle(a)), B = new Set(normTitle(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

export interface DedupItem { id: string; url: string; title: string; official_id?: string | null; provenance_root?: string | null }
export interface DedupLink { id: string; duplicate_of?: string; possible_same_event_as?: string }

/**
 * Duplicatas certas (mesma URL canônica ou mesmo identificador oficial) são marcadas duplicate_of.
 * Títulos parecidos só geram "possible_same_event_as": nunca fundimos automaticamente (seção 10.4).
 */
export function dedupe(items: DedupItem[], threshold = 0.6): DedupLink[] {
  const byUrl = new Map<string, string>();
  const byOfficial = new Map<string, string>();
  const out: DedupLink[] = [];
  const kept: DedupItem[] = [];
  for (const it of items) {
    let canon: string;
    try { canon = canonicalizeUrl(it.url); } catch { canon = it.url; }
    const dupUrl = byUrl.get(canon);
    const dupOff = it.official_id ? byOfficial.get(it.official_id) : undefined;
    if (dupUrl || dupOff) { out.push({ id: it.id, duplicate_of: (dupUrl ?? dupOff)! }); continue; }
    byUrl.set(canon, it.id);
    if (it.official_id) byOfficial.set(it.official_id, it.id);
    const similar = kept.find((k) => titleSimilarity(k.title, it.title) >= threshold);
    out.push(similar ? { id: it.id, possible_same_event_as: similar.id } : { id: it.id });
    kept.push(it);
  }
  return out;
}

/**
 * Conta confirmações independentes por grupo de proveniência:
 * cinco republicações da mesma origem valem uma (AT-009).
 */
export function independentConfirmations(sources: { id: string; provenance_root?: string | null }[]): number {
  return new Set(sources.map((s) => s.provenance_root || s.id)).size;
}
