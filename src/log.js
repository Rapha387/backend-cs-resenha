// log.js — log simples com timestamp (stdout; quem roda em produção
// redireciona pra onde quiser: journald, PM2, Docker…)
export function log(...args) {
  console.log(new Date().toISOString(), '—', ...args);
}
