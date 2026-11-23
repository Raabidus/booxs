import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthEnv {
  ENVIRONMENT?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  OWNER_EMAIL?: string;
}

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function authenticate(
  request: Request,
  env: AuthEnv,
): Promise<Response | null> {
  const url = new URL(request.url);
  // A deploy flag alone is never enough to enable the local developer identity.
  if (
    env.ENVIRONMENT === "local" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    return null;
  const domain = env.ACCESS_TEAM_DOMAIN?.replace(/\/$/, "");
  if (
    !domain ||
    !/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain) ||
    !env.ACCESS_AUD ||
    !env.OWNER_EMAIL
  ) {
    return Response.json(
      {
        error:
          "Private access is not configured. Complete the Cloudflare Access setup.",
      },
      { status: 503 },
    );
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token)
    return Response.json(
      { error: "Please sign in to your private library." },
      { status: 401 },
    );
  try {
    let keys = keysets.get(domain);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${domain}/cdn-cgi/access/certs`));
      keysets.set(domain, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer: domain,
      audience: env.ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "iat", "sub", "email"],
    });
    if (
      typeof payload.email !== "string" ||
      payload.email.toLowerCase() !== env.OWNER_EMAIL.trim().toLowerCase()
    ) {
      return Response.json(
        { error: "This library belongs to another account." },
        { status: 403 },
      );
    }
    return null;
  } catch {
    return Response.json(
      { error: "Your sign-in has expired. Please sign in again." },
      { status: 401 },
    );
  }
}
