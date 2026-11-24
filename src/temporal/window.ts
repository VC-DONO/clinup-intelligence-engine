import type { VetoCode } from "../vetoes/codes.js";

export const TIMEZONE = "America/Sao_Paulo";
const HOUR_MS = 3_600_000;

export interface TimeWindow {
  /** T0: fixado no início da execução, nunca muda. */
  windowEnd: Date;
  windowStart: Date;
  hours: number;
}

export function computeWindow(t0: Date, hours: number): TimeWindow {
  if (!Number.isFinite(t0.getTime())) throw new Error("T0 inválido");
  if (!(hours > 0)) throw new Error("janela deve ser positiva");
  return Object.freeze({
    windowEnd: new Date(t0.getTime()),
    windowStart: new Date(t0.getTime() - hours * HOUR_MS),
    hours,
  });
}

/** Instante exato ou apenas o dia (quando a fonte só mostra a data). */
export type ParsedDate =
  | { precision: "instant"; at: Date }
  | { precision: "day"; dayStart: Date; dayEnd: Date };

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Deslocamento (ms) de America/Sao_Paulo em relação a UTC num dado instante. */
function saoPauloOffsetMs(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Meia-noite de um dia civil em São Paulo, como instante UTC. */
function saoPauloMidnight(y: number, m: number, d: number): Date {
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - saoPauloOffsetMs(guess));
}

/**
 * Normaliza uma data alegada. Exige ISO-8601 com fuso (instante) ou AAAA-MM-DD (dia em São Paulo).
 * Qualquer outro formato é tratado como não verificável: não adivinhamos.
 */
export function parseClaimedDate(raw: string | null | undefined): ParsedDate | null {
  if (!raw) return null;
  const s = raw.trim();
  if (ISO_INSTANT.test(s)) {
    const at = new Date(s);
    return Number.isFinite(at.getTime()) ? { precision: "instant", at } : null;
  }
  const m = ISO_DAY.exec(s);
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const check = new Date(Date.UTC(y, mo - 1, d));
    if (check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
    const dayStart = saoPauloMidnight(y, mo, d);
    const next = new Date(Date.UTC(y, mo - 1, d + 1));
    const dayEnd = new Date(
      saoPauloMidnight(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate()).getTime() - 1,
    );
    return { precision: "day", dayStart, dayEnd };
  }
  return null;
}

export type TemporalCategory =
  | "new_publication"
  | "substantive_new_development"
  | "historical_context"
  | "out_of_window"
  | "date_unverified"
  | "future_or_invalid_date";

export interface SubstantiveUpdateClaim {
  /** Data em que o fato novo foi divulgado ou ocorreu. */
  date: string;
  previous_content: string;
  new_fact: string;
  why_it_matters: string;
  evidence_ids: string[];
  verified_by_fact_checker: boolean;
}

export interface TemporalInput {
  published_at_confirmed: string | null;
  updated_at_claimed?: string | null;
  substantive_update?: SubstantiveUpdateClaim | null;
}

export interface TemporalResult {
  category: TemporalCategory;
  eligible: boolean;
  veto: VetoCode | null;
  reason: string;
}

type Position = "inside" | "before" | "after" | "ambiguous";

function position(d: ParsedDate, w: TimeWindow, toleranceMs: number): Position {
  const start = w.windowStart.getTime();
  const end = w.windowEnd.getTime();
  if (d.precision === "instant") {
    const t = d.at.getTime();
    if (t > end + toleranceMs) return "after";
    if (t < start) return "before";
    return "inside"; // fronteira inclusiva: window_start <= t <= T0
  }
  const ds = d.dayStart.getTime();
  const de = d.dayEnd.getTime();
  if (ds > end + toleranceMs) return "after";
  if (de < start) return "before";
  if (ds >= start) return "inside";
  return "ambiguous"; // o dia cruza window_start e não sabemos a hora
}

export function classifyTemporal(input: TemporalInput, w: TimeWindow, toleranceMinutes = 0): TemporalResult {
  const tol = toleranceMinutes * 60_000;
  const published = parseClaimedDate(input.published_at_confirmed);
  if (!published) {
    return {
      category: "date_unverified",
      eligible: false,
      veto: "V002_DATE_UNVERIFIED",
      reason: input.published_at_confirmed
        ? `Data em formato não verificável: "${input.published_at_confirmed}"`
        : "Sem data de publicação confirmada",
    };
  }
  const pos = position(published, w, tol);
  if (pos === "after") {
    return {
      category: "future_or_invalid_date",
      eligible: false,
      veto: "V002_DATE_UNVERIFIED",
      reason: "Data de publicação posterior a T0: inconsistência bloqueada até esclarecimento",
    };
  }
  if (pos === "inside") {
    return { category: "new_publication", eligible: true, veto: null, reason: "Publicada dentro da janela" };
  }
  if (pos === "ambiguous") {
    return {
      category: "date_unverified",
      eligible: false,
      veto: "V002_DATE_UNVERIFIED",
      reason: "Só há o dia da publicação e ele cruza o início da janela; a hora decide a elegibilidade",
    };
  }

  // Publicação anterior à janela: só entra como desenvolvimento material comprovado.
  const su = input.substantive_update;
  if (su) {
    const suDate = parseClaimedDate(su.date);
    const complete =
      su.previous_content.trim() !== "" &&
      su.new_fact.trim() !== "" &&
      su.why_it_matters.trim() !== "" &&
      su.evidence_ids.length > 0 &&
      su.verified_by_fact_checker;
    if (suDate && position(suDate, w, tol) === "inside" && complete) {
      return {
        category: "substantive_new_development",
        eligible: true,
        veto: null,
        reason: "Publicação anterior com fato novo material, datado na janela, com evidência e verificado",
      };
    }
    return {
      category: "out_of_window",
      eligible: false,
      veto: "V003_NO_SUBSTANTIVE_UPDATE",
      reason: "Atualização alegada sem os requisitos de desenvolvimento material (seção 6.3)",
    };
  }
  const updated = parseClaimedDate(input.updated_at_claimed);
  if (updated && position(updated, w, tol) === "inside") {
    return {
      category: "out_of_window",
      eligible: false,
      veto: "V003_NO_SUBSTANTIVE_UPDATE",
      reason: "Página antiga com data de atualização recente, sem fato novo comprovado",
    };
  }
  return {
    category: "out_of_window",
    eligible: false,
    veto: "V001_OUT_OF_WINDOW",
    reason: "Publicada antes do início da janela",
  };
}

export function formatSaoPaulo(d: Date): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: TIMEZONE, dateStyle: "short", timeStyle: "short",
  }).format(d);
}
