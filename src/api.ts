import type { Book, BookInput, Metadata, Snapshot } from "../shared/books";
import {
  derivePasswordProof,
  type PasswordParameters,
} from "../shared/password-proof";

export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
    public book?: Book,
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch("/api" + path, {
      ...options,
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      headers: { "Content-Type": "application/json", ...options.headers },
      signal: AbortSignal.timeout(15000),
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
  const data = (await response.json()) as { error?: string; book?: Book };
  if (!response.ok)
    throw new ApiError(
      data.error || "Something went wrong. Please try again.",
      response.status,
      data.book,
    );
  return data as T;
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
  metadata: (isbn: string) =>
    request<{ book: Metadata | null }>(
      "/metadata/isbn?isbn=" + encodeURIComponent(isbn),
    ),
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
