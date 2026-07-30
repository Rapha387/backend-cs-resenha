# Resenha Backend

Servidor dedicado da plataforma Resenha: autentica o **Resenha Client**
(app desktop), mantém as conexões **WebSocket** e gerencia o ciclo de vida das
partidas (`START_MATCH` / `END_MATCH`), gravando os eventos do CS2 enviados
pelos clients.

Usa o **mesmo banco Turso do site** — é lá que estão os lobbies, jogadores e
os códigos de pareamento gerados no perfil.

> Precisa de um processo persistente (WebSocket não funciona em serverless):
> Railway, Fly.io, Render, VPS… **não** dá pra hospedar na Vercel.

## Rodar

```
npm install
cp .env.example .env    # preencha (mesmo Turso do site + INTERNAL_API_KEY)
npm run dev             # desenvolvimento (recarrega sozinho)
npm start               # produção
```

No **site** (Vercel), configure:

| Variável | Valor |
|---|---|
| `BACKEND_URL` | endereço público deste servidor (ex.: `https://backend.resenha.gg`) |
| `BACKEND_INTERNAL_KEY` | o mesmo valor de `INTERNAL_API_KEY` daqui |

No **Resenha Client**, aponte o servidor (Avançado → Servidor) pra mesma URL.

## Fluxo completo

```
site (Steam login)                    backend                    Resenha Client
──────────────────                    ───────                    ──────────────
perfil → gera código  ──────────────────────────────────────▶  usuário digita código
        (client_pair_codes)   ◀── POST /api/client/auth/pair ──  
                              ─── { access, refresh } ────────▶  salva tokens
                              ◀━━━━━━ WS /ws/client ━━━━━━━━━▶  conectado (HELLO → resync)

veto termina (status 'pronto')
  └─▶ POST /internal/match/start ──▶ cria live_match
                                  ──▶ START_MATCH { matchId } ─▶  liga a coleta GSI
                                  ◀── eventos da partida ───────  (rounds, kills, bomba…)
                                      grava em match_events

GAME_OVER chega do CS2 ──▶ registro automático do placar:
                             elo/W-L nos players, histórico em matches,
                             lobby vira 'finalizado', encerra live_match
                          ──▶ END_MATCH ──────────────────────▶  volta ao modo espera
```

## Rotas

| Rota | Auth | Descrição |
|---|---|---|
| `POST /api/client/auth/pair` `{ code }` | rate limit 10/5min por IP | troca o código do site por `{ access_token, refresh_token }` |
| `POST /api/client/auth/refresh` `{ refresh_token }` | — | rotaciona o par de tokens (access expira em 1h; refresh em 90 dias) |
| `WS /ws/client` | `Authorization: Bearer <access>` (401 se expirado — o client renova sozinho) | conexão persistente do client |
| `POST /internal/match/start` `{ code }` | `X-Internal-Key` | site avisa que o veto terminou → `START_MATCH` pros 10 clients |
| `POST /internal/match/end` `{ code }` | `X-Internal-Key` | encerra a coleta manualmente → `END_MATCH` (normalmente o registro automático faz isso sozinho) |
| `GET /internal/match/:id/state` | `X-Internal-Key` | estado ao vivo agregado (placar já traduzido pros times A/B + K/D/A por jogador) |
| `GET /internal/lobby/:code/state` | `X-Internal-Key` | igual ao anterior, mas pelo código do lobby (é o que o site usa) |
| `POST /internal/sweep` | `X-Internal-Key` | encerra partidas abandonadas na hora (roda sozinho de hora em hora) |
| `GET /api/client/version` | — | versão atual do client + link do instalador |
| `GET /health` | — | liveness + nº de clients conectados |

## Versão do Resenha Client

O backend é a **fonte de verdade** da versão. Client mais antigo que
`CLIENT_LATEST_VERSION` recebe `UPDATE_REQUIRED` no HELLO, tem a conexão
encerrada e **não coleta nada** até o usuário instalar a versão nova (a UI do
app trava numa tela de atualização). Isso garante que ninguém fica jogando com
um client que grava evento em formato antigo.

