import { normalizeIsbn } from "../shared/books";

export interface CoverSource {
  provider: "knihovny" | "openlibrary";
  url: string;
  href: string;
  label: string;
}

export function coverSources(value: string | null): CoverSource[] {
  if (!value) return [];
  let isbn: string;
  try {
    isbn = normalizeIsbn(value);
  } catch {
    return [];
  }
  const knihovny: CoverSource = {
    provider: "knihovny",
    url: `https://www.knihovny.cz/Cover/Show?isbn=${isbn}&size=large`,
    href: `https://www.knihovny.cz/Search/Results?lookfor=${isbn}&type=ISN`,
    label: "Knihovny.cz",
  };
  const openlibrary: CoverSource = {
    provider: "openlibrary",
    url: `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`,
    href: `https://openlibrary.org/isbn/${isbn}`,
    label: "Open Library",
  };
  return isbn.startsWith("97880")
    ? [knihovny, openlibrary]
    : [openlibrary, knihovny];
}

export function isRealCover(
  provider: CoverSource["provider"],
  width: number,
  height: number,
): boolean {
  // Catalogs can return a successful response containing a blank image.
  // Knihovny.cz's unavailable-cover icon is 65 × 80 pixels.
  return (
    width > 1 &&
    height > 1 &&
    !(provider === "knihovny" && width === 65 && height === 80)
  );
}
