/* Offline service worker for the MUWCI 24H Race app. */
const VERSION = "__VERSION__";
const CACHE = `muwci-race-${VERSION}`;
const FILES = __FILES__;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      // Cache each file separately so one failure doesn't stop the rest.
      await Promise.all(FILES.map((f) => cache.add(new Request(f, { cache: "reload" })).catch(() => {})));
    }).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k.startsWith("muwci-race-") && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const networkFirst = async (request, fallbackKey, timeoutMs) => {
  const cache = await caches.open(CACHE);
  try {
    const response = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    if (response.ok) cache.put(fallbackKey || request, response.clone());
    return response;
  } catch (error) {
    const cached = await cache.match(fallbackKey || request);
    if (cached) return cached;
    throw error;
  }
};

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/", 4000));
    return;
  }
  if (url.pathname === "/__/firebase/init.json") {
    event.respondWith(networkFirst(request, "/__/firebase/init.json", 4000));
    return;
  }
  event.respondWith(
    caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((c) => c.put(request, response.clone()));
      return response;
    })),
  );
});
