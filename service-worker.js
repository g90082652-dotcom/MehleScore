const CACHE_NAME = "aliscore-shell-v1";

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(["/", "/index.html", "/manifest.json"])
    ).catch(() => {})
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", event => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request).then(r => r || caches.match("/")))
  );
});

self.addEventListener("push", event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  const title = data.title || "AliScore";
  const body = data.body || "Yeni AliScore bildirişi";
  const payload = data.data || {};

  const options = {
    body,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: payload.type || "aliscore",
    renotify: true,
    data: payload
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();

  event.waitUntil((async () => {
    const clientsList = await clients.matchAll({
      type: "window",
      includeUncontrolled: true
    });

    const target = clientsList[0];
    if (target) {
      await target.focus();
      return;
    }

    await clients.openWindow("/");
  })());
});
