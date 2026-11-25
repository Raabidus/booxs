import { afterEach, describe, expect, it, vi } from "vitest";
import {
  lookupMetadata,
  ProviderError,
  searchMetadata,
} from "../worker/metadata";
import czechEdition from "./fixtures/knihovny.json";
import hrbitovEdition from "./fixtures/knihovny-hrbitov.json";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("optional metadata enrichment", () => {
  it("reads details for the exact edition and identifies the app", async () => {
    const fetch = vi.fn(async (_url: URL, _options: RequestInit) =>
      Response.json({
        "ISBN:9780140328721": {
          details: {
            title: "Matilda",
            authors: [{ name: "Roald Dahl" }],
            publish_date: "October 1988",
            languages: [{ key: "/languages/eng" }],
            publishers: ["Puffin"],
          },
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await lookupMetadata("9780140328721", "owner@example.com")).toEqual({
      title: "Matilda",
      author: "Roald Dahl",
      language: "English",
      publisher: "Puffin",
      isbn: "9780140328721",
      published_year: 1988,
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": expect.stringContaining("owner@example.com"),
        }),
        signal: expect.any(AbortSignal),
      }),
    );
    expect(fetch.mock.calls[0][0].searchParams.get("jscmd")).toBe("details");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("keeps edition metadata with missing optional fields and multiple languages/publishers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          "ISBN:9788027762125": {
            details: {
              title: "Atomové šelmy: Aréna",
              languages: [{ key: "/languages/cze" }, { key: "/languages/slo" }],
              publishers: ["Fobos", "Dobrovský"],
            },
          },
        }),
      ),
    );
    expect(await lookupMetadata("9788027762125", "")).toMatchObject({
      language: "Czech, Slovak",
      publisher: "Fobos, Dobrovský",
      author: null,
      published_year: null,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          "ISBN:9788027762125": { details: { title: "A book" } },
        }),
      ),
    );
    expect(await lookupMetadata("9788027762125", "")).toMatchObject({
      language: null,
      publisher: null,
    });
  });
  it("returns a normal miss when an ISBN is absent", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({})),
    );
    expect(await lookupMetadata("9780140328721", "")).toBeNull();
  });
  it("does not assign a random edition ISBN or year to work-level search results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          docs: [
            {
              title: "Matilda",
              author_name: ["Roald Dahl"],
              first_publish_year: 1988,
              isbn: ["9780140328721"],
            },
          ],
        }),
      ),
    );
    expect(await searchMetadata("Matilda", "")).toEqual([
      {
        title: "Matilda",
        author: "Roald Dahl",
        language: null,
        publisher: null,
        isbn: null,
        published_year: null,
      },
    ]);
  });
  it("turns provider throttling, malformed JSON, and network failure into recoverable errors", async () => {
    for (const fn of [
      async () => new Response("", { status: 429 }),
      async () => new Response("bad-json"),
      async () => {
        throw new Error("Network unavailable");
      },
    ]) {
      vi.stubGlobal("fetch", vi.fn(fn));
      await expect(lookupMetadata("9780140328721", "")).rejects.toThrow(
        /manually/,
      );
    }
  });
});

