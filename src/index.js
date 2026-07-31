// index.js — ponto de entrada: sobe o servidor (HTTP + WebSocket) e agenda a
// varredura. As rotas ficam em http/routes.js e o protocolo do client em ws/.
//
//   POST /api/client/auth/pair      troca código de pareamento por tokens
//   POST /api/client/auth/refresh   rotaciona os tokens
//   GET  /api/client/version        versão atual do client + link do instalador
//   POST /internal/match/start      site avisa: veto terminou → START_MATCH
//   POST /internal/match/end        encerra a coleta da partida do lobby
//   GET  /internal/match/:id/state  placar/stats ao vivo (STATE_SYNC agregado)
//   GET  /internal/lobby/:code/state  idem, pelo código do lobby
//   POST /internal/sweep            roda a varredura na hora
//   GET  /health                    liveness
//   WS   /ws/client                 conexão persistente do Resenha Client
import http from 'http';
import { handleRequest } from './http/router.js';
import { attachWebSocket } from './ws/server.js';
import { encerrarPartidasAbandonadas } from './matches/index.js';
import { log } from './log.js';

const PORT = Number(process.env.PORT) || 4000;
const INTERVALO_VARREDURA_MS = 60 * 60 * 1000;

const server = http.createServer(handleRequest);
attachWebSocket(server);

server.listen(PORT, () => {
  log(`resenha-backend ouvindo em :${PORT} (REST + WS /ws/client)`);
});

// Rede de segurança: registra placar pendente, encerra coleta órfã e abandona
// partida velha. Roda no boot (toda acordada do plano free) e de hora em hora.
const varrer = () => encerrarPartidasAbandonadas().catch((e) => log('varredura falhou:', e.message));
varrer();
setInterval(varrer, INTERVALO_VARREDURA_MS).unref();
