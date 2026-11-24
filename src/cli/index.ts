import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse } from "yaml";
import { loadPrompts } from "../agents/prompts.js";
import { loadConfig } from "../config/config.js";
import { AnthropicLlm } from "../llm/anthropic.js";
import { refresh, type Catalog, type CoverageGroup } from "../orchestration/refresh.js";
import { FileStore, OverlayStore } from "../persistence/store.js";
import { ReplayLlm } from "../llm/replay.js";
import { checkPage } from "../verification/fetch-check.js";
import { publish } from "../reporting/publish.js";
import { RunRequest } from "../schemas/contracts.js";

const INBOX = "data/inbox/current";

function deps() {
  return {
    config: loadConfig(),
    prompts: loadPrompts(),
    coverage: (parse(readFileSync("config/coverage-matrix.yaml", "utf8")) as { groups: CoverageGroup[] }).groups,
    catalog: parse(readFileSync("config/clinup-services.yaml", "utf8")) as Catalog,
  };
}

interface Plan { run_id: string; t0: string; command: string }

async function main() {
  const args = process.argv.slice(2);
  const cmd = args.join(" ").trim().toUpperCase();
  const store = new FileStore("data");

  // Modo sessão, passo 1..N: gera tarefas para a sessão agendada e avança quando as respostas existem.
  if (cmd.startsWith("COLETAR")) {
    mkdirSync(INBOX, { recursive: true });
    const planFile = join(INBOX, "plan.json");
    if (!existsSync(planFile)) {
      const command = ("REFRESH " + cmd.replace(/^COLETAR\s*/, "")).trim();
      writeFileSync(planFile, JSON.stringify({ run_id: randomUUID(), t0: new Date().toISOString(), command } satisfies Plan, null, 2) + "\n");
    }
    const plan = JSON.parse(readFileSync(planFile, "utf8")) as Plan;
    const d = deps();
    const llm = new ReplayLlm(INBOX, "collect");
    const outcome = await refresh(RunRequest.parse({ command: plan.command, max_main_news: d.config.max_main_news }), {
      ...d, llm, store: new OverlayStore("data", join(INBOX, "provisional")), run_id: plan.run_id, now: () => new Date(plan.t0),
    });
    if (outcome.state === "awaiting_input") {
      const f = llm.writeTasks();
      console.log(JSON.stringify({ status: "aguardando_agentes", pendentes: llm.pending.length, arquivo_de_tarefas: f,
        agentes: [...new Set(llm.pending.map((p) => p.agent))] }, null, 2));
      return;
    }
    if (outcome.state === "failed") {
      console.log(JSON.stringify({ status: "falhou", avisos: outcome.warnings }, null, 2));
      process.exit(1);
    }
    llm.writeHashes();
    writeFileSync(join(INBOX, "tasks.json"), JSON.stringify({ generated_at: new Date().toISOString(), tasks: [] }, null, 2) + "\n");
    writeFileSync(join(INBOX, "READY.json"), JSON.stringify({ run_id: plan.run_id, provisional_state: outcome.state,
      provisional_news: outcome.report?.news.map((n) => n.title) ?? [], ready_at: new Date().toISOString() }, null, 2) + "\n");
    console.log(JSON.stringify({ status: "pronto_para_publicar", noticias_provisorias: outcome.report?.news.length ?? 0,
      proximo_passo: "git add data/inbox && git commit && git push (o GitHub Actions confere as fontes e publica)" }, null, 2));
    return;
  }

  // Modo sessão, passo final (GitHub Actions): confere fontes por código, aplica os portões e publica.
  if (cmd.startsWith("INGERIR")) {
    if (!existsSync(join(INBOX, "READY.json"))) { console.error("Nada para ingerir: data/inbox/current/READY.json ausente."); process.exit(1); }
    const plan = JSON.parse(readFileSync(join(INBOX, "plan.json"), "utf8")) as Plan;
    const d = deps();
    const llm = new ReplayLlm(INBOX, "verify", checkPage);
    const outcome = await refresh(RunRequest.parse({ command: plan.command, max_main_news: d.config.max_main_news }), {
      ...d, llm, store, run_id: plan.run_id, now: () => new Date(plan.t0),
    });
    const dir = (await store.list("runs")).find((x) => x.includes(plan.run_id.slice(0, 8)));
    if (dir) await store.writeJson(`runs/${dir}/source-checks.json`, llm.checks);
    const files = await publish(outcome, "public");
    const archive = `data/inbox/archive/${plan.t0.slice(0, 10)}_${plan.run_id.slice(0, 8)}`;
    mkdirSync("data/inbox/archive", { recursive: true });
    renameSync(INBOX, archive);
    const opened = llm.checks.filter((c) => c.ok).length;
    console.log(JSON.stringify({ run_id: outcome.run_id, state: outcome.state, published_files: files,
      paginas_conferidas: llm.checks.length, paginas_abertas: opened, trechos_nao_encontrados: llm.checks.filter((c) => c.excerpt_found === false).length,
      metrics: outcome.metrics, warnings: outcome.warnings, arquivo: archive }, null, 2));
    process.exit(outcome.state === "failed" ? 1 : 0);
  }

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

  console.error("Comandos: COLETAR [filtro] · INGERIR · REFRESH [FINANCEIRO|COMERCIAL|REGULATÓRIO|IA|INTERNACIONAL|DENTISTAS|PSICOLOGIA] · STATUS [run_id] · AUDITAR [run_id]");
  process.exit(1);
}

main().catch((e) => { console.error((e as Error).message); process.exit(1); });