Pra lançar uma versão:

```bash
cd ../resenha-client && node release.mjs 0.3.0   # bump + build + copia pro site
```

Depois suba `CLIENT_LATEST_VERSION=0.3.0` no Render e faça deploy do site (que
serve o instalador em `/client/ResenhaClient-setup.exe`). A ordem importa:
**site primeiro** (pro link novo existir), backend depois (é ele que torna a
atualização obrigatória).

## Garantias implementadas (contrato do client)

- **Resync no HELLO**: toda conexão recebe o estado atual (`START_MATCH` se o
  jogador tem partida ativa, `END_MATCH` se não) — client que reiniciou ou
  perdeu um `END_MATCH` offline se corrige sozinho.
- **Evento com `matchId` errado** → não grava; responde com resync.
- **Pareamento é corrida-segura**: `UPDATE ... WHERE used = 0` garante que o
  código só é usado uma vez, mesmo com dois pedidos simultâneos.
- **Idempotência**: `match/start` e `match/end` repetidos não criam partida
  duplicada nem quebram.
- **Heartbeat WS** a cada 30s derruba conexões mortas.

## Tabelas criadas por este serviço (no Turso do site)

- `client_sessions` — tokens do client (opacos, rotacionados; apagar a linha = revogar)
- `live_matches` — partidas em andamento (`id` é o `matchId` do client)
- `match_events` — eventos crus (`ROUND_END`, `PLAYER_KILL`, `STATE_SYNC`…)

## Placar ao vivo

`liveState()` junta o último `STATE_SYNC` de cada jogador com os times do
lobby e **traduz o placar CT/T do CS2 pros times A/B da plataforma**. Como os
lados trocam no halftime, o lado de cada time é descoberto por voto da maioria
dos `player.team` que os próprios clients reportam — se ninguém reportou (ou
deu empate), `score_a`/`score_b` vêm `null` e o site mostra "esperando dados".

O site consome via proxy (`GET /api/lobby/:code/live`, que valida se você está
no lobby e guarda a chave interna no servidor).

## Testes

```
node --env-file=.env test-flow.mjs        # pareamento, tokens, WS, START/END_MATCH
node --env-file=.env test-live.mjs        # agregação do placar, inclusive troca de lado
node --env-file=.env test-abandonada.mjs  # rede de segurança contra END_MATCH perdido
```

Todos usam steamids falsos (`7656119800000000…`) e limpam tudo no final.

## Rede de segurança: a varredura

Sem ela, uma partida cujo fim nunca foi detectado (ninguém com o client
aberto, empate sem replay, erro transitório no registro) ficaria `ativa` pra
sempre e os clients continuariam coletando — inclusive em Premier/Casual,
exatamente o que a plataforma promete não monitorar. A varredura roda no boot
(toda acordada do plano free) e de hora em hora, em três passos:

- **retry do registro automático**: partida ativa de lobby `pronto` que já
  terminou → registra o placar (elo, histórico, lobby `finalizado`);
- **END_MATCH perdido**: partida ativa de lobby já `finalizado` → encerra a
  coleta e avisa os clients;
- **abandono após 4h**: partida sem fim detectável → vira `abandonada`, o
  lobby fecha junto (status `abandonado`, sem elo) e os clients recebem
  `END_MATCH`. Partidas velhas também são ignoradas no resync e nos eventos.

`POST /internal/sweep` roda a varredura na hora (usado pelos testes).

## Próximos passos (não implementados)

- Registrar o placar sozinho no `GAME_OVER`: hoje o site **sugere** o placar
  detectado e o dono confirma com um clique (o elo só muda no clique, de
  propósito — evita mexer no ranking de todo mundo por um evento perdido).
- Histórico round a round (os eventos já estão em `match_events`).
