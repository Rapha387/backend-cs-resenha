// ratelimit.js — limitador simples em memória por IP. Protege o pareamento
// contra brute force de códigos (32^6 combinações, TTL 5 min: com limite por
// IP o ataque é impraticável).
const buckets = new Map(); // ip -> { count, reset }

export function rateLimit(ip, { max = 10, windowMs = 5 * 60 * 1000 } = {}) {
  const now = Date.now();
  let bucket = buckets.get(ip);
  if (!bucket || bucket.reset < now) {
    bucket = { count: 0, reset: now + windowMs };
    buckets.set(ip, bucket);
  }
  bucket.count++;

  // Limpeza ocasional pra não crescer pra sempre
  if (buckets.size > 10000) {
    for (const [key, b] of buckets) if (b.reset < now) buckets.delete(key);
  }

  return bucket.count <= max;
}
