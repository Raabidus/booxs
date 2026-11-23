import { bookInputSchema, normalizeIsbn, type Book } from "../shared/books";
import { authenticate, type AuthEnv } from "./auth";
import { lookupMetadata, ProviderError, searchMetadata } from "./metadata";

interface Env extends AuthEnv {
  DB: D1Database;
  ASSETS: Fetcher;
}

const json = (data: unknown, status = 200) => Response.json(data, { status });

async function readInput(request: Request) {
  if (!request.headers.get("content-type")?.includes("application/json"))
    return { response: json({ error: "Send a JSON book." }, 415) };
  if (Number(request.headers.get("content-length") || 0) > 16384)
    return { response: json({ error: "Book details are too long." }, 413) };
  const text = await request.text();
  if (text.length > 16384)
    return { response: json({ error: "Book details are too long." }, 413) };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { response: json({ error: "Invalid JSON." }, 400) };
  }
  const parsed = bookInputSchema.safeParse(data);
  if (!parsed.success)
    return {
      response: json(
        {
          error: parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join(" "),
        },
        422,
      ),
    };
  return { data: parsed.data };
}

async function api(request: Request, env: Env): Promise<Response> {
  const authError = await authenticate(request, env);
  if (authError) return authError;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/$/, "");
  if (!["GET", "POST", "PATCH", "DELETE"].includes(request.method))
    return json({ error: "Method not allowed." }, 405);
  if (request.method !== "GET") {
    // Reject cross-origin browser writes, including requests with otherwise valid cookies.
    const origin = request.headers.get("origin");
    if (origin && origin !== url.origin)
      return json({ error: "Cross-origin changes are not allowed." }, 403);
  }
  if (path === "/api/health" && request.method === "GET")
    return json({ status: "ok" });
  if (path === "/api/books" && request.method === "GET") {
    const result = await env.DB.prepare(
      "SELECT * FROM books ORDER BY updated_at DESC, id",
    ).all<Book>();
    return json({ books: result.results, syncedAt: new Date().toISOString() });
  }
  if (path === "/api/books/isbn" && request.method === "GET") {
    let isbn: string;
    try {
      isbn = normalizeIsbn(url.searchParams.get("isbn") || "");
    } catch (error) {
      return json({ error: (error as Error).message }, 422);
    }
    const book = await env.DB.prepare("SELECT * FROM books WHERE isbn = ?")
      .bind(isbn)
      .first<Book>();
    return json({ book });
  }
  if (path === "/api/metadata/isbn" && request.method === "GET") {
    let isbn: string;
    try {
      isbn = normalizeIsbn(url.searchParams.get("isbn") || "");
    } catch (error) {
      return json({ error: (error as Error).message }, 422);
    }
    return json({ book: await lookupMetadata(isbn, env.OWNER_EMAIL || "") });
  }
  if (path === "/api/metadata/search" && request.method === "GET") {
    const query = (url.searchParams.get("q") || "").trim();
    if (query.length < 2 || query.length > 100)
      return json({ error: "Search using 2–100 characters." }, 422);
    return json({ items: await searchMetadata(query, env.OWNER_EMAIL || "") });
  }
  const match = path.match(/^\/api\/books\/([a-f0-9-]{36})$/);
  const id = match?.[1];
  if (request.method === "GET" && id) {
    const book = await env.DB.prepare("SELECT * FROM books WHERE id = ?")
      .bind(id)
      .first<Book>();
    return book ? json(book) : json({ error: "Book not found." }, 404);
  }
  if (request.method === "DELETE" && id) {
    const result = await env.DB.prepare("DELETE FROM books WHERE id = ?")
      .bind(id)
      .run();
    return result.meta.changes
      ? json({ deleted: id })
      : json({ error: "Book not found." }, 404);
  }
  if (
    (request.method === "POST" && path === "/api/books") ||
    (request.method === "PATCH" && id)
  ) {
    const parsed = await readInput(request);
    if (parsed.response) return parsed.response;
    const book = parsed.data!;
    if (
      id &&
      !(await env.DB.prepare("SELECT id FROM books WHERE id = ?")
        .bind(id)
        .first())
    )
      return json({ error: "Book not found." }, 404);
    if (book.isbn) {
      const existing = await env.DB.prepare(
        "SELECT * FROM books WHERE isbn = ? AND id != ?",
      )
        .bind(book.isbn, id || "")
        .first<Book>();
      if (existing)
        return json(
          { error: "This ISBN is already in your library.", book: existing },
          409,
        );
    }
    const now = new Date().toISOString();
    const bookId = id || crypto.randomUUID();
    try {
      if (id) {
        await env.DB.prepare(
          "UPDATE books SET title=?, author=?, isbn=?, published_year=?, ownership=?, reading=?, updated_at=? WHERE id=?",
        )
          .bind(
            book.title,
            book.author,
            book.isbn,
            book.published_year,
            book.ownership,
            book.reading,
            now,
            id,
          )
          .run();
      } else {
        await env.DB.prepare(
          "INSERT INTO books (id,title,author,isbn,published_year,ownership,reading,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
        )
          .bind(
            bookId,
            book.title,
            book.author,
            book.isbn,
            book.published_year,
            book.ownership,
            book.reading,
            now,
            now,
          )
          .run();
      }
    } catch (error) {
      // Handle a competing insert after the earlier duplicate check as well.
      if (book.isbn && String(error).includes("UNIQUE")) {
        return json(
          {
            error: "This ISBN is already in your library.",
            book: await env.DB.prepare("SELECT * FROM books WHERE isbn=?")
              .bind(book.isbn)
              .first<Book>(),
          },
          409,
        );
      }
      throw error;
    }
    return json(
      await env.DB.prepare("SELECT * FROM books WHERE id=?")
        .bind(bookId)
        .first<Book>(),
      id ? 200 : 201,
    );
  }
  return json({ error: "Endpoint not found." }, 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (!new URL(request.url).pathname.startsWith("/api/"))
      return env.ASSETS.fetch(request);
    let response: Response;
    try {
      response = await api(request, env);
    } catch (error) {
      if (error instanceof ProviderError)
        response = json({ error: error.message }, 502);
      else {
        console.error(
          "Booxs request failed",
          error instanceof Error ? error.name : "UnknownError",
        );
        response = json(
          { error: "Your library could not be reached. Please try again." },
          500,
        );
      }
    }
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    return response;
  },
} satisfies ExportedHandler<Env>;
