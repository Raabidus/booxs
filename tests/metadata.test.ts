import { afterEach, describe, expect, it, vi } from "vitest";
import { lookupMetadata, searchMetadata } from "../worker/metadata";

afterEach(() => vi.unstubAllGlobals());
describe("optional metadata enrichment", () => {
  it("reads details for the exact edition and identifies the app", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        "ISBN:9780140328721": {
          title: "Matilda",
          authors: [{ name: "Roald Dahl" }],
          publish_date: "October 1988",
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    expect(await lookupMetadata("9780140328721", "owner@example.com")).toEqual({
      title: "Matilda",
      author: "Roald Dahl",
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
