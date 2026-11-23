from datetime import datetime

from pydantic import BaseModel, Field


class BookCreate(BaseModel):
    title: str = Field(min_length=1, max_length=255)
    author: str | None = Field(default=None, max_length=255)
    isbn: str | None = Field(default=None, max_length=32)
    published_year: int | None = Field(default=None, ge=0, le=2100)


class BookRead(BaseModel):
    id: int
    title: str
    author: str | None
    isbn: str | None
    published_year: int | None
    created_at: datetime

    model_config = {"from_attributes": True}
