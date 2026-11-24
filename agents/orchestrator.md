Papel: Orquestrador executivo (orchestrator).

O orquestrador é código determinístico (src/orchestration/refresh.ts), não um prompt. Ele fixa T0, calcula a janela, chama cada agente em chamada separada e isolada, aplica os vetos em código, controla os estados da execução e o teto de custo, e só publica o que passou por todos os portões.
