# CLAUDE.md — resenha-backend

@AI_RULES.md

---

## O que é este projeto

WebSocket + REST que conversa com o **Resenha Client** (app desktop) e é a
**fonte de verdade** da partida ao vivo: recebe os eventos do CS2, monta o
placar e **registra o resultado sozinho** quando o jogo acaba.

Faz parte de um sistema de três peças:

```
Navegador ──> resenha-cs-next (Vercel) ──┐
                                          ├──> Turso (banco compartilhado)
CS2 ──GSI──> Resenha Client ──WebSocket──> resenha-backend (VOCÊ ESTÁ AQUI)
```

- **site** (`resenha-cs`): lobby, times, veto, ranking. Chama `/internal/*`.
- **client** (`client-resenha-cs`): lê o CS2 e manda eventos por WebSocket.

## Stack

Node >= 20, ESM, `http` nativo + `ws`. **Sem framework, por decisão.**
Banco Turso (libSQL), **compartilhado com o site**.
Hospedado no Render, **plano free: hiberna** após ~15 min sem tráfego.

## Estrutura

```
src/
  index.js      entrada: sobe servidor e agenda a varredura
  http/         helpers, tabela de rotas, roteador
  ws/           registry (quem está online), server, messages
  matches/      lifecycle, events, live-state, scoring, sweep, index (fachada)
  auth.js db.js log.js ratelimit.js version.js
```

## Fluxo de uma partida

1. Site termina o veto → `POST /internal/match/start`;
2. Backend cria a `live_match` e manda `START_MATCH` pros clients;
3. Clients mandam eventos (`STATE_SYNC` a cada 10s, `PLAYER_KILL`, …);
4. `GAME_OVER` chega → `matches/scoring.js` registra elo, histórico e fecha o
   lobby → manda `END_MATCH`.

**Três princípios inegociáveis:**

- **Tudo é idempotente.** O client reconecta, o site repete chamadas, o Render
  reinicia. Nenhuma operação pode causar dano ao ser repetida.
- **Toda falha tem rede de segurança.** A varredura (`matches/sweep.js`) roda
  no boot e de hora em hora: registra placar pendente, encerra coleta órfã e
  abandona partida de mais de 4h. Nenhum estado fica preso para sempre.
- **Nada depende do backend estar acordado.** Ele hiberna; chamadas do site
  falham em silêncio e são recuperadas pelo polling ou pela varredura.

## Regras deste projeto

- **Rota nova = uma linha em `http/routes.js`.** Não mexa no roteador.
- Rota `/internal/*` exige `X-Internal-Key` (marque `interna: true`).
- Erro esperado: `throw new HttpError(status, mensagem)` — o roteador converte
  em JSON. Não monte resposta de erro na mão no handler.
- O que o domínio sabe do WebSocket é só `ws/registry.js` (`sendTo`,
  `isConnected`). Não importe o servidor WS em módulo de domínio.
- **Nunca feche a conexão de um client desatualizado.** O 0.1.0 já instalado
  trata close como queda e reconecta com backoff de 1s — vira tempestade de
  conexões, cada uma consultando o Turso. Marque `ws.bloqueado = true` e deixe
  a conexão aberta e inerte.

## Banco de dados

- **Sempre parâmetros (`?`).** Nunca interpole valor em SQL.
- Escrita concorrente: `db.batch()` (transação) com a **guarda dentro de cada
  statement**. Ler-depois-escrever fora de transação já causou elo em dobro:
  ```sql
  UPDATE players SET elo = ... WHERE steamid = ?
    AND (SELECT status FROM lobbies WHERE code = ?) = 'pronto'
  ```
- O banco é compartilhado: tabela usada pelos dois projetos precisa de **DDL
  idêntica** aqui e em `lib/db.js` do site.
- Índice novo vai no schema **e** é aplicado no banco de produção — o
  `IF NOT EXISTS` só cria em banco novo.
- Confirme índice com `EXPLAIN QUERY PLAN`, não por suposição.
- `ANALYZE` não é permitido pela API do Turso — não tente.

## Comandos

```bash
npm run dev                               # node --watch com .env

node --env-file=.env test-flow.mjs        # pareamento, WS, versão, registro
node --env-file=.env test-live.mjs        # agregação do placar, varredura
node --env-file=.env test-abandonada.mjs  # redes de segurança
```

## Testes

Integração contra o sistema de verdade — **sem mocks, de propósito**.

- **Todo teste limpa o que criou**, em `finally`. Steamids falsos com prefixo
  `7656119800000000…`. Já houve jogador de teste vazando pro ranking.
- Use `process.exitCode`, **não** `process.exit()` — o exit mata o processo
  antes da limpeza rodar.
- **Reinicie o backend entre execuções da suíte.** O rate limit de pareamento
  (10/5min, em memória) faz a segunda rodada falhar. É o app funcionando.
- O `.env` aponta para **produção**. Diagnóstico pode; escrita, só com
  limpeza garantida.

## Logging

`log()` de `src/log.js`, nunca `console.log`. Logue **decisões e contagens**
(`START_MATCH #12 (lobby ABCDE): 4/5 clients online`), não ruído por evento.
Nunca logue token, cookie ou chave interna.

## Deploy

Render. **Site primeiro, backend depois** — o site publica o instalador e o
link; o backend é quem torna a atualização do client obrigatória.

Variável nova: atualize `.env.example` **e** `render.yaml` (`sync: false`).
Endpoint novo/alterado: atualize a tabela de rotas do `README.md`.

## Checklist antes de entregar

- [ ] 3 suítes passando (servidor reiniciado antes).
- [ ] Caminho novo sem cobertura: exercitado à mão.
- [ ] Nada órfão: export, import, arquivo temporário.
- [ ] Dados de teste removidos do banco de produção.
- [ ] `.env.example` / `render.yaml` / README atualizados se for o caso.
- [ ] Nenhum segredo em código, log ou saída.
