import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { authenticate } from "../worker/auth";
import {
  createPasswordHash,
  migratePasswordHash,
  parsePasswordHash,
  sha256,
  verifyPasswordProof,
} from "../shared/password";
import {
  derivePasswordProof,
  hex,
  PASSWORD_ITERATIONS,
} from "../shared/password-proof";
import { pbkdf2Sync } from "node:crypto";

const origin = "https://booxs.test";
const password = "Disposable-QA-password-2026";
let mf: Miniflare;
let db: D1Database;
let passwordHash: string;
let passwordProof: string;
let wrongProof: string;
const request = (
  path: string,
  body?: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) =>
  mf.dispatchFetch(origin + "/api" + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
async function login() {
  const result = await request("/auth/login", {
    email: "owner@example.com",
    passwordProof,
  });
  expect(result.status).toBe(200);
  return result.headers.get("Set-Cookie")!.split(";")[0];
}

beforeAll(async () => {
  passwordHash = await createPasswordHash(password);
  const parameters = {
    salt: parsePasswordHash(passwordHash)!.salt,
    iterations: PASSWORD_ITERATIONS,
  };
  passwordProof = await derivePasswordProof(password, parameters);
  wrongProof = await derivePasswordProof("wrong", parameters);
  const output = await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    external: ["node:*"],
    // Local workerd has no production PBKDF2 cap. Disable server-side derivation
    // entirely so a regression cannot silently pass locally and fail on Free.
    banner: {
      js: `crypto.subtle.deriveBits = () => { throw new DOMException("Server-side PBKDF2 is unavailable", "NotSupportedError"); };`,
    },
  });
  mf = new Miniflare({
    modules: true,
    script: output.outputFiles[0].text,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    bindings: {
      OWNER_EMAIL: "owner@example.com",
      OWNER_PASSWORD_HASH: passwordHash,
    },
  });
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  const sql =
    (await readFile("migrations/0001_books.sql", "utf8")) +
    (await readFile("migrations/0002_auth.sql", "utf8")) +
    "\n" +
    (await readFile("migrations/0003_book_details.sql", "utf8"));
  await db.batch(
    sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
});
beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM auth_sessions"),
    db.prepare("DELETE FROM auth_throttle"),
  ]);
});
afterAll(async () => {
  await mf?.dispose();
});

