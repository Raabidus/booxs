import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type { Book } from "../shared/books";

let mf: Miniflare;
let script: string;
const request = (
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) =>
  mf.dispatchFetch("http://localhost/api" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: "http://localhost",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const sample = {
  title: "  Matilda  ",
  author: "Roald Dahl",
  isbn: "0140328726",
  ownership: "want_to_buy",
  reading: "finished",
};

beforeAll(async () => {
  const output = await build({
    entryPoints: ["worker/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    target: "es2022",
    external: ["node:*"],
  });
  script = output.outputFiles[0].text;
  mf = new Miniflare({
    modules: true,
    script,
    compatibilityDate: "2026-07-30",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    bindings: { ENVIRONMENT: "local" },
  });
  const db = await mf.getD1Database("DB");
  const sql =
    (await readFile("migrations/0001_books.sql", "utf8")) +
    "\n" +
    (await readFile("migrations/0002_auth.sql", "utf8"));
  await db.batch(
    sql
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => db.prepare(s)),
  );
});
afterAll(async () => {
  await mf?.dispose();
});

describe("Worker API with real D1", () => {
  let book: Book;
  it("creates and retrieves a normalized book and a full snapshot", async () => {
    const response = await request("/books", "POST", sample);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    book = (await response.json()) as Book;
    expect(book).toMatchObject({
      title: "Matilda",
      isbn: "9780140328721",
      ownership: "want_to_buy",
      reading: "finished",
    });
    const found = await request("/books/isbn?isbn=0-14-032872-6");
    expect(await found.json()).toEqual({ book });
    const list = await request("/books");
    expect(await list.json()).toMatchObject({ books: [book] });
  });
  it("returns the existing record when ISBN-10 and ISBN-13 collide", async () => {
    const response = await request("/books", "POST", {
      ...sample,
      isbn: "9780140328721",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ book: { id: book.id } });
  });
  it("updates states independently, reads details, and rejects invalid input", async () => {
    const response = await request("/books/" + book.id, "PATCH", {
      ...sample,
      ownership: "owned",
      reading: "reading",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ownership: "owned",
      reading: "reading",
    });
    expect((await request("/books/" + book.id)).status).toBe(200);
    expect(
      (
        await request("/books", "POST", {
          ...sample,
          reading: ["reading", "finished"],
        })
      ).status,
    ).toBe(422);
    expect(
      (await request("/books", "POST", { ...sample, isbn: "9780140328722" }))
        .status,
    ).toBe(422);
    expect((await request("/books", "POST", { title: "  " })).status).toBe(422);
  });
  it("allows several manually entered books without ISBNs", async () => {
    for (const title of ["No ISBN one", "No ISBN two"])
      expect((await request("/books", "POST", { title })).status).toBe(201);
  });
  it("rejects cross-origin writes and a production hostname with the local flag", async () => {
    expect(
      (
        await request("/books", "POST", sample, {
          Origin: "https://attacker.example",
        })
      ).status,
    ).toBe(403);
    const response = await mf.dispatchFetch(
      "https://booxs.example.workers.dev/api/books",
    );
    expect(response.status).toBe(503);
  });
  it("fails closed for missing and forged session cookies", async () => {
    const production = new Miniflare({
      modules: true,
      script,
      compatibilityDate: "2026-07-30",
      compatibilityFlags: ["nodejs_compat"],
      bindings: {
        OWNER_PASSWORD_HASH:
          "pbkdf2-sha256$600000$" + "0".repeat(32) + "$" + "0".repeat(64),
        OWNER_EMAIL: "test@example.com",
      },
    });
    try {
      expect(
        (await production.dispatchFetch("https://booxs.test/api/books")).status,
      ).toBe(401);
      expect(
        (
          await production.dispatchFetch("https://booxs.test/api/books", {
            headers: { Cookie: "__Host-booxs_session=forged-token" },
          })
        ).status,
      ).toBe(401);
    } finally {
      await production.dispose();
    }
  });
  it("deletes a book and does not return it in future snapshots", async () => {
    expect((await request("/books/" + book.id, "DELETE")).status).toBe(200);
    expect((await request("/books/" + book.id)).status).toBe(404);
    expect(
      await (await request("/books/isbn?isbn=9780140328721")).json(),
    ).toEqual({ book: null });
    expect((await request("/books/" + book.id, "DELETE")).status).toBe(404);
  });
});
