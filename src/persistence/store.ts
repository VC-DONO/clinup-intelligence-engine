import { mkdir, readFile, rename, writeFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EventRecord, HistoryStatus } from "../schemas/contracts.js";

/**
 * Persistência em arquivos JSON versionados no Git: sobrevive ao fim da execução,
 * é auditável por diff e não exige banco externo. Escrita atômica (tmp + rename).
 */
export class FileStore {
  constructor(readonly root = "data") {}

  async writeJson(rel: string, value: unknown): Promise<void> {
    const path = join(this.root, rel);
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
    await rename(tmp, path);
    // Confirma que gravou de fato (AT-027: nunca declarar persistência não confirmada).
    const back = await readFile(path, "utf8");
    if (back !== JSON.stringify(value, null, 2) + "\n") throw new Error(`Falha ao confirmar gravação de ${rel}`);
  }

  async readJson<T>(rel: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.root, rel), "utf8")) as T;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }

  async list(relDir: string): Promise<string[]> {
    try { return (await readdir(join(this.root, relDir))).sort(); } catch { return []; }
  }
}

export interface HistoryIndex {
  schema_version: string;
  updated_at: string;
  events: Record<string, Pick<EventRecord, "event_id" | "canonical_event_key" | "event_title" | "first_known_date" | "latest_development_date" | "status"> & { reported_in_runs: string[] }>;
}

export type HistoryLoad = { available: true; index: HistoryIndex } | { available: false; reason: string };

export async function loadHistory(store: FileStore): Promise<HistoryLoad> {
  try {
    const index = await store.readJson<HistoryIndex>("history/events.json");
    if (!index) return { available: true, index: { schema_version: "1.0.0", updated_at: new Date(0).toISOString(), events: {} } };
    if (typeof index.events !== "object") return { available: false, reason: "Índice de histórico corrompido" };
    return { available: true, index };
  } catch (e) {
    return { available: false, reason: `Histórico ilegível: ${(e as Error).message}` };
  }
}

/** Seção 10.5. Sem histórico, nunca afirmar que é novo (AT-026). */
export function historyStatusFor(h: HistoryLoad, key: string, isMaterialDevelopment: boolean): HistoryStatus {
  if (!h.available) return "UNKNOWN_HISTORY";
  const known = h.index.events[key];
  if (!known) return "NEW";
  return isMaterialDevelopment ? "MATERIAL_UPDATE" : "ALREADY_REPORTED";
}

/** Lê de um diretório e grava em outro: usado no modo sessão, para não tocar o histórico real. */
export class OverlayStore extends FileStore {
  constructor(private readonly readRoot: string, writeRoot: string) { super(writeRoot); }
  override async readJson<T>(rel: string): Promise<T | null> {
    return new FileStore(this.readRoot).readJson<T>(rel);
  }
}
