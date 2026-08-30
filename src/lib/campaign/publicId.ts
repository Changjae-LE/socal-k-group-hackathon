import { randomBytes } from "node:crypto";

// Unguessable, URL-safe public slug for a campaign. 9 bytes -> 12 base64url chars.
export function newPublicId(): string {
  return randomBytes(9).toString("base64url");
}

// Shape check for a value coming from the URL before it touches the DB.
const PUBLIC_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
export function isWellFormedPublicId(v: string): boolean {
  return PUBLIC_ID_RE.test(v);
}
