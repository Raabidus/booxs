import { parsePasswordHash, sha256, verifyPassword } from "../shared/password";

export interface AuthEnv {
  DB: D1Database;
  ENVIRONMENT?: string;
  OWNER_EMAIL?: string;
  OWNER_PASSWORD_HASH?: string;
}

const SESSION_SECONDS = 30 * 24 * 60 * 60;
const LOGIN_LIMIT = 5;
const LOGIN_WINDOW = 60;
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export function isLocal(request: Request, env: AuthEnv): boolean {
  return (
    env.ENVIRONMENT === "local" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(new URL(request.url).hostname)
  );
}

function localBypass(request: Request, env: AuthEnv) {
  return isLocal(request, env) && !env.OWNER_PASSWORD_HASH;
}

export function sameOrigin(request: Request, env: AuthEnv): boolean {
  const origin = request.headers.get("Origin");
  if (origin === new URL(request.url).origin) return true;
  // Allow Vite's separate loopback port only in local development.
  if (origin && isLocal(request, env)) {
    try {
      return ["localhost", "127.0.0.1", "[::1]"].includes(
        new URL(origin).hostname,
      );
    } catch {
      /* Invalid origin. */
    }
  }
  return false;
}

function cookieName(request: Request, env: AuthEnv) {
  return isLocal(request, env) && new URL(request.url).protocol === "http:"
    ? "booxs_local_session"
    : "__Host-booxs_session";
}

