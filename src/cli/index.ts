import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { loadPrompts } from "../agents/prompts.js";
import { loadConfig } from "../config/config.js";
import { AnthropicLlm } from "../llm/anthropic.js";
import { refresh, type Catalog, type CoverageGroup } from "../orchestration/refresh.js";
import { FileStore } from "../persistence/store.js";
import { publish } from "../reporting/publish.js";
import { RunRequest } from "../schemas/contracts.js";

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.join(" ").trim().toUpperCase();
  const store = new FileStore("data");

  if (cmd.startsWith("REFRESH")) {
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY não configurada. Nenhuma pesquisa foi feita.");
      process.exit(2);
    }
    const config = loadConfig();
    const request = RunRequest.parse({ command: cmd, max_main_news: config.max_main_news });
    const outcome = await refresh(request, {
      llm: new AnthropicLlm(config.limits.max_cost_usd_per_run),
      store,
      config,
      prompts: loadPrompts(),
      coverage: (parse(readFileSync("config/coverage-matrix.yaml", "utf8")) as { groups: CoverageGroup[] }).groups,
      catalog: parse(readFileSync("config/clinup-services.yaml", "utf8")) as Catalog,
    });
    const files = await publish(outcome, "public");
    console.log(JSON.stringify({ run_id: outcome.run_id, state: outcome.state, published_files: files, metrics: outcome.metrics, warnings: outcome.warnings }, null, 2));
    process.exit(outcome.state === "failed" ? 1 : 0);
  }

  if (cmd.startsWith("STATUS") || cmd.startsWith("AUDITAR")) {
    const id = args[1]?.toLowerCase();
    const dirs = await store.list("runs");
    const dir = id ? dirs.find((d) => d.includes(id.slice(0, 8))) : dirs.at(-1);
    if (!dir) { console.error("Execução não encontrada"); process.exit(1); }
    const run = await store.readJson(`runs/${dir}/run.json`);
    if (cmd.startsWith("STATUS")) { console.log(JSON.stringify(run, null, 2)); return; }
    const decisions = (await store.readJson<{ decision_type: string; rule_id: string; reason: string }[]>(`runs/${dir}/decisions.json`)) ?? [];
    console.log(JSON.stringify({ run, decisions }, null, 2));
    return;
  }

  console.error("Comandos: REFRESH [FINANCEIRO|COMERCIAL|REGULATÓRIO|IA|INTERNACIONAL|DENTISTAS|PSICOLOGIA] · STATUS [run_id] · AUDITAR [run_id]");
  process.exit(1);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
