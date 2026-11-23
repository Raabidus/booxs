import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  BookOpen,
  BookMarked,
  Library,
  ScanLine,
  Plus,
  Search,
  X,
  RefreshCw,
  WifiOff,
  Check,
  ChevronRight,
  LogOut,
  Download,
  Pencil,
  Trash2,
  SlidersHorizontal,
  ShoppingBag,
  Bookmark,
  CircleHelp,
  LoaderCircle,
  Minus,
} from "lucide-react";
import {
  bookInputSchema,
  normalizeIsbn,
  matchesBookQuery,
  ownershipLabels,
  possibleMatches,
  readingLabels,
  type Book,
  type BookInput,
  type Metadata,
  type Ownership,
  type Reading,
  type Snapshot,
} from "../shared/books";
import { api, ApiError } from "./api";
import { clearSnapshot, loadSnapshot, storeSnapshot } from "./storage";
import Scanner from "./Scanner";

type View = "library" | "scan";
type Modal =
  | { type: "form"; book?: Book; initial?: Partial<BookInput> }
  | { type: "detail"; book: Book }
  | { type: "help" }
  | null;
const empty: BookInput = {
  title: "",
  author: null,
  isbn: null,
  published_year: null,
  ownership: "neither",
  reading: "unread",
};

function timeLabel(value: string | null) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(value))
    : "Not downloaded yet";
}

function Cover({
  book,
  large = false,
}: {
  book: Pick<Book, "title" | "author">;
  large?: boolean;
}) {
  const hash = [...book.title].reduce((n, c) => n + c.charCodeAt(0), 0);
  return (
    <div
      className={`book-cover cover-${hash % 6} ${large ? "large" : ""}`}
      aria-hidden="true"
    >
      <div className="cover-rule" />
      <span className="cover-title">{book.title}</span>
      <span className="cover-author">{book.author || "A new story"}</span>
      <div className="cover-orbit" />
      <BookOpen
        className="cover-mark"
        size={large ? 22 : 15}
        strokeWidth={1.2}
      />
    </div>
  );
}

function Badges({ book }: { book: Pick<Book, "ownership" | "reading"> }) {
  return (
    <div className="badges">
      <span className={"badge ownership-" + book.ownership}>
        {book.ownership === "owned" ? (
          <Check size={12} />
        ) : book.ownership === "want_to_buy" ? (
          <ShoppingBag size={12} />
        ) : (
          <Minus size={12} />
        )}
        {ownershipLabels[book.ownership]}
      </span>
      <span className={"badge reading-" + book.reading}>
        {readingLabels[book.reading]}
      </span>
    </div>
  );
}

