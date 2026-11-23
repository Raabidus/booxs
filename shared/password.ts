import { timingSafeEqual } from "node:crypto";

export const PASSWORD_ITERATIONS = 600_000;
const encoder = new TextEncoder();
const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));

export function parsePasswordHash(value: string) {
  const match = /^pbkdf2-sha256\$600000\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(
    value,
  );
  return match ? { salt: unhex(match[1]), hash: unhex(match[2]) } : null;
}

async function derive(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: salt as BufferSource,
        iterations: PASSWORD_ITERATIONS,
      },
      key,
      256,
    ),
  );
}

export async function createPasswordHash(password: string): Promise<string> {
  if (password.length < 16 || password.length > 1024)
    throw new Error("Use a password or passphrase with 16–1024 characters.");
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${hex(salt)}$${hex(await derive(password, salt))}`;
}

export async function verifyPassword(
  password: string,
  value: string,
): Promise<boolean> {
  const parsed = parsePasswordHash(value);
  if (!parsed || password.length > 1024) return false;
  return timingSafeEqual(await derive(password, parsed.salt), parsed.hash);
}

export async function sha256(value: string): Promise<string> {
  return hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}
