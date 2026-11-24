import { describe, expect, it } from "vitest";
import { excerptMatch, extractPublishedMeta, htmlToText } from "../../src/verification/fetch-check.js";

describe("checagem de fonte por código", () => {
  const html = `<html><head><title>ANS</title><meta property="article:published_time" content="2026-11-26T10:00:00-03:00"></head>
  <body><script>var x=1</script><p>A Agência Nacional de Saúde Suplementar publicou a Resolução Normativa nº 612, que entra em vigor em 90 dias.</p></body></html>`;
  it("encontra trecho literal e quase literal", () => {
    const text = htmlToText(html);
    expect(excerptMatch(text, "publicou a Resolução Normativa nº 612, que entra em vigor em 90 dias").found).toBe(true);
    expect(excerptMatch(text, "Agência Nacional de Saúde Suplementar publicou Resolução Normativa 612").found).toBe(true);
  });
  it("rejeita trecho com número diferente ou inventado", () => {
    const text = htmlToText(html);
    expect(excerptMatch(text, "publicou a Resolução Normativa nº 613, que entra em vigor em 90 dias").found).toBe(false);
    expect(excerptMatch(text, "O reajuste dos planos será de 12% em 2027 segundo a agência").found).toBe(false);
  });
  it("lê a data de publicação dos metadados", () => {
    expect(extractPublishedMeta(html)).toBe("2026-11-26T10:00:00-03:00");
    expect(extractPublishedMeta(`<script type="application/ld+json">{"datePublished":"2026-11-20T08:00:00"}</script>`)).toBe("2026-11-20");
    expect(extractPublishedMeta("<p>sem data</p>")).toBeNull();
  });
});
