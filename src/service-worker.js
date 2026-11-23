const CACHE = "booxs-shell-__VERSION__";
const ASSETS = __PRECACHE__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      // Reject redirects and invalid assets rather than caching an error page.
      await Promise.all(
        ASSETS.map(async (path) => {
          const response = await fetch(
            new Request(path, {
              credentials: "same-origin",
              cache: "reload",
              redirect: "error",
            }),
          );
          if (
            !response.ok ||
            (path.endsWith(".js") &&
              !/javascript/.test(response.headers.get("content-type") || ""))
          )
            throw new Error("Precache failed");
          await cache.put(path, response);
        }),
      );
      await self.skipWaiting();
    })(),
  );
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("booxs-shell-") && key !== CACHE)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/cdn-cgi/")
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      // Navigation stays network-first; private API responses are never cached.
      if (event.request.mode === "navigate") {
        try {
          return await fetch(event.request);
        } catch {
          return (await cache.match("/")) || Response.error();
        }
      }
      return (await cache.match(url.pathname)) || fetch(event.request);
    })(),
  );
});
