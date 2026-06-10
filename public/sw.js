const CACHE = "aitrends-v2";
const PRECACHE = ["/", "/login"];

self.addEventListener("install", (e) => {
  // Cache each URL individually instead of cache.addAll(), which rejects
  // the whole batch if any single request returns non-2xx. "/" often
  // redirects to "/login" or "/dashboard" based on auth state, and a
  // redirect counts as a failure here — that was throwing "Failed to
  // execute 'addAll' on 'Cache': Request failed" on every install.
  e.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        PRECACHE.map((url) =>
          cache.add(url).catch((err) => {
            console.warn(`[sw] precache skipped for ${url}:`, err);
          })
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  // Only cache GET requests for same-origin navigation
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
