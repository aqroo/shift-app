const CACHE_NAME = "shiftapp-v2";
const APP_FILES = ["./", "./index.html", "./styles.css", "./app.js", "./scheduler.js"];
const STATIC_FILES = ["./manifest.json", "./icon-192.png", "./icon-512.png", "./apple-touch-icon.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll([...APP_FILES, ...STATIC_FILES]))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  const isAppFile = APP_FILES.some((f) => url.pathname.endsWith(f.replace("./", "")) || url.pathname.endsWith("/"));

  if (isAppFile) {
    // アプリ本体(HTML/CSS/JS)はネットワーク優先。更新をすぐ反映させ、
    // オフライン時のみキャッシュにフォールバックする。
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request).then((c) => c || caches.match("./index.html")))
    );
  } else {
    // アイコン等の静的ファイルはキャッシュ優先(ほぼ変化しないため)
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
  }
});
