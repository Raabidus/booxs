import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { authenticate } from "../worker/auth";

const env = {
  ACCESS_TEAM_DOMAIN: "https://booxs-auth-test.cloudflareaccess.com",
  ACCESS_AUD: "test-aud",
  OWNER_EMAIL: "owner@example.com",
};
let privateKey: CryptoKey;
beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  const key = {
    ...(await exportJWK(pair.publicKey)),
    alg: "RS256",
    use: "sig",
    kid: "test-key",
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      if (String(url) !== env.ACCESS_TEAM_DOMAIN + "/cdn-cgi/access/certs")
        throw new Error("Unexpected network request");
      return Response.json({ keys: [key] });
    }),
  );
});
afterAll(() => vi.unstubAllGlobals());

async function token(
  email = "owner@example.com",
  audience = "test-aud",
  expiration = "1h",
) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(env.ACCESS_TEAM_DOMAIN)
    .setAudience(audience)
    .setSubject("owner-id")
    .setIssuedAt()
    .setExpirationTime(expiration)
    .sign(privateKey);
}
const request = (jwt: string) =>
  new Request("https://booxs.example/api/books", {
    headers: { "Cf-Access-Jwt-Assertion": jwt },
  });

describe("Access token validation", () => {
  it("accepts only a signed token for the configured owner and application", async () => {
    expect(await authenticate(request(await token()), env)).toBeNull();
    expect(
      (await authenticate(request(await token("other@example.com")), env))
        ?.status,
    ).toBe(403);
    expect(
      (
        await authenticate(
          request(await token("owner@example.com", "other-app")),
          env,
        )
      )?.status,
    ).toBe(401);
  });
  it("rejects expired tokens and signatures made with another key", async () => {
    expect(
      (
        await authenticate(
          request(await token("owner@example.com", "test-aud", "-1h")),
          env,
        )
      )?.status,
    ).toBe(401);
    const attacker = await generateKeyPair("RS256");
    const forged = await new SignJWT({ email: env.OWNER_EMAIL })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(env.ACCESS_TEAM_DOMAIN)
      .setAudience(env.ACCESS_AUD)
      .setSubject("owner")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(attacker.privateKey);
    expect((await authenticate(request(forged), env))?.status).toBe(401);
  });
  it("never trusts a local bypass on a production hostname", async () => {
    expect(
      (
        await authenticate(new Request("https://booxs.example/api/books"), {
          ENVIRONMENT: "local",
        })
      )?.status,
    ).toBe(503);
    expect(
      await authenticate(new Request("http://localhost/api/books"), {
        ENVIRONMENT: "local",
      }),
    ).toBeNull();
    expect(
      (await authenticate(new Request("http://localhost/api/books"), {}))
        ?.status,
    ).toBe(503);
  });
});
