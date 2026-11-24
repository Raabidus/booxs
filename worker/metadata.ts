import { normalizeIsbn, type Metadata } from "../shared/books";

interface ProviderFailure {
  provider?: string;
  status?: number;
  reason?: "http" | "network" | "timeout" | "parse";
  retryable?: boolean;
  retryAfterMs?: number;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly failure: ProviderFailure = {},
  ) {
    super(message);
  }
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

function connectionError(provider: string, error: unknown): ProviderError {
  const timeout =
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError");
  return new ProviderError(
    timeout
      ? `${provider} took too long to respond. Try again, or enter the details manually.`
      : `${provider} could not be reached. Try again, or enter the details manually.`,
    { provider, reason: timeout ? "timeout" : "network", retryable: true },
  );
}

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
  } catch (error) {
    throw connectionError(provider, error);
  }
  if (response.status === 404) return {};
  if (!response.ok) {
    const status = response.status;
    const message =
      status === 429
        ? `${provider} is limiting requests. Try again shortly, or enter the details manually.`
        : status === 401 || status === 403
          ? `${provider} did not allow this lookup. You can enter the details manually.`
          : status >= 500
            ? `${provider} is temporarily unavailable. Try again, or enter the details manually.`
            : `${provider} could not complete this lookup. You can enter the details manually.`;
    throw new ProviderError(message, {
      provider,
      status,
      reason: "http",
      retryable: [429, 500, 502, 503, 504].includes(status),
      retryAfterMs: retryAfterMs(response.headers.get("Retry-After")),
    });
  }
  let data: unknown;
  try {
    data = await response.json();
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw connectionError(provider, error);
    throw new ProviderError(
      "Book details could not be read. Please enter them manually.",
      { provider, reason: "parse" },
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

async function czechLibraryJson(url: URL, contact: string): Promise<unknown> {
  try {
    return await providerJson(url, contact, "Knihovny.cz", 6000);
  } catch (error) {
    if (!(error instanceof ProviderError) || !error.failure.retryable)
      throw error;
    const delayMs = error.failure.retryAfterMs ?? 250;
    // Do not retry early when the provider asks for a longer pause. One retry
    // fits inside the metadata client's 25-second request deadline.
    if (delayMs > 2000) throw error;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return providerJson(url, contact, "Knihovny.cz", 6000);
  }
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
  const data = object(await czechLibraryJson(url, contact));
  if (data.status !== "OK" || !Array.isArray(data.records))
    throw new ProviderError(
      "Czech book details could not be read. Please enter them manually.",
      { provider: "Knihovny.cz", reason: "parse" },
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
  // Registration group 80 covers Czech and Slovak editions. Six seconds per
  // attempt plus one bounded catalog retry stays within the 25-second client limit.
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
