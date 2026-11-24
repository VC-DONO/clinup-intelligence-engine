import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PublishedNews, PublishedReport } from "../schemas/contracts.js";
import type { RefreshOutcome } from "../orchestration/refresh.js";

/**
 * Publica somente no endpoint estático do site (public/ → GitHub Pages).
 * Nada é enviado para redes sociais, e-mail ou outros serviços (seção 1.2, AT-028).
 */
async function write(root: string, rel: string, body: string) {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
}

export async function publish(outcome: RefreshOutcome, root = "public"): Promise<string[]> {
  const written: string[] = [];
  const status = {
    run_id: outcome.run_id,
    state: outcome.state,
    finished_at: new Date().toISOString(),
    published: outcome.report ? outcome.report.news.length : 0,
    warnings: outcome.warnings,
    note: outcome.report ? "Relatório publicado." : "Execução sem relatório publicável; latest.json mantém a última edição válida.",
  };
  await write(root, "api/status.json", JSON.stringify(status, null, 2));
  written.push("api/status.json");
  if (!outcome.report) return written;

  const rep = outcome.report;
  const date = rep.window.end.slice(0, 10);
  const json = JSON.stringify(rep, null, 2);
  await write(root, "api/latest.json", json);
  await write(root, `api/reports/${date}.json`, json);
  written.push("api/latest.json", `api/reports/${date}.json`);

  let index: { reports: { date: string; run_id: string; news: number; url: string }[] } = { reports: [] };
  try { index = JSON.parse(await readFile(join(root, "api/index.json"), "utf8")); } catch { /* primeiro relatório */ }
  index.reports = [{ date, run_id: rep.run_id, news: rep.news.length, url: `api/reports/${date}.json` },
    ...index.reports.filter((r) => r.date !== date)].slice(0, 104);
  await write(root, "api/index.json", JSON.stringify(index, null, 2));
  await write(root, "index.html", renderHtml(rep));
  await write(root, ".nojekyll", "");
  written.push("api/index.json", "index.html");
  return written;
}

const esc = (s: string | null | undefined) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? esc(u) : "#");
const fmt = (iso: string) => {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00-03:00` : iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric" });
};
const DECISION: Record<PublishedNews["recommended_decision"], string> = {
  act_now: "Agir agora", prepare: "Preparar-se", monitor: "Monitorar",
  evaluate_opportunity: "Avaliar oportunidade", no_immediate_action: "Sem ação imediata",
};
const PRIORITY: Record<PublishedNews["priority"], string> = { maxima: "Prioridade máxima", alta: "Prioridade alta", moderada: "Prioridade moderada" };

function list(title: string, xs: string[]) {
  return xs.length ? `<h4>${title}</h4><ul>${xs.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
}

function renderNews(n: PublishedNews, i: number) {
  return `<article id="${esc(n.event_id)}">
  <div class="meta"><span class="num">${String(i + 1).padStart(2, "0")}</span><span class="tag">${esc(n.category)}</span><span class="tag p-${n.priority}">${PRIORITY[n.priority]}</span><span>Publicada em ${fmt(n.published_at)}</span>${n.temporal_category === "substantive_new_development" ? '<span class="tag">Novo desenvolvimento</span>' : ""}</div>
  <h2>${esc(n.title)}</h2>
  <p class="lead">${esc(n.what_happened)}</p>
  <h4>Por que importa para a clínica</h4><p>${esc(n.why_it_matters)}</p>
  ${list("Pontos de atenção", n.risks)}
  ${list("Oportunidades", n.opportunities)}
  <h4>Decisão recomendada: ${DECISION[n.recommended_decision]}</h4>
  ${list("Ações práticas", n.actions)}
  ${list("Ressalvas", n.editorial.caveats)}
  ${n.clinup_fit.cta ? `<p class="cta">${esc(n.clinup_fit.cta)}</p>` : ""}
  <p class="src">Fonte principal: <a href="${safeUrl(n.main_source.url)}" rel="noopener" target="_blank">${esc(n.main_source.name)}</a>${n.independent_confirmations.length ? ` · Confirmação: ${n.independent_confirmations.map((c) => `<a href="${safeUrl(c.url)}" rel="noopener" target="_blank">${esc(c.name)}</a>`).join(", ")}` : ""}</p>
</article>`;
}

export function renderHtml(rep: PublishedReport): string {
  return `<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notícias da semana · CLIN-UP Intelligence</title>
<style>
:root{--ink:#1d2430;--muted:#5b6575;--line:#e3e7ee;--accent:#0b6e6e;--bg:#fbfbf9}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:760px;margin:0 auto;padding:40px 20px 80px}header h1{font-size:30px;margin:0 0 4px}header p{color:var(--muted);margin:0}
.summary{border-left:3px solid var(--accent);padding:4px 0 4px 16px;margin:28px 0}
article{border-top:1px solid var(--line);padding:28px 0}article h2{font-size:22px;line-height:1.3;margin:8px 0 12px}
.meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;color:var(--muted);font-size:13px}.num{font-weight:700;color:var(--accent)}
.tag{border:1px solid var(--line);border-radius:99px;padding:1px 10px}.p-maxima{border-color:#b54708;color:#b54708}.p-alta{border-color:var(--accent);color:var(--accent)}
h4{font-size:14px;margin:18px 0 4px}.lead{font-size:17px}ul{margin:4px 0;padding-left:20px}.src{font-size:13px;color:var(--muted)}
a{color:var(--accent)}.cta{background:#eef6f6;padding:10px 14px;border-radius:8px}footer{color:var(--muted);font-size:13px;border-top:1px solid var(--line);padding-top:20px}
</style></head><body><main>
<header><h1>Notícias da semana</h1><p>De ${fmt(rep.window.start)} a ${fmt(rep.window.end)} · ${rep.news.length} ${rep.news.length === 1 ? "notícia verificada" : "notícias verificadas"}</p></header>
<p class="summary">${esc(rep.executive_summary)}</p>
${rep.news.map(renderNews).join("\n")}
${rep.weak_signals.length ? `<section><h3>Sinais fracos (hipóteses, não fatos)</h3><ul>${rep.weak_signals.map((w) => `<li>${esc(w.hypothesis)} <em>(confiança ${w.confidence === "low" ? "baixa" : w.confidence === "medium" ? "média" : "alta"})</em></li>`).join("")}</ul></section>` : ""}
${rep.follow_up.length ? `<section><h3>Agenda de acompanhamento</h3><ul>${rep.follow_up.map((f) => `<li>${esc(f)}</li>`).join("")}</ul></section>` : ""}
<footer><p>Cada notícia passou por checagem de data (somente publicações da janela), verificação de fontes, análise crítica, contraditório e auditoria final. Execução ${esc(rep.run_id.slice(0, 8))}, gerada em ${fmt(rep.generated_at)}. Dados em <a href="api/latest.json">api/latest.json</a>.</p>
${rep.limitations.length ? `<details><summary>Limitações desta edição (${rep.limitations.length})</summary><ul>${rep.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul></details>` : ""}</footer>
</main></body></html>
`;
}
