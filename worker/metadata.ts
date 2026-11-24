import { normalizeIsbn, type Metadata } from "../shared/books";

export class ProviderError extends Error {}

async function providerJson(
  url: URL,
  contact: string,
  provider: string,
  timeoutMs: number,
): Promise<unknown> {
  // Only metadata, never personal library records, enters the edge cache.
  const cache =
    typeof caches !== "undefined" && "default" in caches
      ? (caches as unknown as { default: Cache }).default
      : undefined;
  const cacheKey = new Request(url.toString());
  const cached = await cache?.match(cacheKey);
  if (cached) return cached.json();
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        "User-Agent": `Booxs/1.0 (${contact || "personal bookshelf"})`,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ProviderError(
      "Book details are unavailable right now. You can still enter them manually.",
    );
  }
  if (response.status === 404) return {};
  if (!response.ok)
    throw new ProviderError(
      `${provider} is busy. Try again later, or enter the details manually.`,
    );
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError(
      "Book details could not be read. Please enter them manually.",
    );
  }
  if (cache)
    await cache.put(
      cacheKey,
      new Response(JSON.stringify(data), {
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "public, max-age=86400",
        },
      }),
    );
  return data;
}

export function openLibrary(url: URL, contact: string): Promise<unknown> {
  return providerJson(url, contact, "Open Library", 8000);
}

function year(value: unknown): number | null {
  const match = String(value ?? "").match(/\b(1[0-9]{3}|20[0-9]{2}|2100)\b/);
  return match ? Number(match[0]) : null;
}

function languageName(key: string | undefined): string | null {
  const code = key?.match(/^\/languages\/([a-z]{2,3})$/)?.[1];
  if (!code) return null;
  return new Intl.DisplayNames(["en"], { type: "language" }).of(code) || code;
}

async function lookupOpenLibrary(
  isbn: string,
  contact: string,
): Promise<Metadata | null> {
  const url = new URL("https://openlibrary.org/api/books");
  url.search = new URLSearchParams({
    bibkeys: `ISBN:${isbn}`,
    format: "json",
    jscmd: "details",
  }).toString();
  const data = (await providerJson(
    url,
    contact,
    "Open Library",
    6000,
  )) as Record<
    string,
    {
      details?: {
        title?: string;
        authors?: { name?: string }[];
        languages?: { key?: string }[];
        publishers?: string[];
        publish_date?: string;
      };
    }
  >;
  const item = data[`ISBN:${isbn}`]?.details;
  if (!item?.title) return null;
  return {
    title: item.title.slice(0, 255),
    author:
      item.authors
        ?.map((author) => author.name)
        .filter(Boolean)
        .join(", ")
        .slice(0, 255) || null,
    language:
      item.languages
        ?.map((language) => languageName(language.key))
        .filter(Boolean)
        .join(", ")
        .slice(0, 255) || null,
    publisher:
      item.publishers?.filter(Boolean).join(", ").slice(0, 255) || null,
    isbn,
    published_year: year(item.publish_date),
  };
}

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

async function lookupCzechLibrary(
  isbn: string,
  contact: string,
): Promise<Metadata | null> {
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
  const data = object(await providerJson(url, contact, "Knihovny.cz", 6000));
  if (data.status !== "OK" || !Array.isArray(data.records))
    throw new ProviderError(
      "Czech book details could not be read. Please enter them manually.",
    );
  const records = data.records.map(object).filter(
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

export async function lookupMetadata(
  isbn: string,
  contact: string,
): Promise<Metadata | null> {
  isbn = normalizeIsbn(isbn);
  let primaryError: unknown;
  try {
    const book = await lookupOpenLibrary(isbn, contact);
    if (book) return book;
  } catch (error) {
    primaryError = error;
  }
  // Registration group 80 covers Czech and Slovak editions. Two six-second
  // provider timeouts keep fallback lookup inside the client's 15-second limit.
  if (isbn.startsWith("97880")) {
    const book = await lookupCzechLibrary(isbn, contact);
    if (book) return book;
  }
  if (primaryError) throw primaryError;
  return null;
}

export async function searchMetadata(
  query: string,
  contact: string,
): Promise<Metadata[]> {
  const url = new URL("https://openlibrary.org/search.json");
  url.search = new URLSearchParams({
    q: query,
    limit: "8",
    fields: "title,author_name,first_publish_year,isbn",
  }).toString();
  const data = (await openLibrary(url, contact)) as {
    docs?: {
      title?: string;
      author_name?: string[];
      first_publish_year?: number;
    }[];
  };
  // Search results describe works, not a specific edition. Never attach an arbitrary edition's ISBN/year.
  return (data.docs || [])
    .filter((item) => item.title)
    .map((item) => ({
      title: item.title!.slice(0, 255),
      author: item.author_name?.join(", ").slice(0, 255) || null,
      language: null,
      publisher: null,
      isbn: null,
      published_year: null,
    }));
}
