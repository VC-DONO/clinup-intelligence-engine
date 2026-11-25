# CLIN-UP Intelligence Engine

Sistema que, toda semana, pesquisa, verifica e publica as notícias que importam para donos e gestores de clínicas e consultórios de saúde. Nenhuma notícia entra porque "parece importante": entra porque passou por data dentro da janela, evidência aberta e rastreável, verificação independente, análise crítica, contraditório e auditoria final.

## Endereço que o site consulta

| O quê | URL |
|---|---|
| Edição mais recente (JSON) | `https://vc-dono.github.io/clinup-intelligence-engine/api/latest.json` |
| Edições anteriores | `https://vc-dono.github.io/clinup-intelligence-engine/api/index.json` |
| Estado da última execução | `https://vc-dono.github.io/clinup-intelligence-engine/api/status.json` |
| Página pronta (HTML) | `https://vc-dono.github.io/clinup-intelligence-engine/` |

O GitHub Pages responde com `Access-Control-Allow-Origin: *`, então o site pode ler o JSON direto do navegador:

```html
<div id="clinup-noticias"></div>
<script>
fetch("https://vc-dono.github.io/clinup-intelligence-engine/api/latest.json")
  .then((r) => r.json())
  .then((rep) => {
    const el = document.getElementById("clinup-noticias");
    el.innerHTML = rep.news.map((n) => `
      <article>
        <h3>${n.title}</h3>
        <p>${n.what_happened}</p>
        <p><strong>Por que importa:</strong> ${n.why_it_matters}</p>
        <a href="${n.main_source.url}" target="_blank" rel="noopener">Fonte: ${n.main_source.name}</a>
      </article>`).join("");
  });
</script>
```

Se uma execução falhar, `latest.json` continua com a última edição válida e `status.json` explica o que houve.

O formato do JSON é o contrato `PublishedReport` em [`src/schemas/contracts.ts`](src/schemas/contracts.ts).

## Como roda (custo zero)

Não usa a API paga do Claude. O trabalho é dividido entre duas peças gratuitas:

1. **Tarefa agendada do Claude, toda segunda-feira às 05:40 (São Paulo).** Usa o plano do Claude que você já tem. A sessão segue [`docs/RUNBOOK-sessao.md`](docs/RUNBOOK-sessao.md): roda `npm run coletar`, o código diz quais agentes precisam responder, a sessão responde cada tarefa num subagente separado (pesquisador, verificador independente, riscos, oportunidades, estrategista, aderência CLIN-UP, redator, advogado do diabo, auditor final, competitivo, sinais fracos, resumo) e repete até o código dizer que está pronto. Depois faz commit da coleta.
2. **GitHub Actions ([`ingest.yml`](.github/workflows/ingest.yml)), grátis.** O commit da coleta dispara o workflow. Os testes rodam no GitHub; a conferência roda no computador do Pedro (executor self-hosted com rótulo `clinup-br`), porque os sites gov.br recusam conexões de servidores fora do Brasil. Se o computador estiver desligado, a conferência espera na fila por até 24 h. Ela **abre por conta própria cada página citada** e confere se o trecho citado está lá e se a data dos metadados bate com a janela. Só depois aplica os portões, publica no GitHub Pages e grava o histórico em `data/`.

O orquestrador ([`src/orchestration/refresh.ts`](src/orchestration/refresh.ts)) é o mesmo nos dois passos: no primeiro ele lê as respostas da sessão sem publicar nada; no segundo ele as relê, refaz todos os portões com as fontes conferidas e descarta qualquer resposta cuja entrada mudou depois da checagem.

Há também um modo opcional pago ([`refresh-api.yml`](.github/workflows/refresh-api.yml)), que faz tudo pela API do Claude. Ele só é usado se alguém disparar manualmente e cadastrar o secret `ANTHROPIC_API_KEY`.

## Regras implementadas em código

- Janela de 168 h (`config/defaults.yaml`), fronteira inclusiva, com fuso `America/Sao_Paulo`. Datas sem fuso ou em formato ambíguo são tratadas como não verificáveis.
- Uma página só conta como evidência se o código a abriu no GitHub Actions e encontrou nela o trecho citado (no modo API: se o `web_fetch` a abriu naquela verificação). Resultado de busca não é leitura.
- Se a data nos metadados da página cair fora da janela, a notícia é vetada mesmo que o agente diga o contrário.
- Vetos V001 a V015 da especificação, persistidos com código e justificativa em `data/runs/<data>_<id>/`.
- Republicações da mesma origem contam como uma confirmação.
- Notícia regulatória exige documento oficial aberto.
- Número no texto final que não aparece nas evidências bloqueia a publicação até correção.
- Linguagem sensacionalista e ressalvas removidas bloqueiam até correção.
- CTA do CLIN-UP só com serviço do catálogo aprovado em `config/clinup-services.yaml`.
- No modo API (opcional), teto de custo por execução (`limits.max_cost_usd_per_run`).
- Nada é enviado a redes sociais ou e-mail.

## Configuração inicial (uma vez)

0. No computador que vai conferir as fontes (Windows, com [Git for Windows](https://git-scm.com/download/win) instalado): *Settings → Actions → Runners → New self-hosted runner → Windows*, rode os comandos mostrados no PowerShell como administrador, informe o rótulo `clinup-br` e aceite rodar como serviço.
   Como o repositório é público, em *Settings → Actions → General → Approval for running fork pull request workflows* escolha **Require approval for all external contributors**.
1. Em *Settings → Pages*, em *Source*, escolha **GitHub Actions**.
2. Preencha `config/clinup-services.yaml` com os serviços reais e mude `approved` para `true` quando quiser CTAs.

## Comandos locais

```bash
npm ci
npm test                       # testes determinísticos e de ponta a ponta com agentes simulados
npm run coletar               # modo sessão: gera tarefas / avança etapas
npm run ingerir               # confere fontes, aplica portões e publica (o Actions roda isto)
ANTHROPIC_API_KEY=... npm run refresh   # modo API opcional (pago)
npx tsx src/cli/index.ts REFRESH REGULATÓRIO   # também: FINANCEIRO, COMERCIAL, IA, INTERNACIONAL, DENTISTAS, PSICOLOGIA
npm run status                 # última execução
npm run auditar -- <run_id>    # decisões e vetos de uma execução
```

## Diferenças em relação à especificação técnica v1.0.0

- Janela de **7 dias** em vez de 72 h, porque a execução é semanal.
- `publish_automatically` foi dividido: publicação **somente** no endpoint do site (`publish_to_site_endpoint: true`); redes sociais e e-mail continuam proibidos por esquema.
- Persistência em JSON versionado no Git em vez de SQLite: sobrevive entre execuções do Actions e é auditável por diff.

## Limitações conhecidas

- Cobertura depende do que a busca web encontra; não é cobertura total da internet.
- O modo custo zero consome o limite de uso do seu plano do Claude na manhã de segunda. Se o limite estiver esgotado, a coleta não termina e a edição anterior continua no ar.
- Sites que bloqueiam acesso automatizado a partir do GitHub Actions não podem ser conferidos e suas notícias são vetadas por fonte inacessível.
- Páginas com paywall ou bloqueio de robôs podem não abrir, e então a notícia é vetada por falta de fonte acessível.
- Os testes de ponta a ponta usam agentes simulados; a qualidade da pesquisa real precisa ser auditada nas primeiras edições.
