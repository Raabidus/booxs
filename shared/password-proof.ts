export const PASSWORD_ITERATIONS = 600_000;
export const PROOF_PATTERN = /^[a-f0-9]{64}$/;
export const SALT_PATTERN = /^[a-f0-9]{32}$/;

export interface PasswordParameters {
  salt: string;
  iterations: number;
}

export const hex = (bytes: Uint8Array) =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
export const unhex = (value: string) =>
  Uint8Array.from(value.match(/../g)!, (byte) => Number.parseInt(byte, 16));

// Run the slow KDF on the device. Workers Free cannot perform 600k PBKDF2
// iterations in production, even though local workerd permits it.
export async function derivePasswordProof(
  password: string,
  parameters: PasswordParameters,
): Promise<string> {
  if (
    parameters.iterations !== PASSWORD_ITERATIONS ||
    !SALT_PATTERN.test(parameters.salt) ||
    !password ||
    password.length > 1024
  )
    throw new Error("Invalid password or sign-in settings.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return hex(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: unhex(parameters.salt) as BufferSource,
          iterations: parameters.iterations,
        },
        key,
        256,
      ),
    ),
  );
}
