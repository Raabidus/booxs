import { useState } from "react";
import { BookOpen } from "lucide-react";
import type { Book } from "../shared/books";
import { coverSources, isRealCover } from "./covers";

type CoverBook = Pick<Book, "title" | "author" | "isbn">;

export default function Cover({
  book,
  large = false,
}: {
  book: CoverBook;
  large?: boolean;
}) {
  // A changed ISBN must start a fresh lookup, including after editing a book.
  return <CoverArtwork key={book.isbn} book={book} large={large} />;
}

function CoverArtwork({ book, large }: { book: CoverBook; large: boolean }) {
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const source = coverSources(book.isbn)[attempt];
  const hash = [...book.title].reduce((n, c) => n + c.charCodeAt(0), 0);
  function nextSource() {
    setLoaded(false);
    setAttempt((current) => current + 1);
  }
  return (
    <>
      <div
        className={`book-cover cover-${hash % 6} ${large ? "large" : ""} ${loaded ? "has-image" : ""}`}
        aria-hidden="true"
      >
        {!loaded && (
          <>
            <div className="cover-rule" />
            <span className="cover-title">{book.title}</span>
            <span className="cover-author">{book.author || "A new story"}</span>
            <div className="cover-orbit" />
            <BookOpen
              className="cover-mark"
              size={large ? 22 : 15}
              strokeWidth={1.2}
            />
          </>
        )}
        {source && (
          <img
            key={source.url}
            className={`cover-image ${loaded ? "loaded" : ""}`}
            src={source.url}
            alt=""
            loading={large ? "eager" : "lazy"}
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={(event) => {
              const image = event.currentTarget;
              if (
                isRealCover(
                  source.provider,
                  image.naturalWidth,
                  image.naturalHeight,
                )
              )
                setLoaded(true);
              else nextSource();
            }}
            onError={nextSource}
          />
        )}
      </div>
      {large && loaded && source && (
        <p className="cover-credit">
          Cover:{" "}
          <a href={source.href} target="_blank" rel="noreferrer">
            {source.label}
          </a>
          {source.provider === "knihovny" && (
            <>
              {" / "}
              <a
                href={`https://www.obalkyknih.cz/view?isbn=${book.isbn}`}
                target="_blank"
                rel="noreferrer"
              >
                ObálkyKnih.cz
              </a>
            </>
          )}
        </p>
      )}
    </>
  );
}
