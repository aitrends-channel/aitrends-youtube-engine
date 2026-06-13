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
  // Only intercept GET requests — POSTs and other methods pass
  // through to the network normally so the SW can never replay a
  // mutating request from cache.
  if (e.request.method !== "GET") return;
  e.respondWith((async () => {
    try {
      // Network-first: serve the freshest copy whenever the user is
      // online. The catch below handles network failures.
      return await fetch(e.request);
    } catch (networkErr) {
      // Fall back to the cache. caches.match resolves to undefined
      // when there's no entry — handing undefined to respondWith
      // throws "Failed to convert value to 'Response'" and the
      // accompanying "FetchEvent resulted in a network error
      // response" pair which obscure the real (network) cause.
      // Only return the cached Response when we actually have one;
      // otherwise re-throw so the browser surfaces a normal
      // network error in the console and the page's own retry /
      // offline handling can react to it.
      const cached = await caches.match(e.request);
      if (cached) return cached;
      throw networkErr;
    }
  })());
});
