import { describe, expect, it } from "vitest";
import { coverSources, isRealCover } from "../src/covers";

describe("edition cover images", () => {
  it("uses the normalized Czech ISBN with the Czech catalog first", () => {
    const sources = coverSources("978-80-277-6213-2");
    expect(sources.map((source) => source.provider)).toEqual([
      "knihovny",
      "openlibrary",
    ]);
    expect(sources[0].url).toBe(
      "https://www.knihovny.cz/Cover/Show?isbn=9788027762132&size=large",
    );
    expect(sources[1].url).toBe(
      "https://covers.openlibrary.org/b/isbn/9788027762132-L.jpg?default=false",
    );
  });

  it("unifies equivalent ISBN-10 and ISBN-13 cover lookups", () => {
    expect(coverSources("0-14-032872-6")).toEqual(
      coverSources("9780140328721"),
    );
    expect(coverSources("0-14-032872-6")[0].provider).toBe("openlibrary");
  });

  it("does not send a query for missing or invalid ISBNs or arbitrary URLs", () => {
    for (const value of [
      null,
      "",
      "9788027762133",
      "https://other.example/cover",
    ])
      expect(coverSources(value)).toEqual([]);
  });

  it("rejects successful blank responses while preserving real artwork", () => {
    expect(isRealCover("knihovny", 65, 80)).toBe(false);
    expect(isRealCover("knihovny", 1, 1)).toBe(false);
    expect(isRealCover("openlibrary", 0, 0)).toBe(false);
    expect(isRealCover("openlibrary", 1, 1)).toBe(false);
    expect(isRealCover("knihovny", 510, 833)).toBe(true);
    expect(isRealCover("openlibrary", 65, 80)).toBe(true);
  });
});
