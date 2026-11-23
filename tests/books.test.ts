import { describe, expect, it } from "vitest";
import {
  bookInputSchema,
  matchesBookQuery,
  normalizeIsbn,
  possibleMatches,
  type Book,
} from "../shared/books";

describe("ISBN identification", () => {
  it("normalizes formatting and unifies equivalent ISBN-10 and ISBN-13 values", () => {
    expect(normalizeIsbn("0-14-032872-6")).toBe("9780140328721");
    expect(normalizeIsbn(" 978 0 14 032872 1 ")).toBe("9780140328721");
    expect(normalizeIsbn("080442957X")).toBe("9780804429573");
  });
  it("rejects incorrect checksums and non-book barcodes", () => {
    for (const isbn of [
      "9780140328722",
      "0140328720",
      "4006381333931",
      "",
      "978hello",
    ])
      expect(() => normalizeIsbn(isbn)).toThrow();
  });
  it("finds an edition when searching with an equivalent formatted ISBN-10", () => {
    expect(
      matchesBookQuery(
        { title: "Matilda", author: "Roald Dahl", isbn: "9780140328721" },
        "0-14-032872-6",
      ),
    ).toBe(true);
  });
});

describe("book states and input", () => {
  it("allows every independent ownership and reading combination", () => {
    for (const ownership of ["neither", "want_to_buy", "owned"]) {
      for (const reading of ["unread", "reading", "finished"])
        expect(
          bookInputSchema.safeParse({ title: "A book", ownership, reading })
            .success,
        ).toBe(true);
    }
  });
  it("requires one valid state per field, rejecting arrays and unknown states", () => {
    for (const reading of [["reading", "finished"], "reading,finished", "done"])
      expect(
        bookInputSchema.safeParse({ title: "A book", reading }).success,
      ).toBe(false);
    expect(
      bookInputSchema.safeParse({
        title: "A book",
        ownership: ["owned", "want_to_buy"],
      }).success,
    ).toBe(false);
  });
  it("trims titles, defaults to neither/unread, accepts missing ISBN, and validates years", () => {
    expect(
      bookInputSchema.parse({ title: "  Dune  ", isbn: "" }),
    ).toMatchObject({
      title: "Dune",
      isbn: null,
      ownership: "neither",
      reading: "unread",
    });
    for (const input of [
      { title: "  " },
      { title: "Dune", published_year: 2101 },
      { title: "Dune", published_year: 1.5 },
      { title: "Dune", unexpected: true },
    ])
      expect(bookInputSchema.safeParse(input).success).toBe(false);
  });
  it("suggests matching editions without identifying them as the same book", () => {
    const saved = {
      id: "id",
      title: "Příběh",
      author: "An Author",
      isbn: "9780140328721",
    } as Book;
    expect(
      possibleMatches([saved], {
        title: "Pribeh",
        author: "an author",
        isbn: "9780804429573",
      }),
    ).toEqual([saved]);
    expect(
      possibleMatches([saved], {
        title: "Pribeh",
        author: "Another Author",
        isbn: null,
      }),
    ).toEqual([]);
  });
  it("also suggests a matching manual entry when neither book has an ISBN", () => {
    const saved = { title: "A book", author: "Author", isbn: null } as Book;
    expect(
      possibleMatches([saved], {
        title: "A book",
        author: "Author",
        isbn: null,
      }),
    ).toEqual([saved]);
  });
});
