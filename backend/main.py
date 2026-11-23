from typing import Any

import httpx
from fastapi import Depends, FastAPI, HTTPException, Query, status
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from backend.config import settings
from backend.database import get_db, init_models
from backend.models import Book
from backend.schemas import BookCreate, BookRead

app = FastAPI(title="Booxs API", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.BACKEND_CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def on_startup() -> None:
    await init_models()


@app.get("/health")
async def healthcheck() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/books", response_model=list[BookRead])
async def list_books(db: AsyncSession = Depends(get_db)) -> list[Book]:
    result = await db.execute(select(Book).order_by(Book.created_at.desc()))
    return list(result.scalars().all())


@app.post("/books", response_model=BookRead, status_code=status.HTTP_201_CREATED)
async def create_book(payload: BookCreate, db: AsyncSession = Depends(get_db)) -> Book:
    book = Book(
        title=payload.title,
        author=payload.author,
        isbn=payload.isbn,
        published_year=payload.published_year,
    )
    db.add(book)
    try:
        await db.flush()
    except IntegrityError as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A book with the same ISBN already exists.",
        ) from exc
    await db.refresh(book)
    return book


@app.get("/books/search")
async def search_openlibrary(
    q: str = Query(..., min_length=2, max_length=100),
    limit: int = Query(10, ge=1, le=50),
) -> dict[str, Any]:
    url = "https://openlibrary.org/search.json"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, params={"q": q, "limit": limit})
            response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Unable to fetch books from OpenLibrary.",
        ) from exc

    docs = response.json().get("docs", [])
    items = []
    for doc in docs[:limit]:
        items.append(
            {
                "title": doc.get("title"),
                "authors": doc.get("author_name", []),
                "first_publish_year": doc.get("first_publish_year"),
                "isbn": doc.get("isbn", [])[:3],
                "openlibrary_key": doc.get("key"),
            }
        )

    return {"query": q, "count": len(items), "items": items}
