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

dono registra o placar (status 'finalizado')
  └─▶ POST /internal/match/end ────▶ encerra live_match
                                  ──▶ END_MATCH ───────────────▶  volta ao modo espera
```

## Rotas

| Rota | Auth | Descrição |
|---|---|---|
| `POST /api/client/auth/pair` `{ code }` | rate limit 10/5min por IP | troca o código do site por `{ access_token, refresh_token }` |
| `POST /api/client/auth/refresh` `{ refresh_token }` | — | rotaciona o par de tokens (access expira em 1h; refresh em 90 dias) |
| `WS /ws/client` | `Authorization: Bearer <access>` (401 se expirado — o client renova sozinho) | conexão persistente do client |
| `POST /internal/match/start` `{ code }` | `X-Internal-Key` | site avisa que o veto terminou → `START_MATCH` pros 10 clients |
| `POST /internal/match/end` `{ code }` | `X-Internal-Key` | site avisa que o placar foi registrado → `END_MATCH` |
| `GET /internal/match/:id/state` | `X-Internal-Key` | estado ao vivo (último `STATE_SYNC` de cada jogador) |
| `GET /health` | — | liveness + nº de clients conectados |

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

## Próximos passos (não implementados)

- Preencher o placar do site automaticamente no `GAME_OVER` (hoje o dono ainda
  registra manualmente — o backend só grava os eventos).
- Mapear CT/T → time A/B usando os eventos `PLAYER_TEAM` pra montar scoreboard.
- Página de partida ao vivo no site consumindo `GET /internal/match/:id/state`
  (via rota proxy no Next, que guarda a chave interna).
