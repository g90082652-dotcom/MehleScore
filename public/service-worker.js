const CACHE_NAME = "aliscore-push-v5";

self.addEventListener("install", event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { title: "AliScore", body: event.data ? event.data.text() : "Yeni bildiriş" };
  }

  const title = data.title || "AliScore";
  const payload = data.data || {};
  const options = {
    body: data.body || "AliScore-da yeni hadisə var.",
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: payload,
    tag: payload.type ? "aliscore-" + payload.type : "aliscore-notification",
    renotify: true,
    requireInteraction: false
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const target = "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(clients => {
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
