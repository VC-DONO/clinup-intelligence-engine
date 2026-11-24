/**
 * Verificação de fonte feita por CÓDIGO (sem modelo): abre a página, confere se o trecho citado
 * está nela e lê a data de publicação dos metadados. Roda no GitHub Actions.
 */
export interface PageCheck {
  url: string;
  ok: boolean;
  status: number | null;
  error: string | null;
  fetched_at: string;
  title: string | null;
  content_type: string | null;
  /** true/false para HTML; null quando o formato não permite checar (ex.: PDF). */
  excerpt_found: boolean | null;
  excerpt_match_ratio: number | null;
  published_meta: string | null;
}

const UA = "Mozilla/5.0 (compatible; CLIN-UP-Intelligence/1.0; +https://github.com/VC-DONO/clinup-intelligence-engine)";
const MAX_BYTES = 3_000_000;

export function normalizeText(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim();
}

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** Fração das palavras distintivas do trecho que aparecem na página. */
export function excerptMatch(pageText: string, excerpt: string): { found: boolean; ratio: number } {
  const page = normalizeText(pageText);
  const ex = normalizeText(excerpt);
  if (!ex) return { found: false, ratio: 0 };
  if (page.includes(ex)) return { found: true, ratio: 1 };
  const pageWords = new Set(page.split(" "));
  const words = [...new Set(ex.split(" ").filter((w) => w.length >= 4 || /\d/.test(w)))];
  if (words.length < 3) return { found: false, ratio: 0 };
  const hit = words.filter((w) => pageWords.has(w)).length;
  const ratio = hit / words.length;
  // números do trecho precisam estar todos na página
  const nums = words.filter((w) => /\d/.test(w));
  const numsOk = nums.every((n) => pageWords.has(n));
  return { found: ratio >= 0.75 && numsOk, ratio: Math.round(ratio * 100) / 100 };
}

export function extractPublishedMeta(html: string): string | null {
  const pats = [
    /<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished|date|DC\.date\.issued|publish-date|pubdate)["'][^>]*content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["'](?:article:published_time|datePublished)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
    /<time[^>]+datetime=["']([^"']+)["'][^>]*>/i,
  ];
  for (const p of pats) {
    const m = p.exec(html);
    if (!m?.[1]) continue;
    const v = m[1].trim();
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(v)) return v;
    const d = /^(\d{4}-\d{2}-\d{2})/.exec(v);
    if (d) return d[1]!; // sem fuso: só o dia é confiável
  }
  return null;
}

export async function checkPage(url: string, excerpt: string | null, timeoutMs = 25_000): Promise<PageCheck> {
  const base: PageCheck = { url, ok: false, status: null, error: null, fetched_at: new Date().toISOString(), title: null, content_type: null, excerpt_found: null, excerpt_match_ratio: null, published_meta: null };
  if (!/^https?:\/\//i.test(url)) return { ...base, error: "URL não é http(s)" };
  try {
    const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml,application/pdf;q=0.8,*/*;q=0.5", "accept-language": "pt-BR,pt;q=0.9,en;q=0.8" } });
    const ct = res.headers.get("content-type");
    const out = { ...base, status: res.status, content_type: ct };
    if (!res.ok) return { ...out, error: `HTTP ${res.status}` };
    const buf = new Uint8Array(await res.arrayBuffer()).slice(0, MAX_BYTES);
    if (ct?.includes("pdf")) return { ...out, ok: true, excerpt_found: null };
    const html = new TextDecoder("utf-8").decode(buf);
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim().slice(0, 300) ?? null;
    const m = excerpt ? excerptMatch(htmlToText(html), excerpt) : null;
    return { ...out, ok: true, title, excerpt_found: m ? m.found : null, excerpt_match_ratio: m?.ratio ?? null, published_meta: extractPublishedMeta(html) };
  } catch (e) {
    return { ...base, error: (e as Error).name === "TimeoutError" ? "tempo esgotado" : (e as Error).message.slice(0, 200) };
  }
}
