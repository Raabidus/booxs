import { timingSafeEqual } from "node:crypto";
import {
  derivePasswordProof,
  hex,
  unhex,
  PASSWORD_ITERATIONS,
  PROOF_PATTERN,
} from "./password-proof.ts";

const encoder = new TextEncoder();

export function parsePasswordHash(value: string) {
  const match =
    /^pbkdf2-sha256(-v2)?\$600000\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(value);
  return match
    ? { version: match[1] ? 2 : 1, salt: match[2], hash: unhex(match[3]) }
    : null;
}

async function proofVerifier(proof: string) {
  return sha256("booxs-password-verifier-v2:" + proof);
}

// Convert the old deployment setting without knowing or resetting the password.
// Only the verifier is uploaded; the password-equivalent proof stays secret.
export async function migratePasswordHash(value: string): Promise<string> {
  const parsed = parsePasswordHash(value);
  if (!parsed) throw new Error("Invalid password hash.");
  if (parsed.version === 2) return value;
  return `pbkdf2-sha256-v2$${PASSWORD_ITERATIONS}$${parsed.salt}$${await proofVerifier(hex(parsed.hash))}`;
}

export async function createPasswordHash(password: string): Promise<string> {
  if (password.length < 16 || password.length > 1024)
    throw new Error("Use a password or passphrase with 16–1024 characters.");
  const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
  const proof = await derivePasswordProof(password, {
    salt,
    iterations: PASSWORD_ITERATIONS,
  });
  return `pbkdf2-sha256-v2$${PASSWORD_ITERATIONS}$${salt}$${await proofVerifier(proof)}`;
}

export async function verifyPasswordProof(
  proof: string,
  value: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(value);
  if (!parsed || parsed.version !== 2 || !PROOF_PATTERN.test(proof))
    return false;
  return timingSafeEqual(unhex(await proofVerifier(proof)), parsed.hash);
}

export async function sha256(value: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
