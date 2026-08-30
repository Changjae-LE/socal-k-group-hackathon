import { randomInt } from "node:crypto";

/**
 * Pick `n` distinct items uniformly at random from `pool`.
 *
 * Cryptographically secure — uses `node:crypto.randomInt` (CSPRNG bytes + rejection
 * sampling, so no modulo bias). **`Math.random()` is never used in winner selection.**
 *
 * Partial Fisher–Yates: shuffle only the first `k` positions, then take them.
 */
export function selectWinners<T>(pool: readonly T[], n: number): T[] {
  const a = pool.slice(); // copy — never mutate the caller's array
  const k = Math.min(Math.max(0, Math.trunc(n)), a.length);
  for (let i = 0; i < k; i++) {
    const j = randomInt(i, a.length); // uniform in [i, a.length)
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a.slice(0, k);
}
