import { z } from "zod";

export const ownershipLabels = {
  neither: "Neither",
  want_to_buy: "Want to buy",
  owned: "Owned",
} as const;
export const readingLabels = {
  unread: "Unread",
  reading: "Reading",
  finished: "Finished",
} as const;
export type Ownership = keyof typeof ownershipLabels;
export type Reading = keyof typeof readingLabels;

export function normalizeIsbn(value: string): string {
  const text = value.replace(/[\s-]/g, "").toUpperCase();
  if (/^\d{9}[\dX]$/.test(text)) {
    const sum = [...text].reduce(
      (n, c, i) => n + (c === "X" ? 10 : Number(c)) * (10 - i),
      0,
    );
    if (sum % 11 !== 0)
      throw new Error(
        "ISBN-10 checksum is invalid. Check the number and try again.",
      );
    const prefix = "978" + text.slice(0, 9);
    const digit =
      (10 -
        ([...prefix].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) %
          10)) %
      10;
    return prefix + digit;
  }
  if (!/^(978|979)\d{10}$/.test(text))
    throw new Error("Enter a book ISBN with 10 or 13 digits.");
  const sum = [...text].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
  if (sum % 10 !== 0)
    throw new Error(
      "ISBN-13 checksum is invalid. Check the number and try again.",
    );
  return text;
}

const isbnSchema = z
  .string()
  .trim()
  .transform((value, ctx) => {
    if (!value) return null;
    try {
      return normalizeIsbn(value);
    } catch (error) {
      ctx.addIssue({ code: "custom", message: (error as Error).message });
      return z.NEVER;
    }
  })
  .nullable();

export const bookInputSchema = z
  .object({
    title: z.string().trim().min(1, "A title is required.").max(255),
    author: z
      .string()
      .trim()
      .max(255)
      .nullable()
      .transform((value) => value || null)
      .default(null),
    language: z
      .string()
      .trim()
      .max(255)
      .nullable()
      .transform((value) => value || null)
      .default(null),
    publisher: z
      .string()
      .trim()
      .max(255)
      .nullable()
      .transform((value) => value || null)
      .default(null),
    isbn: isbnSchema.default(null),
    published_year: z.number().int().min(0).max(2100).nullable().default(null),
    ownership: z.enum(["neither", "want_to_buy", "owned"]).default("neither"),
    reading: z.enum(["unread", "reading", "finished"]).default("unread"),
  })
  .strict();

export type BookInput = z.output<typeof bookInputSchema>;
export interface Book extends BookInput {
  id: string;
  created_at: string;
  updated_at: string;
}
export interface Metadata {
  title: string;
  author: string | null;
  language: string | null;
  publisher: string | null;
  isbn: string | null;
  published_year: number | null;
}
export interface Snapshot {
  books: Book[];
  syncedAt: string;
}

export function normalizedText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export function possibleMatches(
  books: Book[],
  book: Pick<BookInput, "title" | "author" | "isbn">,
): Book[] {
  if (!book.title.trim()) return [];
  return books.filter(
    (saved) =>
      (!book.isbn || saved.isbn !== book.isbn) &&
      normalizedText(saved.title) === normalizedText(book.title) &&
      (!book.author ||
        !saved.author ||
        normalizedText(saved.author) === normalizedText(book.author)),
  );
}

export function matchesBookQuery(
  book: Pick<BookInput, "title" | "author" | "isbn">,
  query: string,
): boolean {
  try {
    if (book.isbn && normalizeIsbn(query) === book.isbn) return true;
  } catch {
    /* A normal title/author search. */
  }
  return normalizedText(
    `${book.title} ${book.author || ""} ${book.isbn || ""}`,
  ).includes(normalizedText(query));
}
