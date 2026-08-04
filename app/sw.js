// GISCatasto Service Worker - offline tile cache only
// App shell (JS/CSS/HTML) is served directly from APK assets — no caching needed.
// Volatile cache: every tile viewed while browsing. This is the ONLY cache the
// cache-full prompt is allowed to wipe.
const TILE_CACHE = 'giscatasto-tiles-v1';

// Each saved offline basemap gets its own cache 'giscatasto-offline-<id>'. These
// are user-owned downloads: never evicted automatically, never wiped by the
// SW — only removed on explicit user action (✕ in the list, or Clear cache).
const OFFLINE_PREFIX = 'giscatasto-offline-';

// Safe mode: when the previous session was killed mid-tile-load, the page
// sets this so we short-circuit cache misses to 503 for a few seconds,
// letting Leaflet show blanks instead of piling up hanging fetches.
let _safeModeUntil = 0;

/* Strip rotating subdomains so tiles cached under 'a.' are found for 'b.' or 'c.'
   Handles: a./b./c. (OSM family) and mt0.-mt3. (Google Maps) */
function _normUrl(url) {
  return url.replace(/^(https?:\/\/)([a-c]|mt\d+)\./, '$1');
}

/* Detect slippy-map tile requests.
   Rule 1 — generic z/x/y path: covers OSM, ArcGIS, WMTS, and any user-added XYZ server.
   Rule 2 — Google query-string tiles: x/y/z in params, not in path.
   Rule 3 — WMS GetMap: one image per tile, addressed by BBOX instead of z/x/y. Without
   this a WMS basemap goes through the network every time — it is served neither from a
   downloaded offline map nor from the browsing cache, which looks exactly like a broken
   offline download. Both parameters are required: a GetCapabilities or a full-viewport
   GetMap from the overlay renderer must not be mistaken for a tile. */
function _isTileUrl(url) {
  if (/\/\d+\/\d+\/\d+(\.\w{2,5})?(\?.*)?$/.test(url)) return true;
  if (/[?&]request=getmap(&|$)/i.test(url) && /[?&]bbox=/i.test(url)) return true;
  return (
    (url.includes('google.com')     && (url.includes('lyrs=') || url.includes('/vt/'))) ||
    (url.includes('googleapis.com') && (url.includes('/kh?')  || url.includes('/vt?')))
  );
}

/* Fetch a tile trying CORS first (readable, cacheable response), then no-cors.
   CORS responses (Access-Control-Allow-Origin: *) render correctly offline.
   No-cors is the fallback only when CORS is rejected at the transport/header
   level (server lacks CORS); in that case the opaque response is the only way
   to get pixels. If CORS succeeds but the server returns a non-ok status
   (429/5xx), we return that status directly — we do NOT retry as no-cors,
   because the response would be identical but opaque, and caching an opaque
   error poisons the cache permanently for that tile.
   Returns null on total network failure. */
async function _fetchTile(request) {
  let corsRejected = false;
  try {
    return await fetch(request.url, { mode: 'cors', credentials: 'omit' });
  } catch (_) { corsRejected = true; }
  if (corsRejected) {
    try {
      return await fetch(request.url, { mode: 'no-cors', credentials: 'omit' });
    } catch (_) {}
  }
  return null;
}

self.addEventListener('install', e => {
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  // Delete any old app-shell caches left over from previous versions.
  // IMPORTANT: preserve the volatile tile cache AND every offline-basemap
  // cache (giscatasto-offline-*) — those hold user downloads.
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== TILE_CACHE && !k.startsWith(OFFLINE_PREFIX))
          .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

/* Names of the offline-basemap caches, memoised so the common case (no offline
   basemaps) adds ZERO cost to a tile miss: an empty list is reused for 10 s
   instead of calling caches.keys() on every miss. The page also invalidates it
   instantly via an 'offlineChanged' message after a download/removal, so a
   just-downloaded area is served offline without waiting for the TTL. */
let _offNames = { list: null, at: 0 };
const _OFF_TTL = 10000;
async function _offlineCacheNames() {
  const now = Date.now();
  if (_offNames.list && (now - _offNames.at) < _OFF_TTL) return _offNames.list;
  let list = [];
  try { list = (await caches.keys()).filter(k => k.startsWith(OFFLINE_PREFIX)); } catch (_) {}
  _offNames = { list, at: now };
  return list;
}

/* Look up a tile in the offline-basemap caches. Called only after a miss in the
   volatile cache. With no offline basemaps the memoised list is empty and this
   returns immediately. Returns the cached Response or null. */
async function _matchOffline(req) {
  const names = await _offlineCacheNames();
  for (const name of names) {
    try {
      const c = await caches.open(name);
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
    } catch (_) { /* skip a cache that can't be opened */ }
  }
  return null;
}

self.addEventListener('message', e => {
  const data = e.data || {};
  if (data.type === 'safeMode') {
    _safeModeUntil = Number(data.until) || 0;
    if (e.ports && e.ports[0]) e.ports[0].postMessage({ ack: true });
  } else if (data.type === 'offlineChanged') {
    _offNames = { list: null, at: 0 };   // force a refresh on the next miss
  }
});

self.addEventListener('fetch', e => {
  const url = e.request.url;

  /* ── Tile requests: cache-first (volatile → offline basemaps), then network ── */
  if (_isTileUrl(url)) {
    e.respondWith(
      caches.open(TILE_CACHE).then(async cache => {
        const normUrl = _normUrl(url);
        const normReq = new Request(normUrl);

        // 1. Volatile cache (the common hit path — nothing else is touched).
        const cached = await cache.match(normReq, { ignoreVary: true });
        if (cached) return cached;

        // 2. Offline-basemap caches (served even in safe mode: they are local
        //    and can't hang like a network fetch).
        const offlineHit = await _matchOffline(normReq);
        if (offlineHit) return offlineHit;

        // 3. Safe mode: right after a kill, don't pile up network fetches.
        if (Date.now() < _safeModeUntil) {
          return new Response('', { status: 503, statusText: 'SafeMode' });
        }

        // 4. Network. Successful tiles are cached into the VOLATILE cache only;
        //    offline caches are populated exclusively by explicit downloads.
        const response = await _fetchTile(e.request);
        if (!response) {
          return new Response('', { status: 503, statusText: 'Offline' });
        }

        if (response.ok || response.type === 'opaque') {
          // Best-effort write. Eviction is user-driven now (the cache-full
          // prompt) instead of running here on every fetch, which used to
          // stall rendering. If the device quota is exhausted, cache.put
          // rejects with QuotaExceededError — swallow it and still return the
          // network response so the map keeps working.
          cache.put(normReq, response.clone()).catch(() => {});
        }

        return response;
      })
    );
    return;
  }

  /* ── All other requests (app shell, APIs) → pass through to assets/network ── */
});
