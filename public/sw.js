// Service worker du contrôle d'entrée : permet de rouvrir l'écran de contrôle sans connexion.
// - Pages /control/… : réseau d'abord, copie en cache si le réseau ne répond pas.
// - Fichiers /_next/static/… (immuables) : cache d'abord.
// Rien d'autre n'est intercepté : les appels d'API restent toujours en direct.

const PAGES = "controle-pages-v1";
const STATIC = "controle-static-v1";
const PAGE_TIMEOUT_MS = 4000;

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (key.startsWith("controle-") && key !== PAGES && key !== STATIC) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/_next/static/")) event.respondWith(cacheFirst(req));
  else if (req.mode === "navigate" && url.pathname.startsWith("/control/")) event.respondWith(controlPage(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function controlPage(req) {
  const cache = await caches.open(PAGES);
  const network = fetch(req).then((res) => {
    // Une redirection (session fermée → /login) ne remplace pas la copie de l'écran de contrôle.
    if (res.ok && !res.redirected) cache.put(req, res.clone());
    return res;
  });
  const timeout = new Promise((resolve) => setTimeout(resolve, PAGE_TIMEOUT_MS, null));
  try {
    const res = await Promise.race([network, timeout]);
    if (res) return res;
  } catch {
    // Pas de réseau : copie en cache ci-dessous.
  }
  const cached = (await cache.match(req)) || (await cache.match(req, { ignoreSearch: true }));
  if (cached) return cached;
  return network.catch(
    () =>
      new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Hors connexion</title>' +
          '<body style="font-family:system-ui;padding:2rem;background:#020617;color:#fff"><h1>Hors connexion</h1>' +
          "<p>Cet écran de contrôle n'a pas encore été ouvert sur cet appareil avec internet. Reconnectez-vous une première fois pour le préparer.</p>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
      ),
  );
}
