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

## Como roda

1. **Toda segunda-feira às 06:00 (São Paulo)** o GitHub Actions executa `REFRESH` ([`.github/workflows/weekly-refresh.yml`](.github/workflows/weekly-refresh.yml)). Também dá para rodar na hora em *Actions → Pauta semanal → Run workflow*.
2. Antes de pesquisar, os testes determinísticos rodam. Se algum falhar, nada é publicado.
3. O orquestrador ([`src/orchestration/refresh.ts`](src/orchestration/refresh.ts)) fixa T0, calcula a janela de 7 dias e chama cada agente numa chamada separada da API do Claude, com contexto isolado:
   pesquisador (busca e abre páginas) → verificador independente → analista crítico e analista de oportunidades (em paralelo, sem um ver o outro) → estrategista → aderência CLIN-UP → redator → advogado do diabo → auditor final → inteligência competitiva, sinais fracos e resumo.
4. Datas, vetos, deduplicação, pontuação e checagem de números e fontes são **código**, não prompt.
5. Histórico, decisões, vetos e evidências ficam em `data/` (versionado no Git). O relatório vai para `public/` e é publicado no GitHub Pages.

## Regras implementadas em código

- Janela de 168 h (`config/defaults.yaml`), fronteira inclusiva, com fuso `America/Sao_Paulo`. Datas sem fuso ou em formato ambíguo são tratadas como não verificáveis.
- Uma página só conta como evidência se o `web_fetch` a abriu **naquela verificação**. Resultado de busca não é leitura.
- Vetos V001 a V015 da especificação, persistidos com código e justificativa em `data/runs/<data>_<id>/`.
- Republicações da mesma origem contam como uma confirmação.
- Notícia regulatória exige documento oficial aberto.
- Número no texto final que não aparece nas evidências bloqueia a publicação até correção.
- Linguagem sensacionalista e ressalvas removidas bloqueiam até correção.
- CTA do CLIN-UP só com serviço do catálogo aprovado em `config/clinup-services.yaml`.
- Teto de custo por execução (`limits.max_cost_usd_per_run`). Ao atingir, o que não foi concluído não é publicado e a execução termina `completed_with_warnings`.
- Nada é enviado a redes sociais ou e-mail.

## Configuração inicial (uma vez)

1. Em *Settings → Secrets and variables → Actions*, crie o secret `ANTHROPIC_API_KEY` com uma chave de [console.anthropic.com](https://console.anthropic.com).
2. Em *Settings → Pages*, em *Source*, escolha **GitHub Actions**.
3. Preencha `config/clinup-services.yaml` com os serviços reais e mude `approved` para `true` quando quiser CTAs.

## Comandos locais

```bash
npm ci
npm test                       # testes determinísticos e de ponta a ponta com agentes simulados
ANTHROPIC_API_KEY=... npm run refresh
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
- Páginas com paywall ou bloqueio de robôs podem não abrir, e então a notícia é vetada por falta de fonte acessível.
- Os testes de ponta a ponta usam agentes simulados; a qualidade da pesquisa real precisa ser auditada nas primeiras edições.
