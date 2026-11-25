import {
  normalizeIsbn,
  type Book,
  type BookInput,
  type Metadata,
  type Snapshot,
} from "../shared/books";
import { knihovnyLookupUrl, parseKnihovnyMetadata } from "../shared/knihovny";
import {
  derivePasswordProof,
  type PasswordParameters,
} from "../shared/password-proof";

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public book?: Book,
    public metadataFallback?: "knihovny",
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  timeoutMs = 15000,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      ...options,
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new ApiError(
      "Cannot reach your library. Your downloaded books are still available.",
    );
  }
  if (response.type === "opaqueredirect")
    throw new ApiError("Please sign in again to update your library.", 401);
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new ApiError("Please sign in again to update your library.", 401);
  const data = (await response.json()) as {
    error?: string;
    book?: Book;
    metadataFallback?: unknown;
  };
  if (!response.ok)
    throw new ApiError(
      data.error || "Something went wrong. Please try again.",
      response.status,
      data.book,
      data.metadataFallback === "knihovny" ? "knihovny" : undefined,
    );
  return data as T;
}

async function metadata(isbn: string): Promise<{ book: Metadata | null }> {
  isbn = normalizeIsbn(isbn);
  try {
    return await request<{ book: Metadata | null }>(
      "/metadata/isbn?isbn=" + encodeURIComponent(isbn),
      {},
      25000,
    );
  } catch (error) {
    // Only an authenticated Worker response identifying a catalog access
    // rejection enables this public, fixed-origin browser lookup.
    if (
      !(error instanceof ApiError) ||
      error.status !== 502 ||
      error.metadataFallback !== "knihovny" ||
      !isbn.startsWith("97880")
    )
      throw error;
  }
  let response: Response;
  try {
    response = await fetch(knihovnyLookupUrl(isbn), {
      mode: "cors",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new ApiError(
      "Czech book details could not be reached from this device. Try again, or enter the details manually.",
    );
  }
  if (!response.ok)
    throw new ApiError(
      response.status === 429
        ? "Knihovny.cz is limiting requests. Try again later, or enter the details manually."
        : "Czech book details are unavailable. Try again, or enter the details manually.",
      502,
    );
  try {
    return { book: parseKnihovnyMetadata(await response.json(), isbn) };
  } catch {
    throw new ApiError(
      "Czech book details could not be read. Please enter them manually.",
      502,
    );
  }
}

export const api = {
  login: async (email: string, password: string) => {
    const parameters = await request<PasswordParameters & { local?: boolean }>(
      "/auth/parameters",
    );
    const passwordProof = parameters.local
      ? ""
      : await derivePasswordProof(password, parameters);
    return request<{ authenticated: boolean }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, passwordProof }),
    });
  },
  logout: () =>
    request<{ authenticated: boolean }>("/auth/logout", {
      method: "POST",
      body: "{}",
    }),
  list: () => request<Snapshot>("/books"),
  isbn: (isbn: string) =>
    request<{ book: Book | null }>(
      "/books/isbn?isbn=" + encodeURIComponent(isbn),
    ),
  metadata,
  search: (q: string) =>
    request<{ items: Metadata[] }>(
      "/metadata/search?q=" + encodeURIComponent(q),
    ),
  save: (book: BookInput, id?: string) =>
    request<Book>("/books" + (id ? "/" + id : ""), {
      method: id ? "PATCH" : "POST",
      body: JSON.stringify(book),
    }),
  remove: (id: string) =>
    request<{ deleted: string }>("/books/" + id, { method: "DELETE" }),
};
