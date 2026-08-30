// AES-256-GCM for small secrets at rest (the SodaGift voucher URL in Reward.rewardUrlEnc).
// Output layout: base64( iv(12) || ciphertext || authTag(16) ). Server-only; never logs.

import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { env } from "@/lib/env";

function key(): Buffer {
  // env() guarantees >= 32 bytes; AES-256 needs exactly 32.
  return Buffer.from(env().TOKEN_ENCRYPTION_KEY, "base64").subarray(0, 32);
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

export function decryptSecret(blob: string): string {
  const buf = Buffer.from(blob, "base64");
  if (buf.length < 12 + 16) throw new Error("secretbox: ciphertext too short");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(12, buf.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
