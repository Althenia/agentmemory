import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function createPkceChallenge(): { verifier: string; challenge: string } {
  const verifier = randomUrlToken(32);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function createOAuthState(): string {
  return randomUrlToken(32);
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