describe("private password sessions", () => {
  it("publishes only the salt and work factor without disclosing the verifier or owner", async () => {
    const response = await request("/auth/parameters");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const parameters = await response.json();
    expect(parameters).toEqual({
      salt: parsePasswordHash(passwordHash)!.salt,
      iterations: PASSWORD_ITERATIONS,
    });
    expect(
      await derivePasswordProof(
        password,
        parameters as { salt: string; iterations: number },
      ),
    ).toBe(passwordProof);
    // Every login in this suite runs with server-side deriveBits disabled.
    await login();
  });
  it("upgrades existing hashes without a password reset or server-side PBKDF2", async () => {
    const salt = "1234567890abcdef1234567890abcdef";
    const key = pbkdf2Sync(
      password,
      Buffer.from(salt, "hex"),
      600000,
      32,
      "sha256",
    ).toString("hex");
    const legacy = `pbkdf2-sha256$600000$${salt}$${key}`;
    const proof = await derivePasswordProof(password, {
      salt,
      iterations: PASSWORD_ITERATIONS,
    });
    expect(proof).toBe(key);
    const derive = vi
      .spyOn(crypto.subtle, "deriveBits")
      .mockRejectedValue(new Error("Production cap"));
    try {
      const migrated = await migratePasswordHash(legacy);
      expect(migrated).toMatch(/^pbkdf2-sha256-v2\$600000\$/);
      expect(migrated).not.toContain(key);
      expect(await verifyPasswordProof(proof, migrated)).toBe(true);
      expect(await verifyPasswordProof(wrongProof, migrated)).toBe(false);
      expect(await verifyPasswordProof(proof, legacy)).toBe(false);
      expect(await migratePasswordHash(migrated)).toBe(migrated);
      expect(derive).not.toHaveBeenCalled();
    } finally {
      derive.mockRestore();
    }
    await expect(migratePasswordHash("invalid")).rejects.toThrow("Invalid");
  });
  it("rejects the stored verifier as a login credential and rejects raw-password or malformed requests", async () => {
    const response = await request("/auth/login", {
      email: "owner@example.com",
      passwordProof: hex(parsePasswordHash(passwordHash)!.hash),
    });
    expect(response.status).toBe(401);
    for (const body of [
      { email: "owner@example.com", password },
      { email: "owner@example.com", passwordProof: "invalid" },
    ])
      expect((await request("/auth/login", body)).status).toBe(400);
    await login();
  });
  it("rejects changed browser work factors and malformed salts", async () => {
    for (const parameters of [
      { salt: "a".repeat(32), iterations: 1 },
      { salt: "a".repeat(32), iterations: 1_000_000_000 },
      { salt: "invalid", iterations: PASSWORD_ITERATIONS },
    ])
      await expect(derivePasswordProof(password, parameters)).rejects.toThrow(
        "settings",
      );
  });
  it("uses salted PBKDF2 hashes, validates passwords, and rejects short setup passwords", async () => {
    const another = await createPasswordHash(password);
    expect(another).not.toBe(passwordHash);
    expect(await verifyPasswordProof(passwordProof, passwordHash)).toBe(true);
    expect(await verifyPasswordProof(wrongProof, passwordHash)).toBe(false);
    expect(await verifyPasswordProof(passwordProof, "invalid")).toBe(false);
    await expect(createPasswordHash("short")).rejects.toThrow("16");
  });
  it("keeps private APIs closed until sign-in and gives the same error for wrong email or password", async () => {
    expect((await request("/books")).status).toBe(401);
    const wrongEmail = await request("/auth/login", {
      email: "other@example.com",
      passwordProof,
    });
    const wrongPassword = await request("/auth/login", {
      email: "owner@example.com",
      passwordProof: wrongProof,
    });
    expect(wrongEmail.status).toBe(401);
    expect(wrongPassword.status).toBe(401);
    expect(await wrongEmail.json()).toEqual(await wrongPassword.json());
  });
  it("sets a secure HttpOnly SameSite cookie and stores only a hash of its random token", async () => {
    const response = await request("/auth/login", {
      email: "OWNER@example.com",
      passwordProof,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const header = response.headers.get("Set-Cookie")!;
    for (const expected of [
      "__Host-booxs_session=",
      "HttpOnly",
      "Secure",
      "SameSite=Strict",
      "Path=/",
    ])
      expect(header).toContain(expected);
    const cookie = header.split(";")[0];
    const token = cookie.split("=")[1];
    const stored = await db
      .prepare("SELECT * FROM auth_sessions")
      .first<{ token_hash: string }>();
    expect(stored!.token_hash).toBe(await sha256(token));
    expect(stored!.token_hash).not.toBe(token);
    expect((await request("/books", undefined, cookie)).status).toBe(200);
  });
  it("rejects forged and expired sessions", async () => {
    expect(
      (
        await request(
          "/books",
          undefined,
          "__Host-booxs_session=" + "a".repeat(64),
        )
      ).status,
    ).toBe(401);
    const cookie = await login();
    await db.prepare("UPDATE auth_sessions SET expires_at = 0").run();
    expect((await request("/books", undefined, cookie)).status).toBe(401);
  });
  it("revokes sessions on logout, including a copied old cookie", async () => {
    const cookie = await login();
    const response = await request("/auth/logout", {}, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
    expect((await request("/books", undefined, cookie)).status).toBe(401);
  });
  it("rotates the current browser session on another sign-in", async () => {
    const old = await login();
    const response = await request(
      "/auth/login",
      { email: "owner@example.com", passwordProof },
      old,
    );
    const fresh = response.headers.get("Set-Cookie")!.split(";")[0];
    expect(fresh).not.toBe(old);
    expect((await request("/books", undefined, old)).status).toBe(401);
    expect((await request("/books", undefined, fresh)).status).toBe(200);
  });
  it("invalidates sessions when owner credentials change", async () => {
    const cookie = await login();
    const changed = {
      DB: db,
      OWNER_EMAIL: "owner@example.com",
      OWNER_PASSWORD_HASH: await createPasswordHash(
        "Another-disposable-password",
      ),
    };
    expect(
      (
        await authenticate(
          new Request(origin + "/api/books", { headers: { Cookie: cookie } }),
          changed,
        )
      )?.status,
    ).toBe(401);
  });
  it("atomically limits distributed guesses and resets the fixed window", async () => {
    for (let i = 0; i < 5; i++)
      expect(
        (
          await request("/auth/login", {
            email: "owner@example.com",
            passwordProof: wrongProof,
          })
        ).status,
      ).toBe(401);
    const response = await request("/auth/login", {
      email: "owner@example.com",
      passwordProof,
    });
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    await db.prepare("UPDATE auth_throttle SET reset_at = 0").run();
    expect(
      (
        await request("/auth/login", {
          email: "owner@example.com",
          passwordProof,
        })
      ).status,
    ).toBe(200);
  });
  it("rejects cross-origin and missing-origin writes and oversized sign-in bodies", async () => {
    const cookie = await login();
    for (const Origin of ["https://attacker.test", "null", ""]) {
      expect(
        (
          await request(
            "/auth/login",
            { email: "owner@example.com", passwordProof },
            undefined,
            { Origin },
          )
        ).status,
      ).toBe(403);
      expect(
        (await request("/auth/logout", {}, cookie, { Origin })).status,
      ).toBe(403);
    }
    expect(
      (
        await request("/books", { title: "Not allowed" }, cookie, {
          Origin: "https://attacker.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request("/auth/login", {
          email: "owner@example.com",
          passwordProof: "x".repeat(9000),
        })
      ).status,
    ).toBe(413);
    expect((await request("/books", undefined, cookie)).status).toBe(200);
  });
  it("requires configured credentials and only bypasses auth on an explicit local loopback environment", async () => {
    const fake = { DB: db, ENVIRONMENT: "local" };
    expect(
      await authenticate(new Request("http://localhost/api/books"), fake),
    ).toBeNull();
    expect(
      (await authenticate(new Request(origin + "/api/books"), fake))?.status,
    ).toBe(503);
    expect(
      (
        await authenticate(new Request("http://localhost/api/books"), {
          ...fake,
          OWNER_EMAIL: "owner@example.com",
          OWNER_PASSWORD_HASH: passwordHash,
        })
      )?.status,
    ).toBe(401);
  });
});
