/* Opera field service worker.
 * Caches the field app shell and static assets so the driver workspace opens offline.
 * Never caches API responses (they contain recipient data) or file downloads.
 *
 * The first visit happens before this worker controls the page, so the page itself asks for its
 * shell and the assets it already loaded to be cached ({ type: "PRECACHE", urls }); after that one
 * online visit /field/<org> opens offline. Navigations are network-first and refresh the copy. */
const CACHE = "opera-field-v4";
const SHELL = /^\/field\/[^/]+\/?$/;

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const sameOrigin = (url) => url.origin === self.location.origin;
const isStatic = (url) => url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icon") || url.pathname === "/manifest.webmanifest" || url.pathname.startsWith("/fonts/");

/** Stores a copy of a good response. The copy is taken synchronously, before the original body is read. */
function store(req, res) {
  if (!res || !res.ok || res.type !== "basic" || res.redirected) return Promise.resolve();
  const copy = res.clone();
  return caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => undefined);
}

self.addEventListener("message", (event) => {
  const data = event.data || {};
  if (data.type === "PRECACHE" && Array.isArray(data.urls)) {
    const urls = data.urls
      .map((u) => { try { return new URL(u, self.location.origin); } catch { return null; } })
      .filter((u) => u && sameOrigin(u) && (isStatic(u) || SHELL.test(u.pathname)));
    event.waitUntil(
      Promise.all(urls.map((u) => fetch(u.href, { credentials: "same-origin", cache: "no-store" }).then((res) => store(new Request(u.href), res)).catch(() => undefined))).then(() => {
        if (event.source && event.source.postMessage) event.source.postMessage({ type: "PRECACHED", count: urls.length });
      }),
    );
  }
  if (data.type === "CLEAR_SHELL") {
    // on sign-out: drop cached shells (they carry the signed-in agent's name)
    event.waitUntil(caches.open(CACHE).then((c) => c.keys().then((keys) => Promise.all(keys.filter((k) => SHELL.test(new URL(k.url).pathname)).map((k) => c.delete(k))))));
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (!sameOrigin(url)) return;
  if (url.pathname.startsWith("/api/")) return; // PII — network only
  if (isStatic(url)) {
    event.respondWith(
      caches.open(CACHE).then(async (c) => {
        const hit = await c.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        event.waitUntil(store(req, res));
        return res;
      }),
    );
    return;
  }
  if (req.mode === "navigate" && SHELL.test(url.pathname)) {
    // network-first for the (data-free) shell, fall back to the cached shell when offline
    event.respondWith(
      fetch(req)
        .then((res) => {
          event.waitUntil(store(new Request(url.origin + url.pathname), res));
          return res;
        })
        .catch(async () => (await caches.match(url.origin + url.pathname, { ignoreVary: true, ignoreSearch: true })) || Response.error()),
    );
  }
});