describe("Czech ISBN fallback", () => {
  const isbn = "9788027762125";

  it("fills all five fields from a real Knihovny.cz response after an Open Library miss", async () => {
    // Fixture contains only the requested bibliographic fields from the public
    // /api/v1/search?lookfor=9788027762125&type=ISN response (2026-11-24).
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(Response.json(czechEdition));
    vi.stubGlobal("fetch", fetch);
    expect(
      await lookupMetadata("978-80-277-6212-5", "owner@example.com"),
    ).toEqual({
      title: "Atomové šelmy. Aréna",
      author: "František Kotleta, Kristýna Sněgoňová",
      language: "Czech",
      publisher: "Dobrovský s.r.o.",
      published_year: 2026,
      isbn,
    });
    const [url, options] = fetch.mock.calls[1] as [URL, RequestInit];
    expect(url.origin).toBe("https://www.knihovny.cz");
    expect(url.searchParams.get("lookfor")).toBe(isbn);
    expect(url.searchParams.get("type")).toBe("ISN");
    expect(url.searchParams.getAll("field[]")).toContain("isbns");
    expect(options.headers).toMatchObject({
      "User-Agent": expect.stringContaining("owner@example.com"),
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it("also falls back when Open Library times out, throttles, or returns invalid JSON", async () => {
    for (const response of [
      () => Promise.reject(new Error("Network unavailable")),
      () => Promise.reject(new DOMException("Timed out", "TimeoutError")),
      () => Promise.resolve(new Response("", { status: 429 })),
      () => Promise.resolve(new Response("bad-json")),
    ]) {
      const fetch = vi
        .fn()
        .mockImplementationOnce(response)
        .mockResolvedValueOnce(Response.json(czechEdition));
      vi.stubGlobal("fetch", fetch);
      expect(await lookupMetadata(isbn, "")).toMatchObject({
        title: "Atomové šelmy. Aréna",
        isbn,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("ignores missing, invalid, and nonmatching ISBNs even when a title matches", async () => {
    const record = czechEdition.records[0];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        Response.json({
          status: "OK",
          records: [
            { ...record, isbns: ["9788027762118"] },
            { ...record, isbns: ["9788027762126"] },
            { ...record, isbns: [] },
          ],
        }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await lookupMetadata(isbn, "")).toBeNull();
  });

  it("prefers a dedicated print edition over electronic or mixed-edition records", async () => {
    const record = czechEdition.records[0];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        Response.json({
          status: "OK",
          records: [
            {
              ...record,
              formats: ["0/EBOOK/"],
              publishers: ["Ebook publisher"],
            },
            {
              ...record,
              isbns: [isbn, "9788027770779"],
              publishers: ["Mixed editions"],
            },
            record,
          ],
        }),
      );
    vi.stubGlobal("fetch", fetch);
    expect(await lookupMetadata(isbn, "")).toMatchObject({
      publisher: "Dobrovský s.r.o.",
    });
  });

  it("keeps missing fields null rather than inferring language from the ISBN prefix", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({}))
        .mockResolvedValueOnce(
          Response.json({
            status: "OK",
            records: [{ title: "A book", isbns: [isbn] }],
          }),
        ),
    );
    expect(await lookupMetadata(isbn, "")).toEqual({
      title: "A book",
      author: null,
      language: null,
      publisher: null,
      published_year: null,
      isbn,
    });
  });

  it("does not call the Czech fallback for ISBNs outside registration group 80", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({}));
    vi.stubGlobal("fetch", fetch);
    expect(await lookupMetadata("9780140328721", "")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps provider failures recoverable and distinguishes them from a confirmed miss", async () => {
    for (const response of [
      () => Promise.reject(new Error("Network unavailable")),
      () => Promise.resolve(new Response("", { status: 429 })),
      () => Promise.resolve(new Response("bad-json")),
      () => Promise.resolve(Response.json({ status: "ERROR" })),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(Response.json({}))
          .mockImplementation(response),
      );
      await expect(lookupMetadata(isbn, "")).rejects.toThrow(/manually/);
    }
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(new Response("", { status: 429 }))
        .mockResolvedValueOnce(Response.json({ status: "OK", records: [] })),
    );
    await expect(lookupMetadata(isbn, "")).rejects.toThrow(/manually/);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(Response.json({}))
        .mockResolvedValueOnce(Response.json({ status: "OK", records: [] })),
    );
    expect(await lookupMetadata(isbn, "")).toBeNull();
  });
});

describe("intermittent catalog failures", () => {
  const isbn = "9788027762132";

  it("retries one service failure and fills Hřbitov from the live-response fixture", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        new Response("upstream unavailable", { status: 503 }),
      )
      .mockResolvedValueOnce(Response.json(hrbitovEdition));
    vi.stubGlobal("fetch", fetch);
    const lookup = lookupMetadata(isbn, "");
    await vi.advanceTimersByTimeAsync(250);
    expect(await lookup).toEqual({
      title: "Atomové šelmy. Hřbitov",
      author: "František Kotleta, Kristýna Sněgoňová",
      language: "Czech",
      publisher: "Dobrovský s.r.o.",
      published_year: 2026,
      isbn,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("honors Retry-After before retrying a rate-limited lookup", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "1" } }),
      )
      .mockResolvedValueOnce(Response.json(hrbitovEdition));
    vi.stubGlobal("fetch", fetch);
    const lookup = lookupMetadata(isbn, "");
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(await lookup).toMatchObject({
      isbn,
      title: "Atomové šelmy. Hřbitov",
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry access denials or a rate limit requesting a longer pause", async () => {
    for (const response of [
      new Response("", { status: 401 }),
      new Response("", { status: 403 }),
      new Response("", { status: 418 }),
      new Response("", { status: 429, headers: { "Retry-After": "60" } }),
    ]) {
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({}))
        .mockResolvedValueOnce(response);
      vi.stubGlobal("fetch", fetch);
      await expect(lookupMetadata(isbn, "")).rejects.toMatchObject({
        failure: {
          provider: "Knihovny.cz",
          status: response.status,
          reason: "http",
        },
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    }
  });

  it("retries network and response-body timeouts, and caches only successful responses", async () => {
    vi.useFakeTimers();
    for (const failure of [
      () => Promise.reject(new Error("connection reset")),
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
      async () => ({
        status: 200,
        ok: true,
        json: async () => {
          throw new DOMException("body timed out", "AbortError");
        },
      }),
    ]) {
      const put = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("caches", {
        default: { match: vi.fn().mockResolvedValue(undefined), put },
      });
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({}))
        .mockImplementationOnce(failure)
        .mockResolvedValueOnce(Response.json(hrbitovEdition));
      vi.stubGlobal("fetch", fetch);
      const lookup = lookupMetadata(isbn, "");
      await vi.advanceTimersByTimeAsync(250);
      expect(await lookup).toMatchObject({ isbn });
      expect(fetch).toHaveBeenCalledTimes(3);
      // The Open Library miss and final catalog success are cached; the
      // interrupted catalog attempt must never become a cached result.
      expect(put).toHaveBeenCalledTimes(2);
      expect(await put.mock.calls[1][1].json()).toMatchObject({ status: "OK" });
    }
  });

  it("stops after one retry and reports a timeout accurately", async () => {
    vi.useFakeTimers();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({}))
      .mockRejectedValue(new DOMException("timed out", "TimeoutError"));
    vi.stubGlobal("fetch", fetch);
    const lookup = lookupMetadata(isbn, "");
    const rejected = expect(lookup).rejects.toMatchObject({
      message: expect.stringContaining("took too long"),
      failure: { provider: "Knihovny.cz", reason: "timeout" },
    });
    await vi.advanceTimersByTimeAsync(250);
    await rejected;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("preserves the final HTTP status for diagnostics without calling all failures busy", async () => {
    for (const [status, message] of [
      [403, "did not allow"],
      [418, "did not allow"],
      [429, "limiting requests"],
      [503, "temporarily unavailable"],
    ] as const) {
      vi.useFakeTimers();
      const fetch = vi
        .fn()
        .mockResolvedValueOnce(Response.json({}))
        .mockImplementation(async () => new Response("", { status }));
      vi.stubGlobal("fetch", fetch);
      const lookup = lookupMetadata(isbn, "");
      const rejected = expect(lookup).rejects.toMatchObject({
        message: expect.stringContaining(message),
        failure: { provider: "Knihovny.cz", status, reason: "http" },
      });
      await vi.advanceTimersByTimeAsync(250);
      await rejected;
      await expect(lookup).rejects.toBeInstanceOf(ProviderError);
    }
  });
});
