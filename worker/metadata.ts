import type { Metadata } from "../shared/books";

export class ProviderError extends Error {}

export async function openLibrary(url: URL, contact: string): Promise<unknown> {
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
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ProviderError(
      "Book details are unavailable right now. You can still enter them manually.",
    );
  }
  if (response.status === 404) return {};
  if (!response.ok)
    throw new ProviderError(
      "Open Library is busy. Try again later, or enter the details manually.",
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

function year(value: unknown): number | null {
  const match = String(value ?? "").match(/\b(1[0-9]{3}|20[0-9]{2}|2100)\b/);
  return match ? Number(match[0]) : null;
}

export async function lookupMetadata(
  isbn: string,
  contact: string,
): Promise<Metadata | null> {
  const url = new URL("https://openlibrary.org/api/books");
  url.search = new URLSearchParams({
    bibkeys: `ISBN:${isbn}`,
    format: "json",
    jscmd: "data",
  }).toString();
  const data = (await openLibrary(url, contact)) as Record<
    string,
    { title?: string; authors?: { name?: string }[]; publish_date?: string }
  >;
  const item = data[`ISBN:${isbn}`];
  if (!item?.title) return null;
  return {
    title: item.title.slice(0, 255),
    author:
      item.authors
        ?.map((author) => author.name)
        .filter(Boolean)
        .join(", ")
        .slice(0, 255) || null,
    isbn,
    published_year: year(item.publish_date),
  };
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
      isbn: null,
      published_year: null,
    }));
}
