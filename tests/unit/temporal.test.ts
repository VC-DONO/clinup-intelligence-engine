import { describe, expect, it } from "vitest";
import { classifyTemporal, computeWindow, parseClaimedDate } from "../../src/temporal/window.js";

const T0 = new Date("2026-11-24T09:00:00-03:00");
const W72 = computeWindow(T0, 72);
const iso = (ms: number) => new Date(ms).toISOString();
const START = W72.windowStart.getTime();

describe("Regra temporal (seção 6, AT-001..AT-008)", () => {
  it("AT-001 publicação dentro da janela passa", () => {
    const r = classifyTemporal({ published_at_confirmed: "2026-11-23T10:00:00-03:00" }, W72);
    expect(r).toMatchObject({ category: "new_publication", eligible: true, veto: null });
  });

  it("AT-002 publicação exatamente em T0-72h é elegível (fronteira inclusiva)", () => {
    const r = classifyTemporal({ published_at_confirmed: iso(START) }, W72);
    expect(r.eligible).toBe(true);
  });

  it("AT-002b publicação exatamente em T0 é elegível", () => {
    expect(classifyTemporal({ published_at_confirmed: T0.toISOString() }, W72).eligible).toBe(true);
  });

  it("AT-003 um segundo antes do limite gera V001", () => {
    const r = classifyTemporal({ published_at_confirmed: iso(START - 1000) }, W72);
    expect(r).toMatchObject({ eligible: false, veto: "V001_OUT_OF_WINDOW", category: "out_of_window" });
  });

  it("AT-004 data ausente gera V002", () => {
    expect(classifyTemporal({ published_at_confirmed: null }, W72).veto).toBe("V002_DATE_UNVERIFIED");
  });

  it("AT-004b data em formato ambíguo (sem fuso ou dd/mm) gera V002, sem adivinhar", () => {
    for (const s of ["23/11/2026", "2026-11-23T10:00:00", "ontem", "Nov 23, 2026"]) {
      expect(classifyTemporal({ published_at_confirmed: s }, W72).veto).toBe("V002_DATE_UNVERIFIED");
    }
  });

  it("AT-005 página antiga com atualização cosmética gera V003", () => {
    const r = classifyTemporal(
      { published_at_confirmed: "2026-10-01T10:00:00-03:00", updated_at_claimed: "2026-11-23T10:00:00-03:00" },
      W72,
    );
    expect(r).toMatchObject({ eligible: false, veto: "V003_NO_SUBSTANTIVE_UPDATE" });
  });

  it("AT-005b atualização alegada sem evidência ou sem verificação gera V003", () => {
    const base = {
      date: "2026-11-23T10:00:00-03:00", previous_content: "Consulta pública aberta",
      new_fact: "Norma publicada", why_it_matters: "Passa a valer", evidence_ids: ["e1"], verified_by_fact_checker: true,
    };
    for (const su of [{ ...base, evidence_ids: [] }, { ...base, verified_by_fact_checker: false }, { ...base, new_fact: " " }]) {
      const r = classifyTemporal({ published_at_confirmed: "2026-10-01T10:00:00-03:00", substantive_update: su }, W72);
      expect(r.veto).toBe("V003_NO_SUBSTANTIVE_UPDATE");
    }
  });

  it("AT-006 desenvolvimento material recente com evidência é elegível", () => {
    const r = classifyTemporal(
      {
        published_at_confirmed: "2026-10-01T10:00:00-03:00",
        substantive_update: {
          date: "2026-11-23T10:00:00-03:00", previous_content: "Consulta pública aberta",
          new_fact: "ANS publicou a resolução final", why_it_matters: "Vira obrigação com prazo",
          evidence_ids: ["ev-1"], verified_by_fact_checker: true,
        },
      },
      W72,
    );
    expect(r).toMatchObject({ category: "substantive_new_development", eligible: true });
  });

  it("AT-007 data futura é bloqueada", () => {
    const r = classifyTemporal({ published_at_confirmed: "2026-11-25T09:00:00-03:00" }, W72);
    expect(r).toMatchObject({ category: "future_or_invalid_date", eligible: false, veto: "V002_DATE_UNVERIFIED" });
  });

  it("AT-007b data impossível (31/02) é não verificável", () => {
    expect(parseClaimedDate("2026-02-31")).toBeNull();
  });

  it("AT-008 timestamp UTC que cruza a fronteira é calculado com fuso", () => {
    // window_start = 2026-11-21T09:00-03:00 = 2026-11-21T12:00Z
    expect(classifyTemporal({ published_at_confirmed: "2026-11-21T12:00:00Z" }, W72).eligible).toBe(true);
    expect(classifyTemporal({ published_at_confirmed: "2026-11-21T11:59:59Z" }, W72).veto).toBe("V001_OUT_OF_WINDOW");
    // "11:30 em São Paulo" é depois do limite, embora a string "11:30" seja menor que "12:00Z"
    expect(classifyTemporal({ published_at_confirmed: "2026-11-21T11:30:00-03:00" }, W72).eligible).toBe(true);
  });

  it("data só com o dia: dentro, fora e cruzando a fronteira", () => {
    expect(classifyTemporal({ published_at_confirmed: "2026-11-22" }, W72).eligible).toBe(true);
    expect(classifyTemporal({ published_at_confirmed: "2026-11-20" }, W72).veto).toBe("V001_OUT_OF_WINDOW");
    expect(classifyTemporal({ published_at_confirmed: "2026-11-21" }, W72).veto).toBe("V002_DATE_UNVERIFIED");
    expect(classifyTemporal({ published_at_confirmed: "2026-11-24" }, W72).eligible).toBe(true);
  });

  it("janela semanal (168 h) cobre os 7 dias anteriores", () => {
    const w = computeWindow(T0, 168);
    expect(classifyTemporal({ published_at_confirmed: "2026-11-17T09:00:00-03:00" }, w).eligible).toBe(true);
    expect(classifyTemporal({ published_at_confirmed: "2026-11-17T08:59:59-03:00" }, w).eligible).toBe(false);
  });

  it("T0 fica congelado", () => {
    expect(Object.isFrozen(W72)).toBe(true);
  });
});