function Dialog({
  title,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
      element.close();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className={wide ? "dialog wide" : "dialog"}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      aria-labelledby="dialog-title"
    >
      <div className="dialog-inner">
        <div className="dialog-heading">
          <h2 id="dialog-title">{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X size={22} />
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const snapshotRef = useRef<Snapshot | null>(null);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  const [reachable, setReachable] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState("");
  const [cacheWarning, setCacheWarning] = useState("");
  const [view, setView] = useState<View>("library");
  const [modal, setModal] = useState<Modal>(null);
  const [query, setQuery] = useState("");
  const [ownership, setOwnership] = useState<Ownership | "all">("all");
  const [reading, setReading] = useState<Reading | "all">("all");
  const [scanIsbn, setScanIsbn] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [scanResult, setScanResult] = useState<{
    isbn: string;
    book: Book | null;
    cached: boolean;
  } | null>(null);
  const [scanError, setScanError] = useState("");
  const [metadataBusy, setMetadataBusy] = useState(false);
  const [toast, setToast] = useState("");
  const syncInFlight = useRef<Promise<void> | null>(null);
  const active = useRef(true);
  const scanSequence = useRef(0);
  const offline = !online || !reachable;
  const canWrite = !offline && !authRequired;
  const books = snapshot?.books || [];

  const remember = useCallback(async (next: Snapshot) => {
    if (!active.current) return;
    snapshotRef.current = next;
    setSnapshot(next);
    // Keep an open scan result consistent after edits, deletion, or reconnect.
    setScanResult((current) =>
      current
        ? {
            ...current,
            book: next.books.find((book) => book.isbn === current.isbn) || null,
          }
        : null,
    );
    try {
      await storeSnapshot(next);
      if (active.current) setCacheWarning("");
    } catch {
      if (active.current)
        setCacheWarning(
          "Your browser could not save an offline copy. Keep an internet connection to access your library.",
        );
    }
  }, []);

  const sync = useCallback(() => {
    if (syncInFlight.current) return syncInFlight.current;
    if (!navigator.onLine || !active.current) return Promise.resolve();
    const task = (async () => {
      setSyncing(true);
      try {
        const next = await api.list();
        if (!active.current) return;
        await remember(next);
        setReachable(true);
        setAuthRequired(false);
        setNotice("");
      } catch (error) {
        if (!active.current) return;
        setNotice((error as Error).message);
        if (error instanceof ApiError) {
          setAuthRequired(error.status === 401);
          setReachable(error.status !== 0);
        }
      } finally {
        if (active.current) setSyncing(false);
      }
    })();
    syncInFlight.current = task;
    task.finally(() => {
      syncInFlight.current = null;
    });
    return task;
  }, [remember]);

  useEffect(() => {
    let cancelled = false;
    active.current = true;
    void (async () => {
      try {
        const saved = await loadSnapshot();
        if (!cancelled && saved) {
          snapshotRef.current = saved;
          setSnapshot(saved);
        }
      } catch {
        if (!cancelled)
          setCacheWarning("Offline storage is unavailable in this browser.");
      }
      if (!cancelled) {
        setReady(true);
        void sync();
      }
    })();
    const connect = () => {
      setOnline(true);
      setReachable(true);
      void sync();
    };
    const disconnect = () => setOnline(false);
    const offlineError = () =>
      setCacheWarning(
        "Offline app files could not be downloaded. Reopen Booxs online to try again.",
      );
    window.addEventListener("online", connect);
    window.addEventListener("offline", disconnect);
    window.addEventListener("booxs-offline-error", offlineError);
    return () => {
      cancelled = true;
      window.removeEventListener("online", connect);
      window.removeEventListener("offline", disconnect);
      window.removeEventListener("booxs-offline-error", offlineError);
    };
  }, [sync]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (view !== "scan") {
      scanSequence.current++;
      setScanBusy(false);
    }
  }, [view]);

  async function saved(book: Book) {
    // Finish any launch refresh before applying a write, so an old response cannot overwrite it.
    await syncInFlight.current;
    const current = snapshotRef.current;
    await remember({
      books: [
        book,
        ...(current?.books || []).filter((item) => item.id !== book.id),
      ],
      syncedAt: current?.syncedAt || new Date().toISOString(),
    });
    setModal({ type: "detail", book });
    setToast("Saved to your bookshelf");
    void sync();
  }

  async function deleted(id: string) {
    await syncInFlight.current;
    const current = snapshotRef.current;
    await remember({
      books: (current?.books || []).filter((book) => book.id !== id),
      syncedAt: current?.syncedAt || new Date().toISOString(),
    });
    setModal(null);
    setToast("Book removed");
    void sync();
  }

  async function checkIsbn(value: string) {
    const sequence = ++scanSequence.current;
    setScanError("");
    setScanResult(null);
    let isbn: string;
    try {
      isbn = normalizeIsbn(value);
    } catch (error) {
      setScanError((error as Error).message);
      return;
    }
    setScanIsbn(isbn);
    const localBook =
      snapshotRef.current?.books.find((book) => book.isbn === isbn) || null;
    if (offline || authRequired) {
      setScanResult({ isbn, book: localBook, cached: true });
      return;
    }
    setScanBusy(true);
    try {
      const result = await api.isbn(isbn);
      if (sequence === scanSequence.current)
        setScanResult({ isbn, book: result.book, cached: false });
    } catch (error) {
      if (sequence !== scanSequence.current) return;
      setScanResult({ isbn, book: localBook, cached: true });
      setScanError((error as Error).message);
      if (error instanceof ApiError && error.status === 401)
        setAuthRequired(true);
    } finally {
      if (sequence === scanSequence.current) setScanBusy(false);
    }
  }

  async function addScanned() {
    if (!scanResult || !canWrite) return;
    setMetadataBusy(true);
    setScanError("");
    let initial: Partial<BookInput> = { isbn: scanResult.isbn };
    try {
      const { book } = await api.metadata(scanResult.isbn);
      if (book) initial = { ...initial, ...book };
      else setToast("No book details found. You can add them yourself.");
    } catch (error) {
      setToast((error as Error).message);
    } finally {
      setMetadataBusy(false);
    }
    setModal({ type: "form", initial });
  }

  async function signOut() {
    active.current = false;
    await syncInFlight.current;
    try {
      await clearSnapshot();
      snapshotRef.current = null;
      setSnapshot(null);
      setModal(null);
      setScanResult(null);
      if ("caches" in window)
        for (const name of await caches.keys())
          if (name.startsWith("booxs-")) await caches.delete(name);
      if ("serviceWorker" in navigator)
        for (const registration of await navigator.serviceWorker.getRegistrations())
          await registration.unregister();
      if (
        navigator.onLine &&
        !["localhost", "127.0.0.1"].includes(location.hostname)
      )
        location.assign("/cdn-cgi/access/logout");
      else {
        setAuthRequired(true);
        setNotice(
          "Local books cleared. Reconnect and sign in to download your library again.",
        );
      }
    } catch {
      active.current = true;
      setNotice(
        "Local storage could not be cleared. Close this app and clear its website data in browser settings.",
      );
    }
  }

  const filtered = books.filter(
    (book) =>
      (ownership === "all" || book.ownership === ownership) &&
      (reading === "all" || book.reading === reading) &&
      matchesBookQuery(book, query),
  );
  const currentBook =
    modal?.type === "detail"
      ? books.find((book) => book.id === modal.book.id) || modal.book
      : null;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          href="#"
          className="brand"
          onClick={(event) => {
            event.preventDefault();
            setView("library");
          }}
          aria-label="Booxs home"
        >
          <span className="brand-icon">
            <BookOpen size={24} />
          </span>
          booxs<span className="brand-dot">.</span>
        </a>
        <div className="sidebar-label">YOUR READING SPACE</div>
        <nav className="side-nav" aria-label="Main navigation">
          <button
            className={view === "library" ? "active" : ""}
            onClick={() => setView("library")}
          >
            <Library size={20} />
            My bookshelf<span className="nav-count">{books.length}</span>
          </button>
          <button
            className={view === "scan" ? "active" : ""}
            onClick={() => setView("scan")}
          >
            <ScanLine size={20} />
            Scan a book
          </button>
          <button
            onClick={() => setModal({ type: "form" })}
            disabled={!canWrite}
          >
            <Plus size={20} />
            Add a book
          </button>
        </nav>
        <div className="sidebar-note">
          <Bookmark size={21} strokeWidth={1.5} />
          <p>
            A home for the books
            <br />
            in your life.
          </p>
          <span>Read. Remember. Rediscover.</span>
        </div>
        <div className="sidebar-bottom">
          <div className="private-label">
            <span className="avatar">M</span>
            <div>
              <strong>Your private library</strong>
              <span>Just for you</span>
            </div>
            <BookMarked size={17} />
          </div>
          <button
            className="sidebar-help"
            onClick={() => setModal({ type: "help" })}
          >
            <CircleHelp size={17} />
            Install & help
          </button>
          <button className="sidebar-help" onClick={signOut}>
            <LogOut size={17} />
            Sign out & clear offline books
          </button>
        </div>
      </aside>

      <div className="main-shell">
        <header className="topbar">
          <span className="breadcrumb">
            My reading space <ChevronRight size={14} />
            <strong>{view === "scan" ? "Scan a book" : "My bookshelf"}</strong>
          </span>
          <a
            className="mobile-brand"
            href="#"
            onClick={(event) => {
              event.preventDefault();
              setView("library");
            }}
          >
            <BookOpen size={22} />
            booxs.
          </a>
          <div className="sync-group">
            <span className={"connection " + (offline ? "offline" : "")}>
              {offline ? (
                <WifiOff size={14} />
              ) : (
                <span className="status-dot" />
              )}
              {offline
                ? "Offline"
                : authRequired
                  ? "Sign-in needed"
                  : "Private library"}
            </span>
            <button
              className={"icon-button " + (syncing ? "spinning" : "")}
              title="Refresh library"
              aria-label="Refresh library"
              disabled={syncing || !online}
              onClick={() => void sync()}
            >
              <RefreshCw size={17} />
            </button>
          </div>
        </header>
        <main>
          {(notice || offline || cacheWarning) && (
            <div className="notice-stack" aria-live="polite">
              {offline && (
                <p className="message">
                  <WifiOff size={17} />
                  You’re browsing your downloaded library. Changes need a
                  connection.
                </p>
              )}
              {notice && (
                <p className="message warning">
                  {notice}
                  {authRequired && (
                    <button
                      className="text-button"
                      onClick={() => location.reload()}
                    >
                      Sign in
                    </button>
                  )}
                </p>
              )}
              {cacheWarning && (
                <p className="message warning">{cacheWarning}</p>
              )}
            </div>
          )}
          {view === "library" ? (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">A SPACE FOR YOUR STORIES</span>
                  <h1>
                    Your bookshelf<span>.</span>
                  </h1>
                  <p>Read a little. Remember every book.</p>
                </div>
                <button
                  className="button primary desktop-add"
                  onClick={() => setModal({ type: "form" })}
                  disabled={!canWrite}
                >
                  <Plus size={18} />
                  Add a book
                </button>
              </div>
              <section className="overview" aria-label="Library overview">
                <div className="stat">
                  <span className="stat-icon">
                    <Library size={20} />
                  </span>
                  <div>
                    <strong>{books.length}</strong>
                    <span>Books in your library</span>
                  </div>
                </div>
                <div className="stat">
                  <span className="stat-icon">
                    <ShoppingBag size={20} />
                  </span>
                  <div>
                    <strong>
                      {
                        books.filter((book) => book.ownership === "want_to_buy")
                          .length
                      }
                    </strong>
                    <span>On your wishlist</span>
                  </div>
                </div>
                <div className="stat">
                  <span className="stat-icon">
                    <BookOpen size={20} />
                  </span>
                  <div>
                    <strong>
                      {
                        books.filter((book) => book.reading === "reading")
                          .length
                      }
                    </strong>
                    <span>Currently reading</span>
                  </div>
                </div>
                <div className="stat">
                  <span className="stat-icon">
                    <Check size={20} />
                  </span>
                  <div>
                    <strong>
                      {
                        books.filter((book) => book.reading === "finished")
                          .length
                      }
                    </strong>
                    <span>Stories finished</span>
                  </div>
                </div>
              </section>
              <section className="scan-banner">
                <div className="banner-copy">
                  <span className="eyebrow">FOUND SOMETHING GOOD?</span>
                  <h2>
                    Before you buy,
                    <br className="mobile-break" /> check your shelf.
                  </h2>
                  <p>
                    Scan the barcode. See if it’s already part of your story.
                  </p>
                  <button
                    className="button lime"
                    onClick={() => {
                      setView("scan");
                      setScanResult(null);
                    }}
                  >
                    <ScanLine size={19} />
                    Scan a book
                  </button>
                </div>
                <div className="banner-art" aria-hidden="true">
                  <div className="art-book art-book-one">
                    <span>
                      ONE MORE
                      <br />
                      CHAPTER
                    </span>
                    <div />
                  </div>
                  <div className="art-book art-book-two">
                    <BookOpen size={36} strokeWidth={1} />
                    <span>
                      THE QUIET
                      <br />
                      BETWEEN
                      <br />
                      PAGES
                    </span>
                  </div>
                  <div className="art-scan">
                    <i />
                    <i />
                    <i />
                    <i />
                    <div className="barcode">
                      {Array.from({ length: 25 }, (_, i) => (
                        <b
                          key={i}
                          style={{ width: (i % 3 === 0 ? 3 : 1) + "px" }}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              </section>
              <section className="shelf-section" aria-label="Books">
                <div className="section-heading">
                  <h2>
                    All your books <span>{books.length}</span>
                  </h2>
                  <span className="shelf-sort">Recently updated</span>
                </div>
                <div className="shelf-toolbar">
                  <label className="search-field">
                    <Search size={18} />
                    <input
                      aria-label="Search your library"
                      placeholder="Search by title, author, or ISBN…"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    {query && (
                      <button
                        className="icon-button small"
                        aria-label="Clear search"
                        onClick={() => setQuery("")}
                      >
                        <X size={16} />
                      </button>
                    )}
                  </label>
                  <label className="reading-filter">
                    <SlidersHorizontal size={16} />
                    <span className="sr-only">Reading state</span>
                    <select
                      aria-label="Filter by reading state"
                      value={reading}
                      onChange={(event) =>
                        setReading(event.target.value as Reading | "all")
                      }
                    >
                      <option value="all">All reading states</option>
                      {Object.entries(readingLabels).map(([key, label]) => (
                        <option key={key} value={key}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <div
                  className="ownership-tabs"
                  role="group"
                  aria-label="Filter by ownership"
                >
                  {(["all", "owned", "want_to_buy", "neither"] as const).map(
                    (value) => (
                      <button
                        key={value}
                        className={ownership === value ? "selected" : ""}
                        onClick={() => setOwnership(value)}
                      >
                        {value === "all" ? "All books" : ownershipLabels[value]}
                        <span>
                          {value === "all"
                            ? books.length
                            : books.filter((book) => book.ownership === value)
                                .length}
                        </span>
                      </button>
                    ),
                  )}
                </div>
                {!ready || (syncing && !snapshot) ? (
                  <div className="empty-state">
                    <LoaderCircle className="spin" size={28} />
                    <h3>Opening your bookshelf…</h3>
                  </div>
                ) : filtered.length ? (
                  <div className="book-grid">
                    {filtered.map((book) => (
                      <button
                        className="book-card"
                        key={book.id}
                        onClick={() => setModal({ type: "detail", book })}
                      >
                        <Cover book={book} />
                        <div className="book-info">
                          <h3>{book.title}</h3>
                          <p>{book.author || "Author not added"}</p>
                          <Badges book={book} />
                        </div>
                        <ChevronRight className="book-chevron" size={18} />
                      </button>
                    ))}
                  </div>
                ) : (
                  <div className="empty-state">
                    <div className="empty-books" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                      <span />
                      <BookOpen size={25} />
                    </div>
                    <h3>
                      {books.length
                        ? "No books on this shelf yet"
                        : offline && !snapshot
                          ? "Download your bookshelf first"
                          : "Good stories start here."}
                    </h3>
                    <p>
                      {books.length
                        ? "Try another search or change your filters."
                        : offline && !snapshot
                          ? "Open Booxs with an internet connection to save your library for offline use."
                          : "Add your first book, or scan a barcode to make yourself at home."}
                    </p>
                    {!books.length && canWrite && (
                      <button
                        className="button secondary"
                        onClick={() => setModal({ type: "form" })}
                      >
                        <Plus size={17} />
                        Add your first book
                      </button>
                    )}
                  </div>
                )}
              </section>
              <footer className="shelf-footer">
                <span>
                  <Download size={14} />
                  {snapshot
                    ? `${books.length} books available offline`
                    : "Your library hasn’t been downloaded yet"}
                </span>
                <span>
                  Last synced: {timeLabel(snapshot?.syncedAt || null)}
                </span>
              </footer>
            </>
          ) : (
            <>
              <div className="page-title">
                <div>
                  <span className="eyebrow">A LITTLE LESS GUESSWORK</span>
                  <h1>
                    Scan a book<span>.</span>
                  </h1>
                  <p>Already yours, on your wishlist, or a new discovery?</p>
                </div>
              </div>
              <div className="scan-layout">
                <section className="scanner-panel">
                  <Scanner onDetected={(isbn) => void checkIsbn(isbn)} />
                  <form
                    className="isbn-check"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void checkIsbn(scanIsbn);
                    }}
                  >
                    <label htmlFor="scan-isbn">Or enter the ISBN</label>
                    <div className="input-with-button">
                      <input
                        id="scan-isbn"
                        value={scanIsbn}
                        onChange={(event) => setScanIsbn(event.target.value)}
                        placeholder="978…"
                        inputMode="text"
                        autoComplete="off"
                        maxLength={32}
                      />
                      <button
                        className="button primary"
                        disabled={scanBusy || !scanIsbn.trim()}
                      >
                        {scanBusy ? (
                          <LoaderCircle className="spin" size={18} />
                        ) : (
                          <Search size={18} />
                        )}
                        Check
                      </button>
                    </div>
                    <p className="field-hint">
                      The 10 or 13 digit number near the book’s barcode.
                    </p>
                  </form>
                </section>
                <section className="scan-results" aria-live="polite">
                  {scanError && (
                    <p className="message error" role="alert">
                      {scanError}
                    </p>
                  )}
                  {scanBusy ? (
                    <div className="result-placeholder">
                      <LoaderCircle size={28} className="spin" />
                      <h3>Checking your bookshelf…</h3>
                    </div>
                  ) : scanResult ? (
                    <>
                      <span className="eyebrow">
                        {scanResult.cached
                          ? "DOWNLOADED LIBRARY"
                          : "YOUR PRIVATE LIBRARY"}
                      </span>
                      <div
                        className={
                          "result-symbol " + (scanResult.book ? "found" : "")
                        }
                      >
                        {scanResult.book ? (
                          <Check size={28} />
                        ) : (
                          <Bookmark size={28} />
                        )}
                      </div>
                      <h2>
                        {scanResult.book
                          ? "It’s on your shelf."
                          : scanResult.cached
                            ? "Not found in downloaded library."
                            : "A new discovery."}
                      </h2>
                      <p className="result-isbn">ISBN {scanResult.isbn}</p>
                      {scanResult.book ? (
                        <>
                          <div className="result-book">
                            <Cover book={scanResult.book} />
                            <div>
                              <h3>{scanResult.book.title}</h3>
                              <p>{scanResult.book.author}</p>
                              <Badges book={scanResult.book} />
                            </div>
                          </div>
                          <button
                            className="button primary"
                            onClick={() =>
                              setModal({
                                type: "detail",
                                book: scanResult.book!,
                              })
                            }
                          >
                            View book
                            <ChevronRight size={17} />
                          </button>
                        </>
                      ) : (
                        <>
                          <p>
                            {scanResult.cached
                              ? "This ISBN isn’t in your saved copy. Connect to check the latest library or add this edition."
                              : "This edition isn’t in your library. Add its details and decide where it belongs."}
                          </p>
                          <button
                            className="button primary"
                            disabled={!canWrite || metadataBusy}
                            onClick={() => void addScanned()}
                          >
                            {metadataBusy ? (
                              <LoaderCircle className="spin" size={17} />
                            ) : (
                              <Plus size={17} />
                            )}
                            Add this book
                          </button>
                        </>
                      )}
                      {scanResult.cached && (
                        <p className="field-hint">
                          Last synced: {timeLabel(snapshot?.syncedAt || null)}
                        </p>
                      )}
                    </>
                  ) : (
                    <div className="result-placeholder">
                      <span className="result-icon">
                        <BookMarked size={27} strokeWidth={1.4} />
                      </span>
                      <h3>
                        Your next discovery
                        <br />
                        is one scan away.
                      </h3>
                      <p>
                        We’ll check your saved books first.
                        <br />
                        Your results will appear here.
                      </p>
                      <div className="scan-tip">
                        <Check size={16} />
                        <span>ISBN barcodes only — no cover photos needed</span>
                      </div>
                    </div>
                  )}
                </section>
              </div>
            </>
          )}
        </main>
        <nav className="mobile-nav" aria-label="Mobile navigation">
          <button
            className={view === "library" ? "active" : ""}
            onClick={() => setView("library")}
          >
            <Library size={21} />
            Bookshelf
          </button>
          <button
            className={view === "scan" ? "active" : ""}
            onClick={() => setView("scan")}
          >
            <ScanLine size={23} />
            Scan
          </button>
          <button
            disabled={!canWrite}
            onClick={() => setModal({ type: "form" })}
          >
            <Plus size={22} />
            Add book
          </button>
          <button onClick={() => setModal({ type: "help" })}>
            <CircleHelp size={21} />
            Help
          </button>
        </nav>
      </div>
      {modal?.type === "form" && (
        <BookForm
          key={modal.book?.id || "new"}
          book={modal.book}
          initial={modal.initial}
          books={books}
          canWrite={canWrite}
          onClose={() => setModal(null)}
          onSaved={saved}
          onExisting={(book) => setModal({ type: "detail", book })}
        />
      )}
      {modal?.type === "detail" && currentBook && (
        <BookDetail
          book={currentBook}
          canWrite={canWrite}
          onClose={() => setModal(null)}
          onEdit={() => setModal({ type: "form", book: currentBook })}
          onDeleted={deleted}
        />
      )}
      {modal?.type === "help" && (
        <Dialog title="Make yourself at home" onClose={() => setModal(null)}>
          <div className="help-content">
            <div className="help-icon">
              <BookOpen size={32} />
            </div>
            <h3>Your bookshelf, in your pocket.</h3>
            <p>
              On your iPhone, open Booxs in Safari. Tap <strong>Share</strong>,
              then <strong>Add to Home Screen</strong>. Open it once online to
              download your books and the scanner.
            </p>
            <h4>When you’re offline</h4>
            <p>
              Scan and search the last downloaded library. Adding, editing, and
              looking up new book details need internet. Your last sync time is
              shown on the bookshelf.
            </p>
            <h4>A book can belong to two shelves</h4>
            <p>
              Choose one ownership state and one reading state. A book can be
              finished and on your wishlist, or owned and still unread.
              Different editions stay separate.
            </p>
            <h4>Your private space</h4>
            <p>
              Downloaded books stay on this device until you sign out or clear
              browser storage.
            </p>
            <button className="button secondary full" onClick={signOut}>
              <LogOut size={17} />
              Sign out & clear offline books
            </button>
          </div>
        </Dialog>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
    </div>
  );
}

function BookForm({
  book,
  initial,
  books,
  canWrite,
  onClose,
  onSaved,
  onExisting,
}: {
  book?: Book;
  initial?: Partial<BookInput>;
  books: Book[];
  canWrite: boolean;
  onClose: () => void;
  onSaved: (book: Book) => Promise<void>;
  onExisting: (book: Book) => void;
}) {
  const [form, setForm] = useState<BookInput>({
    ...empty,
    ...initial,
    ...(book
      ? {
          title: book.title,
          author: book.author,
          isbn: book.isbn,
          published_year: book.published_year,
          ownership: book.ownership,
          reading: book.reading,
        }
      : {}),
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [looking, setLooking] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [results, setResults] = useState<Metadata[]>([]);
  const [metadataMessage, setMetadataMessage] = useState("");
  const matches = possibleMatches(
    books.filter((saved) => saved.id !== book?.id),
    form,
  );
  const change = <K extends keyof BookInput>(key: K, value: BookInput[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  async function lookup(byIsbn: boolean) {
    if (!canWrite) return;
    setLooking(true);
    setMetadataMessage("");
    setError("");
    setResults([]);
    try {
      if (byIsbn) {
        const isbn = normalizeIsbn(form.isbn || "");
        const { book: metadata } = await api.metadata(isbn);
        if (metadata) {
          setForm((current) => ({ ...current, ...metadata }));
          setMetadataMessage("Details found. Review them before saving.");
        } else
          setMetadataMessage(
            "No details found for this edition. You can enter them below.",
          );
      } else {
        const { items } = await api.search(searchQuery);
        setResults(items);
        if (!items.length)
          setMetadataMessage(
            "No results found. You can enter the details below.",
          );
      }
    } catch (error) {
      setMetadataMessage((error as Error).message);
    } finally {
      setLooking(false);
    }
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canWrite || looking) return;
    const parsed = bookInputSchema.safeParse(form);
    if (!parsed.success) {
      setError(parsed.error.issues[0].message);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSaved(await api.save(parsed.data, book?.id));
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && error.book)
        onExisting(error.book);
      else setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      title={book ? "Edit book" : "A new book for your shelf"}
      onClose={busy ? () => {} : onClose}
      wide
    >
      <form onSubmit={submit} className="book-form">
        <p className="dialog-intro">
          {book
            ? "Keep the details and shelves just right."
            : "A new discovery, an old favorite. Make a little space for it."}
        </p>
        {!book && (
          <div className="metadata-search">
            <label htmlFor="metadata-query">
              Find book details <span>optional</span>
            </label>
            <div className="input-with-button">
              <input
                id="metadata-query"
                placeholder="Search Open Library by title or author"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                maxLength={100}
              />
              <button
                className="button secondary"
                type="button"
                disabled={!canWrite || looking || searchQuery.trim().length < 2}
                onClick={() => void lookup(false)}
              >
                {looking ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Search size={17} />
                )}
                <span className="sr-only">Search Open Library</span>
              </button>
            </div>
            {results.length > 0 && (
              <div className="metadata-results">
                {results.map((item, index) => (
                  <button
                    key={index}
                    type="button"
                    onClick={() => {
                      setForm((current) => ({
                        ...current,
                        title: item.title,
                        author: item.author,
                      }));
                      setResults([]);
                      setMetadataMessage(
                        "Title and author filled. Add the ISBN for your specific edition if you have it.",
                      );
                    }}
                  >
                    <span>
                      <strong>{item.title}</strong>
                      <small>{item.author || "Author unknown"}</small>
                    </span>
                    <Plus size={17} />
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <label htmlFor="book-isbn">
          ISBN <span>optional</span>
        </label>
        <div className="input-with-button">
          <input
            id="book-isbn"
            value={form.isbn || ""}
            onChange={(event) => change("isbn", event.target.value || null)}
            placeholder="10 or 13 digits"
            maxLength={32}
            autoComplete="off"
          />
          <button
            type="button"
            className="button secondary"
            disabled={!canWrite || !form.isbn || looking}
            onClick={() => void lookup(true)}
          >
            {looking ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Download size={17} />
            )}
            Look up
          </button>
        </div>
        {metadataMessage && (
          <p className="message" role="status">
            {metadataMessage}
          </p>
        )}
        <label htmlFor="book-title">
          Title <span className="required">required</span>
        </label>
        <input
          id="book-title"
          value={form.title}
          onChange={(event) => change("title", event.target.value)}
          placeholder="What’s the book called?"
          maxLength={255}
          required
        />
        <div className="form-columns">
          <div>
            <label htmlFor="book-author">
              Author <span>optional</span>
            </label>
            <input
              id="book-author"
              value={form.author || ""}
              onChange={(event) => change("author", event.target.value || null)}
              placeholder="Author’s name"
              maxLength={255}
            />
          </div>
          <div>
            <label htmlFor="book-year">
              Published year <span>optional</span>
            </label>
            <input
              id="book-year"
              type="number"
              min="0"
              max="2100"
              step="1"
              value={form.published_year ?? ""}
              onChange={(event) =>
                change(
                  "published_year",
                  event.target.value === "" ? null : Number(event.target.value),
                )
              }
              placeholder="e.g. 2024"
            />
          </div>
        </div>
        <fieldset>
          <legend>Where does it belong?</legend>
          <p className="field-hint">Choose one ownership state.</p>
          <div className="segmented">
            {(Object.entries(ownershipLabels) as [Ownership, string][]).map(
              ([value, label]) => (
                <button
                  type="button"
                  aria-pressed={form.ownership === value}
                  key={value}
                  className={form.ownership === value ? "selected" : ""}
                  onClick={() => change("ownership", value)}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        </fieldset>
        <fieldset>
          <legend>Your reading chapter</legend>
          <p className="field-hint">Choose one reading state.</p>
          <div className="segmented">
            {(Object.entries(readingLabels) as [Reading, string][]).map(
              ([value, label]) => (
                <button
                  type="button"
                  aria-pressed={form.reading === value}
                  key={value}
                  className={form.reading === value ? "selected" : ""}
                  onClick={() => change("reading", value)}
                >
                  {label}
                </button>
              ),
            )}
          </div>
        </fieldset>
        {!!matches.length && (
          <div className="message warning related-books">
            <strong>A familiar story?</strong>
            <span>
              You have possible matching editions. This one will stay separate.
            </span>
            {matches.map((match) => (
              <button
                type="button"
                className="text-button"
                key={match.id}
                onClick={() => onExisting(match)}
              >
                {match.title}
                {match.isbn ? ` · ${match.isbn}` : ""}
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
        )}
        {!canWrite && (
          <p className="message warning">
            Reconnect and sign in to save changes.
          </p>
        )}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button
            className="button secondary"
            type="button"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            className="button primary"
            disabled={busy || looking || !canWrite}
          >
            {busy ? (
              <LoaderCircle className="spin" size={17} />
            ) : (
              <Check size={17} />
            )}
            {book ? "Save changes" : "Add to bookshelf"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function BookDetail({
  book,
  canWrite,
  onClose,
  onEdit,
  onDeleted,
}: {
  book: Book;
  canWrite: boolean;
  onClose: () => void;
  onEdit: () => void;
  onDeleted: (id: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function remove() {
    if (!canWrite) return;
    setBusy(true);
    setError("");
    try {
      await api.remove(book.id);
      await onDeleted(book.id);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog title="On your bookshelf" onClose={busy ? () => {} : onClose}>
      <div className="detail-content">
        <Cover book={book} large />
        <h2>{book.title}</h2>
        <p className="detail-author">{book.author || "Author not added"}</p>
        <Badges book={book} />
        <dl className="book-facts">
          <div>
            <dt>ISBN</dt>
            <dd>{book.isbn || "Not added"}</dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd>{book.published_year ?? "Not added"}</dd>
          </div>
          <div>
            <dt>Added to your shelf</dt>
            <dd>
              {new Date(book.created_at).toLocaleDateString(undefined, {
                year: "numeric",
                month: "short",
                day: "numeric",
              })}
            </dd>
          </div>
        </dl>
        {!canWrite && (
          <p className="message">
            You’re viewing a saved copy. Connect and sign in to edit.
          </p>
        )}
        {error && (
          <p className="message error" role="alert">
            {error}
          </p>
        )}
        {confirming ? (
          <div className="delete-confirm">
            <strong>Remove this book from your library?</strong>
            <p>This removes this edition and its saved states.</p>
            <div>
              <button
                className="button secondary"
                onClick={() => setConfirming(false)}
                disabled={busy}
              >
                Keep book
              </button>
              <button
                className="button danger"
                onClick={() => void remove()}
                disabled={busy || !canWrite}
              >
                {busy ? (
                  <LoaderCircle className="spin" size={17} />
                ) : (
                  <Trash2 size={17} />
                )}
                Remove book
              </button>
            </div>
          </div>
        ) : (
          <div className="dialog-actions">
            <button
              className="button text-danger"
              onClick={() => setConfirming(true)}
              disabled={!canWrite}
            >
              <Trash2 size={17} />
              Remove
            </button>
            <button
              className="button primary"
              onClick={onEdit}
              disabled={!canWrite}
            >
              <Pencil size={17} />
              Edit book
            </button>
          </div>
        )}
      </div>
    </Dialog>
  );
}
