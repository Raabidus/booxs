import { normalizeIsbn, type Metadata } from "./books";

function text(value: unknown): string | null {
  return typeof value === "string" ? value.trim().slice(0, 255) || null : null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      )
    : [];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function year(value: unknown): number | null {
  const match = String(value ?? "").match(/\b(1[0-9]{3}|20[0-9]{2}|2100)\b/);
  return match ? Number(match[0]) : null;
}

export function knihovnyLookupUrl(isbn: string): URL {
  isbn = normalizeIsbn(isbn);
  const url = new URL("https://www.knihovny.cz/api/v1/search");
  url.search = new URLSearchParams({
    lookfor: isbn,
    type: "ISN",
    limit: "5",
    lng: "en",
  }).toString();
  for (const field of [
    "title",
    "titleStatement",
    "primaryAuthors",
    "isbns",
    "publishers",
    "publicationDates",
    "languages",
    "formats",
    "rawData",
  ])
    url.searchParams.append("field[]", field);
  return url;
}

export function parseKnihovnyMetadata(
  data: unknown,
  isbn: string,
): Metadata | null {
  isbn = normalizeIsbn(isbn);
  const result = object(data);
  if (result.status !== "OK" || !Array.isArray(result.records))
    throw new Error(
      "Czech book details could not be read. Please enter them manually.",
    );
  const records = result.records.map(object).filter(
    (record) =>
      text(record.title) &&
      strings(record.isbns).some((value) => {
        try {
          return normalizeIsbn(value) === isbn;
        } catch {
          return false;
        }
      }),
  );
  // Prefer a record dedicated to this edition, then a print record. Never use
  // a nearby search result or combine fields from different records/editions.
  records.sort(
    (a, b) =>
      strings(a.isbns).length - strings(b.isbns).length ||
      Number(strings(b.formats).includes("0/BOOKS/")) -
        Number(strings(a.formats).includes("0/BOOKS/")),
  );
  const record = records[0];
  if (!record) return null;
  // Some deduplicated local records omit languages from the public field;
  // their shared catalog record still supplies it in the documented rawData.
  const raw = object(record.rawData);
  const languages = strings(record.languages);
  if (!languages.length)
    languages.push(
      ...strings(object(raw.parent_data).language),
      ...strings(raw.language),
    );
  return {
    title: text(record.title)!,
    author:
      text(record.titleStatement) ||
      text(strings(record.primaryAuthors).join(", ")),
    language: text([...new Set(languages)].join(", ")),
    publisher: text(
      strings(record.publishers)
        .map((name) => name.trim().replace(/[,;:]+$/, ""))
        .join(", "),
    ),
    isbn,
    published_year:
      strings(record.publicationDates)
        .map(year)
        .find((value) => value !== null) ?? null,
  };
}
