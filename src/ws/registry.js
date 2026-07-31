// ws/registry.js — quem está conectado agora. É a única parte que o resto do
// sistema (matches/) precisa conhecer do WebSocket: "manda isso pra fulano" e
// "o client de fulano está de pé?".
const clients = new Map(); // steamid -> Set<ws>
const lastSeen = new Map(); // steamid -> última atividade (ms)

// Uma reconexão (backend reiniciando, wi-fi oscilando, PC saindo do sono) leva
// alguns segundos — o client refaz o handshake com backoff a partir de 1s.
// Sem tolerância, cada soluço desses anunciava "Resenha Client fechado" pra
// sala inteira de uma vez, mesmo com todo mundo jogando: o aviso existe pra
// quem esqueceu de abrir o app, não pra piscar a cada reconexão.
const TOLERANCIA_MS = 45_000;

export function registrar(steamid, ws) {
  if (!clients.has(steamid)) clients.set(steamid, new Set());
  clients.get(steamid).add(ws);
  lastSeen.set(steamid, Date.now());
}

export function remover(steamid, ws) {
  const set = clients.get(steamid);
  set?.delete(ws);
  if (set?.size === 0) clients.delete(steamid);
  lastSeen.set(steamid, Date.now()); // começa a contar a tolerância
}

/** Marca atividade — só de conexão que não está bloqueada por versão. */
export function marcarAtividade(steamid, ws) {
  if (!ws.bloqueado) lastSeen.set(steamid, Date.now());
}

export function esquecer(steamid) {
  lastSeen.delete(steamid);
}

/** Todas as conexões abertas (pra heartbeat). */
export function* conexoes() {
  for (const set of clients.values()) for (const ws of set) yield ws;
}

/** Envia um objeto pra todas as conexões ATIVAS de um jogador. Retorna quantas. */
export function sendTo(steamid, obj) {
  const sockets = clients.get(steamid);
  if (!sockets || sockets.size === 0) return 0;
  const payload = JSON.stringify(obj);
  let sent = 0;
  for (const ws of sockets) {
    // Conexão bloqueada por versão nunca recebe comando (START_MATCH etc.).
    if (ws.readyState === ws.OPEN && !ws.bloqueado) {
      ws.send(payload);
      sent++;
    }
  }
  return sent;
}

export function connectedCount() {
  let n = 0;
  for (const set of clients.values()) n += set.size;
  return n;
}

/**
 * O Resenha Client desse jogador está de pé? Conta como sim durante uma
 * reconexão curta (ver TOLERANCIA_MS) — a coleta não se perde nesse intervalo,
 * o client reenvia o estado assim que volta. Client bloqueado por versão NÃO
 * conta: ele realmente não vai registrar nada, e o site precisa avisar isso.
 */
export function isConnected(steamid) {
  const set = clients.get(steamid);
  if (set) for (const ws of set) if (ws.readyState === ws.OPEN && !ws.bloqueado) return true;
  const ultimaVez = lastSeen.get(steamid);
  return ultimaVez !== undefined && Date.now() - ultimaVez < TOLERANCIA_MS;
}

/** Passada a tolerância de quem já desconectou, a entrada não muda mais nada. */
export function limparLastSeen() {
  const limite = Date.now() - TOLERANCIA_MS;
  for (const [steamid, quando] of lastSeen) {
    if (quando < limite && !clients.has(steamid)) lastSeen.delete(steamid);
  }
}
