CREATE TABLE books (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 255),
  author TEXT,
  isbn TEXT UNIQUE CHECK (isbn IS NULL OR (length(isbn) = 13 AND isbn NOT GLOB '*[^0-9]*')),
  published_year INTEGER CHECK (published_year IS NULL OR published_year BETWEEN 0 AND 2100),
  ownership TEXT NOT NULL DEFAULT 'neither' CHECK (ownership IN ('neither', 'want_to_buy', 'owned')),
  reading TEXT NOT NULL DEFAULT 'unread' CHECK (reading IN ('unread', 'reading', 'finished')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX books_updated_at ON books(updated_at DESC, id);
