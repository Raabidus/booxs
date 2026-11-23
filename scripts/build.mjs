import { build } from "vite";
import sharp from "sharp";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";

await build();
const icon = await readFile("public/icon.svg");
await Promise.all([
  sharp(icon).resize(192, 192).png().toFile("dist/icon-192.png"),
  sharp(icon).resize(512, 512).png().toFile("dist/icon-512.png"),
  sharp(icon).resize(180, 180).png().toFile("dist/apple-touch-icon.png"),
  sharp(icon)
    .resize(384, 384)
    .extend({ top: 64, bottom: 64, left: 64, right: 64, background: "#142d28" })
    .png()
    .toFile("dist/icon-maskable.png"),
]);
const files = (
  await readdir("dist", { recursive: true, withFileTypes: true })
).filter((file) => file.isFile() && file.name !== "_headers");
const paths = files
  .map(
    (file) =>
      "/" +
      file.parentPath.replace(/^dist\/?/, "").replace(/\/$/, "") +
      "/" +
      file.name,
  )
  .map((path) => path.replaceAll("//", "/"));
const hash = createHash("sha256");
for (const path of paths.sort()) hash.update(await readFile("dist" + path));
const template = await readFile("src/service-worker.js", "utf8");
hash.update(template);
const version = hash.digest("hex").slice(0, 16);
// Workers redirects /index.html to /. Cache the canonical URL, since redirects
// are rejected intentionally to avoid caching an Access login page.
await writeFile(
  "dist/sw.js",
  template
    .replace(
      "__PRECACHE__",
      JSON.stringify(
        paths.map((path) => (path === "/index.html" ? "/" : path)),
      ),
    )
    .replace("__VERSION__", version),
);
console.log(`PWA ready: ${paths.length} offline assets (${version}).`);
