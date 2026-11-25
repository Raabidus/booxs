import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api";
import hrbitov from "./fixtures/knihovny-hrbitov.json";

afterEach(() => vi.unstubAllGlobals());

const rejected = () =>
  Response.json(
    {
      error: "Knihovny.cz did not allow this lookup.",
      metadataFallback: "knihovny",
    },
    { status: 502 },
  );
const isbn = "9788027762132";
const book = {
  title: "Atomové šelmy. Hřbitov",
  author: "František Kotleta, Kristýna Sněgoňová",
  language: "Czech",
  publisher: "Dobrovský s.r.o.",
  published_year: 2026,
  isbn,
};

describe("browser Czech metadata fallback", () => {
  it("fills the exact edition after the production Worker rejection", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(rejected())
      .mockResolvedValueOnce(Response.json(hrbitov));
    vi.stubGlobal("fetch", fetch);
    expect(await api.metadata("978-80-277-6213-2")).toEqual({ book });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0][0]).toBe("/api/metadata/isbn?isbn=" + isbn);
    const [url, options] = fetch.mock.calls[1] as [URL, RequestInit];
    expect(url.origin).toBe("https://www.knihovny.cz");
    expect(url.searchParams.get("lookfor")).toBe(isbn);
    expect(options).toMatchObject({
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      headers: { Accept: "application/json" },
    });
    expect(Object.keys(options.headers || {})).toEqual(["Accept"]);
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves successful server lookups and confirmed misses", async () => {
    for (const value of [book, null]) {
      const fetch = vi.fn().mockResolvedValue(Response.json({ book: value }));
      vi.stubGlobal("fetch", fetch);
      expect(await api.metadata(isbn)).toEqual({ book: value });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("never falls back after authentication, authorization, configuration, or rate-limit errors", async () => {
    for (const status of [401, 403, 429, 503]) {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "Original error", metadataFallback: "knihovny" },
            { status },
          ),
        );
      vi.stubGlobal("fetch", fetch);
      await expect(api.metadata(isbn)).rejects.toMatchObject({
        status,
        message: "Original error",
      });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("requires an explicit server hint and never follows a supplied provider URL", async () => {
    for (const metadataFallback of [undefined, "https://other.example/api"]) {
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json(
            { error: "Original provider error", metadataFallback },
            { status: 502 },
          ),
        );
      vi.stubGlobal("fetch", fetch);
      await expect(api.metadata(isbn)).rejects.toThrow(
        "Original provider error",
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("does not enable Czech lookup for an unrelated ISBN", async () => {
    const fetch = vi.fn().mockResolvedValue(rejected());
    vi.stubGlobal("fetch", fetch);
    await expect(api.metadata("9780140328721")).rejects.toThrow(
      /did not allow/,
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects nearby editions rather than assigning the requested ISBN to them", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(rejected())
        .mockResolvedValueOnce(
          Response.json({
            status: "OK",
            records: [{ ...hrbitov.records[0], isbns: ["9788027762125"] }],
          }),
        ),
    );
    expect(await api.metadata(isbn)).toEqual({ book: null });
  });

  it("keeps browser network and provider failures recoverable without retry loops", async () => {
    for (const direct of [
      () => Promise.reject(new TypeError("CORS or offline")),
      () => Promise.resolve(new Response("", { status: 418 })),
      () => Promise.resolve(new Response("", { status: 429 })),
      () => Promise.resolve(new Response("not JSON")),
      () => Promise.resolve(Response.json({ status: "ERROR" })),
    ]) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(rejected())
        .mockImplementationOnce(direct);
      vi.stubGlobal("fetch", fetch);
      await expect(api.metadata(isbn)).rejects.toThrow(/manually/);
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("does not treat catalog authentication errors as an expired Booxs session", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(rejected())
        .mockResolvedValueOnce(new Response("", { status: 401 })),
    );
    await expect(api.metadata(isbn)).rejects.toMatchObject({ status: 502 });
  });

  it("rejects invalid ISBNs before making any network request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(api.metadata("9788027762133")).rejects.toThrow(/checksum/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
