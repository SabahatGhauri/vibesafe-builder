// Injects installability into a generated app's HTML — a manifest, home-screen
// icon, and (for published apps only, where we control the origin) a service
// worker registration for offline caching. Runs as a deterministic wrapper step
// at download/publish time, never touching the AI-generated code stored in
// version history — same principle as the security scan: a backend guarantee,
// not something the model has to remember to do.
const BRAND_ICON_SVG =
  "%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230a0d11'/%3E%3Cpath d='M32 10 L50 32 L32 54 L14 32 Z' fill='%238b5cf6'/%3E%3C/svg%3E";
const ICON_HREF = "data:image/svg+xml," + BRAND_ICON_SVG;

function buildManifestHref(title) {
  const name = (title || "My App").slice(0, 45);
  const shortName = name.length > 14 ? name.slice(0, 14) : name;
  const manifest = {
    name,
    short_name: shortName,
    start_url: ".",
    display: "standalone",
    background_color: "#0a0d11",
    theme_color: "#8b5cf6",
    icons: [{ src: ICON_HREF, sizes: "512x512", type: "image/svg+xml", purpose: "any" }],
  };
  return "data:application/manifest+json," + encodeURIComponent(JSON.stringify(manifest));
}

// swUrl: when set (publish path only), also registers a service worker at that
// URL for offline caching. Downloaded standalone files skip this — a file opened
// from disk has no network dependency to cache in the first place.
function injectPWATags(html, { swUrl } = {}) {
  const titleMatch = html.match(/<title>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : null;

  let tags =
    `<meta name="mobile-web-app-capable" content="yes">\n` +
    `<meta name="apple-mobile-web-app-capable" content="yes">\n` +
    `<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">\n` +
    `<link rel="apple-touch-icon" href="${ICON_HREF}">\n` +
    `<link rel="manifest" href="${buildManifestHref(title)}">`;

  if (!/<meta[^>]*name=["']viewport["']/i.test(html)) {
    tags = `<meta name="viewport" content="width=device-width, initial-scale=1">\n` + tags;
  }
  if (swUrl) {
    tags +=
      `\n<script>if("serviceWorker" in navigator){window.addEventListener("load",` +
      `()=>navigator.serviceWorker.register(${JSON.stringify(swUrl)}).catch(()=>{}));}</script>`;
  }

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + "\n" + tags);
  }
  // No <head> found (shouldn't happen — code is validated to contain <html> before
  // this runs) — fall back to prepending so installability still applies.
  return tags + "\n" + html;
}

// The service worker itself, scoped to one published app's cache. Cache-first for
// the app shell, falling back to network so a republish is picked up once online.
function buildServiceWorker(id, appPath) {
  return `
const CACHE = ${JSON.stringify("vibesafe-app-" + id + "-v1")};
const APP_URL = ${JSON.stringify(appPath)};
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.add(APP_URL)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const fetchPromise = fetch(e.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
          return res;
        })
        .catch(() => cached);
      return cached || fetchPromise;
    })
  );
});
`.trim();
}

module.exports = { injectPWATags, buildServiceWorker };