function cookie(
  request: Request,
  env: AuthEnv,
  token: string,
  maxAge: number,
): string {
  const secure = cookieName(request, env).startsWith("__Host-")
    ? "; Secure"
    : "";
  return `${cookieName(request, env)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function readToken(request: Request, env: AuthEnv): string | null {
  const name = cookieName(request, env) + "=";
  const token = request.headers
    .get("Cookie")
    ?.split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith(name))
    ?.slice(name.length);
  return token && TOKEN_PATTERN.test(token) ? token : null;
}

function configured(env: AuthEnv): boolean {
  return (
    !!env.OWNER_EMAIL &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.OWNER_EMAIL) &&
    !!env.OWNER_PASSWORD_HASH &&
    !!parsePasswordHash(env.OWNER_PASSWORD_HASH)
  );
}

function setupRequired() {
  return Response.json(
    {
      error:
        "Private sign-in is not configured. Set OWNER_EMAIL and the OWNER_PASSWORD_HASH secret.",
    },
    { status: 503 },
  );
}

async function credentialVersion(env: AuthEnv) {
  return sha256(
    env.OWNER_EMAIL!.trim().toLowerCase() + ":" + env.OWNER_PASSWORD_HASH!,
  );
}

export async function authenticate(
  request: Request,
  env: AuthEnv,
): Promise<Response | null> {
  if (localBypass(request, env)) return null;
  if (!configured(env)) return setupRequired();
  const token = readToken(request, env);
  if (token) {
    const session = await env.DB.prepare(
      "SELECT token_hash FROM auth_sessions WHERE token_hash = ? AND credential_version = ? AND expires_at > ?",
    )
      .bind(
        await sha256(token),
        await credentialVersion(env),
        Math.floor(Date.now() / 1000),
      )
      .first();
    if (session) return null;
  }
  return Response.json(
    { error: "Sign in to open your private bookshelf." },
    { status: 401 },
  );
}

async function loginBody(
  request: Request,
): Promise<{ email: string; password: string } | Response> {
  if (
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return Response.json(
      { error: "Send your sign-in details as JSON." },
      { status: 415 },
    );
  const reader = request.body?.getReader();
  if (!reader)
    return Response.json(
      { error: "Enter your email and password." },
      { status: 400 },
    );
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    length += chunk.value.byteLength;
    if (length > 8192) {
      await reader.cancel();
      return Response.json(
        { error: "Sign-in details are too long." },
        { status: 413 },
      );
    }
    chunks.push(chunk.value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  let data: { email?: unknown; password?: unknown };
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return Response.json(
      { error: "Invalid sign-in details." },
      { status: 400 },
    );
  }
  if (
    !data ||
    typeof data.email !== "string" ||
    typeof data.password !== "string" ||
    !data.email.trim() ||
    data.email.length > 254 ||
    !data.password ||
    data.password.length > 1024
  )
    return Response.json(
      { error: "Enter your email and password." },
      { status: 400 },
    );
  return { email: data.email.trim().toLowerCase(), password: data.password };
}

export async function authRoute(
  request: Request,
  env: AuthEnv,
): Promise<Response> {
  if (request.method !== "POST")
    return Response.json({ error: "Method not allowed." }, { status: 405 });
  if (!sameOrigin(request, env))
    return Response.json(
      { error: "Cross-origin sign-in changes are not allowed." },
      { status: 403 },
    );
  const path = new URL(request.url).pathname;
  if (path === "/api/auth/logout") {
    const token = readToken(request, env);
    if (token)
      await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
        .bind(await sha256(token))
        .run();
    return Response.json(
      { authenticated: false },
      { headers: { "Set-Cookie": cookie(request, env, "", 0) } },
    );
  }
  if (path !== "/api/auth/login")
    return Response.json({ error: "Endpoint not found." }, { status: 404 });
  if (!isLocal(request, env) && new URL(request.url).protocol !== "https:")
    return Response.json({ error: "Sign-in requires HTTPS." }, { status: 400 });
  if (localBypass(request, env))
    return Response.json({ authenticated: true, local: true });
  if (!configured(env)) return setupRequired();
  const data = await loginBody(request);
  if (data instanceof Response) return data;
  const now = Math.floor(Date.now() / 1000);
  // One fixed owner means a global, atomic D1 counter limits distributed guesses
  // without keeping IP addresses. A successful login also consumes an attempt.
  const throttle = await env.DB.prepare(
    `INSERT INTO auth_throttle (id, attempts, reset_at) VALUES ('owner', 1, ?)
    ON CONFLICT(id) DO UPDATE SET attempts = CASE WHEN reset_at <= ? THEN 1 ELSE attempts + 1 END,
    reset_at = CASE WHEN reset_at <= ? THEN ? ELSE reset_at END RETURNING attempts, reset_at`,
  )
    .bind(now + LOGIN_WINDOW, now, now, now + LOGIN_WINDOW)
    .first<{ attempts: number; reset_at: number }>();
  if (!throttle || throttle.attempts > LOGIN_LIMIT)
    return Response.json(
      { error: "Too many sign-in attempts. Wait a minute and try again." },
      {
        status: 429,
        headers: {
          "Retry-After": String(
            Math.max(1, (throttle?.reset_at || now + LOGIN_WINDOW) - now),
          ),
        },
      },
    );
  const valid = await verifyPassword(data.password, env.OWNER_PASSWORD_HASH!);
  if (!valid || data.email !== env.OWNER_EMAIL!.trim().toLowerCase())
    return Response.json(
      { error: "Email or password is incorrect." },
      { status: 401 },
    );
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  // Retire this browser's old session on login, then prune expired sessions.
  const oldToken = readToken(request, env);
  if (oldToken)
    await env.DB.prepare("DELETE FROM auth_sessions WHERE token_hash = ?")
      .bind(await sha256(oldToken))
      .run();
  await env.DB.prepare("DELETE FROM auth_sessions WHERE expires_at <= ?")
    .bind(now)
    .run();
  await env.DB.prepare(
    "INSERT INTO auth_sessions (token_hash, credential_version, expires_at) VALUES (?, ?, ?)",
  )
    .bind(
      await sha256(token),
      await credentialVersion(env),
      now + SESSION_SECONDS,
    )
    .run();
  return Response.json(
    { authenticated: true },
    { headers: { "Set-Cookie": cookie(request, env, token, SESSION_SECONDS) } },
  );
}
