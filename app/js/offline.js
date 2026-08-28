/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
/* =====================================================
   OFFLINE — cache tile sets for offline use
   Storage: Service Worker Cache API (giscatasto-tiles-v1)
===================================================== */

(function () {

  const AVG_TILE_KB    = 15;
  const MAX_SIZE_GB    = 4;
  // Sources that prohibit bulk/offline tile download → hard-blocked from the
  // downloader. Matched by the live tile URL, so a private override that repoints
  // the same basemap key to another provider (e.g. basemaps-private.js) is NOT
  // affected.
  //
  // Every bundled basemap is on this list as of 2026-08-01. Until then these six
  // only raised a "check the ToS" notice and let the download proceed, which put
  // the decision on the user while the requests still left this app: the OSMF tile
  // policy forbids bulk downloading outright, OpenTopoMap is a smaller volunteer
  // server again, and Esri does not allow offline caching without a licence.
  //
  // Consequence, accepted when the sources were chosen: out of the box there is
  // nothing left to download offline. What restores the feature is preloading the
  // regional services (AGEA orthophotos, CTR), which do permit caching — until
  // then the downloader only offers basemaps the user has added themselves.
  const OFFLINE_BLOCKED_HOSTS = [
    'stadiamaps.com',
    'tile.openstreetmap.org',      // OSMF tile usage policy: bulk downloading forbidden
    'tile.opentopomap.org',        // volunteer-run, same policy family
    'basemaps.cartocdn.com',       // CARTO free tier
    'cartodb-basemaps',            // same provider, older CDN hostname: three bundled maps in
                                   // giscatasto-config.json still use it and slipped past the
                                   // cartocdn match above
    'services.arcgisonline.com',   // Esri: no offline caching without a licence
    // Not bundled, but reachable by typing the URL into "Add web map": Google's tile
    // endpoints are not an open service at all and caching them is squarely prohibited.
    'google.com',
    'googleapis.com'
  ];
  function _offlineBlocked(entry) {
    const u = entry && typeof entry._url === 'string' ? entry._url : '';
    return OFFLINE_BLOCKED_HOSTS.some(h => u.indexOf(h) !== -1);
  }
  // Bundled sources whose terms were read and do allow local copies. Everything else on
  // offer is something the user added, whose terms we cannot know: rather than block more
  // hosts — which a mirror defeats anyway — the download asks the user to state it.
  const VETTED_OFFLINE = ['pcn_ortho'];
  const _needsAck = mapId => VETTED_OFFLINE.indexOf(mapId) === -1;
  const TILE_CACHE_NAME = 'giscatasto-tiles-v1';        // volatile (browsing) cache
  const OFFLINE_PREFIX  = 'giscatasto-offline-';        // one dedicated cache per saved basemap
  const _offlineCacheName = id => OFFLINE_PREFIX + id;
  const DL_CONCURRENCY = 3;     // parallel tile fetches
  const DL_DELAY_MS    = 50;    // ms pause between batches (rate-limit)
  const TILE_TIMEOUT_MS = 8000; // hard JS-side cap per request

  let _downloading      = false;
  let _cancelled        = false;
  let _batchAbort       = null;

  /* Bounded fetch: WebView/Cordova may not honour AbortSignal on in-flight
     TCP requests, so we race the fetch against a JS timeout and a cancel
     poller — guaranteeing each tile call resolves in bounded time even if
     the underlying socket hangs.  Returns { kind, response } so the caller
     can distinguish a real CORS rejection (→ fall back to no-cors) from a
     timeout/cancel (→ skip, do not fall back).  Timers are always cleared
     so no setInterval/setTimeout outlives the call. */
  function _fetchBounded(url, opts) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => {
        if (done) return;
        done = true;
        clearTimeout(toId);
        clearInterval(intId);
        resolve(v);
      };
      const toId = setTimeout(() => finish({ kind: 'timeout' }), TILE_TIMEOUT_MS);
      const intId = setInterval(() => { if (_cancelled) finish({ kind: 'cancel' }); }, 100);
      fetch(url, opts).then(
        r => finish({ kind: 'ok', response: r }),
        () => finish({ kind: 'reject' })
      );
    });
  }

  /* ===== TILE MATH ===== */
  function _lonToX(lon, z) {
    return Math.floor((lon + 180) / 360 * Math.pow(2, z));
  }
  function _latToY(lat, z) {
    const rad = lat * Math.PI / 180;
    return Math.floor((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2 * Math.pow(2, z));
  }
  function _range(bounds, z) {
    return {
      xMin: _lonToX(bounds.getWest(), z),  xMax: _lonToX(bounds.getEast(), z),
      yMin: _latToY(bounds.getNorth(), z), yMax: _latToY(bounds.getSouth(), z)
    };
  }
  function _countTiles(bounds, maxZ, minZ) {
    let n = 0;
    for (let z = minZ || 1; z <= maxZ; z++) {
      const r = _range(bounds, z);
      n += (r.xMax - r.xMin + 1) * (r.yMax - r.yMin + 1);
    }
    return n;
  }

  /* ===== KML → bounds ===== */
  function _kmlBounds(kmlText) {
    const doc = new DOMParser().parseFromString(kmlText, 'text/xml');
    const pts = [];
    doc.querySelectorAll('coordinates').forEach(el => {
      el.textContent.trim().split(/\s+/).forEach(t => {
        const p = t.split(',');
        if (p.length >= 2) {
          const lon = parseFloat(p[0]), lat = parseFloat(p[1]);
          if (!isNaN(lon) && !isNaN(lat)) pts.push(L.latLng(lat, lon));
        }
      });
    });
    return pts.length ? L.latLngBounds(pts) : null;
  }

  /* ===== TILE URL ===== */
  /* Build the URL from the raw Leaflet template (_url) rather than calling
     getTileUrl(), which internally reads _tileZoom — a property set only when
     the layer is currently active on the map.  Inactive basemaps have
     _tileZoom === undefined, making getTileUrl() produce URLs with z=NaN that
     never match any cached key.  Direct template substitution avoids this. */
  /* A WMS tile layer has a plain _url too — the service endpoint, with no {z}/{x}/{y} in
     it — so the template branch below would hand back the same URL for every tile. Its
     per-tile URL comes from a BBOX, which only getTileUrl() can build.
     Rather than recompute the bbox here (project/unproject round-trips would not land on
     the same floating point digits Leaflet produces, and the URLs have to match the cached
     ones byte for byte), borrow Leaflet's own getTileUrl and lend it what onAdd would have
     set. That is also why the loop below cannot simply require the layer to be active:
     you can download a basemap you are not currently looking at. Restored on the way out,
     so an inactive layer is left exactly as it was found. */
  function _wmsTileUrl(entry, z, x, y) {
    const primed = !entry._map;
    // Everything onAdd/_resetView would have set, snapshotted so an inactive layer is left
    // untouched. _globalTileRange is not optional: TileLayer.getTileUrl reads it as soon as
    // _map is set (for the -y variable), and without it this throws instead of returning
    // a URL — which is exactly the silent "downloads nothing" this whole fix is about.
    const crsKey = parseFloat(entry.wmsParams.version) >= 1.3 ? 'crs' : 'srs';
    const snap = { map: entry._map, crs: entry._crs, ver: entry._wmsVersion,
                   range: entry._globalTileRange, par: entry.wmsParams[crsKey] };
    try {
      if (primed) {
        entry._map = map;
        entry._crs = entry.options.crs || map.options.crs;
        entry._wmsVersion = parseFloat(entry.wmsParams.version);
        entry.wmsParams[crsKey] = entry._crs.code;
        entry._globalTileRange = entry._pxBoundsToTileRange(map.getPixelWorldBounds(z));
      }
      const coords = L.point(x, y); coords.z = z;
      return entry.getTileUrl(coords);
    } catch (_) {
      return null;
    } finally {
      if (primed) {
        entry._map = snap.map; entry._crs = snap.crs; entry._wmsVersion = snap.ver;
        entry._globalTileRange = snap.range;
        if (snap.par === undefined) delete entry.wmsParams[crsKey];
        else entry.wmsParams[crsKey] = snap.par;
      }
    }
  }

  function _tileUrl(mapId, z, x, y) {
    const entry = BASEMAPS[mapId];
    if (!entry || entry._needsCreds) return null;

    if (entry.wmsParams) return _wmsTileUrl(entry, z, x, y);

    const template = (typeof entry._url === 'string') ? entry._url : '';
    if (template) {
      const subdomain = (() => {
        const s = entry.options && entry.options.subdomains;
        if (!s) return 'a';
        const arr = Array.isArray(s) ? s : String(s).split('');
        return arr[(x + y) % arr.length];
      })();
      return template
        .replace(/\{s\}/g, subdomain)
        .replace(/\{z\}/g, z)
        .replace(/\{x\}/g, x)
        .replace(/\{y\}/g, y)
        .replace(/\{r\}/g, '');   // retina suffix — omit for offline tiles
    }

    // Fallback for layer types without a plain _url (e.g. WMS sublayers)
    if (typeof entry.getTileUrl !== 'function') return null;
    const coords = L.point(x, y); coords.z = z;
    try { return entry.getTileUrl(coords); } catch (_) { return null; }
  }

  /* ===== SW CACHE HELPERS ===== */
  async function _openCache(name) {
    if (!window.caches) return null;
    try { return await caches.open(name); } catch (_) { return null; }
  }
  function _openTileCache() { return _openCache(TILE_CACHE_NAME); }

  /* Tell the SW its cached list of offline caches is stale (a basemap was
     added or removed), so a just-changed cache is used on the next tile miss
     without waiting for the SW's 10 s TTL. */
  function _notifySW() {
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({ type: 'offlineChanged' });
      }
    } catch (_) {}
  }

  /* Strip rotating subdomains so a tile cached from 'a.' is found when 'b.' requests it. */
  function _normUrl(url) {
    if (!url) return url;
    return url.replace(/^(https?:\/\/)(?:[a-c]\.|mt\d+\.)/, '$1');
  }

  async function _buildCachedSet(cache) {
    try {
      const keys = await cache.keys();
      return new Set(keys.map(r => _normUrl(r.url)));
    } catch (_) { return new Set(); }
  }

  /* ===== PROGRESS UI ===== */
  function _setProgress(done, total, visible, label) {
    const section = document.getElementById('offline-progress-section');
    const fill    = document.getElementById('offline-progress-fill');
    const text    = document.getElementById('offline-progress-text');
    const startB  = document.getElementById('btn-offline-start');
    const cancelB = document.getElementById('btn-offline-cancel');
    if (section) section.style.display = visible ? '' : 'none';
    if (visible && total > 0) {
      const pct = Math.round(done / total * 100);
      if (fill) fill.style.width = pct + '%';
      if (text) text.textContent = (label || 'Scansione') + ': ' +
        done.toLocaleString() + ' / ' + total.toLocaleString() + ' (' + pct + '%)';
    }
    if (startB)  startB.style.display  = visible ? 'none' : '';
    if (cancelB) cancelB.style.display = visible ? '' : 'none';
  }

  /* ===== DOWNLOAD MISSING TILES ===== */
  /* Fetches tiles absent from cachedSet and writes them directly into the
     Cache API (does not rely on SW interception, works also when the SW is
     inactive or out-of-scope, e.g. Cordova file:// origin).
     Strategy: try CORS first (readable response); on failure try no-cors
     (opaque response — browser can still render it as an <img> src).
     All zoom levels 1..maxZoom for the same extent are included. */
  async function _downloadMissing(bounds, maxZoom, mapId, cachedSet, destCache, volatileCache, minZoom) {
    const cache = destCache;

    const pending = [];
    for (let z = minZoom || 1; z <= maxZoom; z++) {
      const r = _range(bounds, z);
      for (let x = r.xMin; x <= r.xMax; x++) {
        for (let y = r.yMin; y <= r.yMax; y++) {
          const url = _tileUrl(mapId, z, x, y);
          if (url && !cachedSet.has(_normUrl(url))) pending.push(url);
        }
      }
    }
    if (!pending.length) return;

    let done = 0;
    _setProgress(0, pending.length, true, 'Download');

    for (let i = 0; i < pending.length && !_cancelled; i += DL_CONCURRENCY) {
      _batchAbort = new AbortController();
      const { signal } = _batchAbort;
      const batch = pending.slice(i, i + DL_CONCURRENCY);
      await Promise.all(batch.map(async url => {
        if (_cancelled) return;
        try {
          const normUrl = _normUrl(url);
          const normReq = new Request(normUrl);

          // Skip if already in the destination cache.
          if (cache && await cache.match(normReq, { ignoreVary: true })) return;

          // Reuse a copy already sitting in the volatile browsing cache instead
          // of re-downloading it (ignoreVary: CORS responses may have Vary: Origin).
          if (volatileCache) {
            const hit = await volatileCache.match(normReq, { ignoreVary: true });
            if (hit) { if (cache) await cache.put(normReq, hit.clone()); return; }
          }

          let response = null;
          let corsRejected = false;
          // Try CORS first: CORS-capable servers (OSM, Carto, ESRI) return
          // a readable response that caches cleanly and renders offline.
          // A non-ok status (429/5xx) means the server actively refused —
          // do NOT fall back to no-cors, otherwise the same error response
          // would be saved as an opaque "tile" and poison the offline basemap.
          const corsResult = await _fetchBounded(url, { mode: 'cors', credentials: 'omit', signal });
          if (corsResult.kind === 'ok' && corsResult.response.ok) {
            response = corsResult.response;
          } else if (corsResult.kind === 'reject') {
            corsRejected = true;
          }
          // Fallback no-cors only when CORS was rejected at transport level
          // (server lacks CORS headers): opaque response is the only way to
          // get pixels for servers that return real image data without CORS.
          // Timeouts and cancels are NOT eligible for fallback — would just
          // double the hang or re-fire the cancelled work.
          if (!response && corsRejected && !_cancelled) {
            const ncResult = await _fetchBounded(url, { mode: 'no-cors', credentials: 'omit', signal });
            if (ncResult.kind === 'ok') response = ncResult.response;
          }

          if (response && cache && (response.ok || response.type === 'opaque')) {
            await cache.put(normReq, response);
          }
        } catch (_) {}
      }));
      _batchAbort = null;
      done += batch.length;
      _setProgress(done, pending.length, true, 'Download');
      if (DL_DELAY_MS > 0) await new Promise(res => setTimeout(res, DL_DELAY_MS));
    }
  }

  /* ===== MAIN FLOW: scan → download missing → register basemap ===== */
  async function _startDownload(kmlText, maxZoom, mapId, mapName) {
    if (_downloading) { toastMsg('C’è già un’operazione in corso', 'error', undefined, 'sidebar'); return; }

    const bounds = _kmlBounds(kmlText);
    if (!bounds || !bounds.isValid()) { toastMsg('KML non valido: nessuna coordinata utilizzabile', 'error', undefined, 'sidebar'); return; }

    const entry = BASEMAPS[mapId];
    if (!entry) { toastMsg('Mappa non trovata', 'error', undefined, 'sidebar'); return; }
    if (_offlineBlocked(entry)) { toastMsg('Questa mappa non è scaricabile: il fornitore vieta il download massivo dei tile.', 'error', undefined, 'sidebar'); return; }
    maxZoom = Math.min(maxZoom, (entry.options && entry.options.maxZoom) || 18, 18);
    /* Never below the source's own minZoom. A regional technical map draws nothing outside
       its design scale, and the server answers those requests with an empty image — which
       lands in the cache as a black tile and is then served offline as if it were the map.
       Online the layer's minZoom hides the problem; the downloader used to ignore it. */
    const _minZ = Math.max(1, (entry.options && entry.options.minZoom) || 1);

    // The bundled providers that used to raise this are now blocked outright, so whatever
    // is still selectable is a source the user added: we cannot know its terms, and the
    // notice is the honest thing to show for all of them rather than for a fixed list.
    if (_needsAck(mapId)) {
      const ack = document.getElementById('offline-tos-ack');
      if (!ack || !ack.checked) {
        toastMsg('Conferma i termini d’uso della mappa prima di scaricarla', 'error', undefined, 'sidebar');
        return;
      }
    }

    const total  = _countTiles(bounds, maxZoom, _minZ);
    const sizeMB = (total * AVG_TILE_KB) / 1024;
    const sizeGB = sizeMB / 1024;
    if (sizeGB > MAX_SIZE_GB) {
      toastMsg('L’area supera il limite di ' + MAX_SIZE_GB + ' GB: riduci lo zoom o l’estensione.', 'error', undefined, 'sidebar');
      return;
    }

    // This basemap gets its own dedicated cache so the cache-full prompt can
    // never evict it. The id is generated up-front (before the download) so it
    // names the destination cache and, later, the registered layer.
    const id = 'offline_' + Date.now();
    const destCache     = await _openCache(_offlineCacheName(id));
    const volatileCache = await _openTileCache();   // may be null; used only to reuse browsed tiles
    if (!destCache) { toastMsg('Cache dei tile non disponibile (service worker non attivo)', 'error', undefined, 'sidebar'); return; }

    _downloading = true; _cancelled = false;
    let registered = false;
    _setProgress(0, total, true, 'Scansione');

    try {
      /* ── Phase 1: scan the dedicated cache (what's already downloaded for this
         basemap). A tile present only in the volatile browsing cache counts as
         "missing" here but is copied cheaply in Phase 2 rather than
         re-downloaded — so the dedicated cache always ends up self-contained
         and survives a volatile wipe. ── */
      const cachedSet = await _buildCachedSet(destCache);
      let checked = 0, found = 0;
      const SCAN_BATCH = 500;

      for (let z = _minZ; z <= maxZoom && !_cancelled; z++) {
        const r = _range(bounds, z);
        for (let x = r.xMin; x <= r.xMax && !_cancelled; x++) {
          for (let y = r.yMin; y <= r.yMax && !_cancelled; y++) {
            const url = _tileUrl(mapId, z, x, y);
            if (url && cachedSet.has(_normUrl(url))) found++;
            checked++;
            if (checked % SCAN_BATCH === 0) {
              _setProgress(checked, total, true, 'Scansione');
              await new Promise(res => setTimeout(res, 0));
            }
          }
        }
      }
      if (_cancelled) { toastMsg('Interrotto', '', undefined, 'sidebar'); return; }
      _setProgress(total, total, true, 'Scansione');

      const missing = total - found;
      const pct     = total > 0 ? Math.round(found / total * 100) : 0;
      const sizeStr = sizeMB >= 1024 ? sizeGB.toFixed(2) + ' GB' : Math.round(sizeMB) + ' MB';

      toastMsg(
        found.toLocaleString() + '/' + total.toLocaleString() + ' tile in cache (' + pct + '%)' +
        (missing > 0 ? ' — ne scarico ' + missing.toLocaleString() + ' mancanti\u2026' : ''),
        '', undefined, 'sidebar'
      );

      /* ── Phase 2: download uncached tiles (all zoom levels 1..maxZoom) ── */
      if (missing > 0) {
        await _downloadMissing(bounds, maxZoom, mapId, cachedSet, destCache, volatileCache, _minZ);
      }
      if (_cancelled) { toastMsg('Interrotto', '', undefined, 'sidebar'); return; }

      /* ── Phase 3: register as offline basemap ── */
      // Record the real tile count so the cache-full logic can size this
      // basemap later without enumerating the cache (which would freeze the UI).
      let tileCount = 0;
      try { tileCount = (await destCache.keys()).length; } catch (_) {}
      _registerLayer(mapName, mapId, maxZoom, id, tileCount, _minZ);
      registered = true;
      toastMsg('Basemap offline pronta: ' + mapName + ' (~' + sizeStr + ')', 'success', undefined, 'sidebar');

    } catch (e) {
      toastMsg('Errore: ' + e.message, 'error', undefined, 'sidebar');
    } finally {
      _downloading = false;
      _setProgress(0, 0, false);
      // Never leave an orphan cache behind: if we didn't register (cancel or
      // error), drop the dedicated cache we created for this attempt.
      if (!registered && window.caches) {
        try { await caches.delete(_offlineCacheName(id)); } catch (_) {}
      }
    }
  }

  /* ===== REGISTER OFFLINE BASEMAP ===== */
  function _registerLayer(name, sourceMapId, maxZoom, id, tiles, minZoom) {
    const sourceEntry = BASEMAPS[sourceMapId];
    if (!sourceEntry || typeof sourceEntry.getTileUrl !== 'function') {
      toastMsg('Impossibile ricavare l’URL dei tile per questa mappa', 'error', undefined, 'sidebar'); return;
    }

    /* WMS source: there is no {z}/{x}/{y} template to store, the URL is built per tile
       from a BBOX. Re-create the same kind of layer with the same parameters instead —
       Leaflet then generates exactly the URLs that were downloaded, because it is the
       same code with the same inputs. crs/srs are stripped on purpose: onAdd writes them
       back from the map, and passing crs as a string would land in options.crs (where a
       CRS object is expected) instead of the WMS parameters. */
    if (sourceEntry.wmsParams) {
      const p = L.extend({}, sourceEntry.wmsParams);
      delete p.crs; delete p.srs;
      BASEMAPS[id] = L.tileLayer.wms(sourceEntry._url, L.extend(p, {
        attribution: 'Offline: ' + name,
        uppercase: !!(sourceEntry.options && sourceEntry.options.uppercase),
        // The saved copy inherits the source's scale window: nothing was downloaded below
        // it, so requesting it offline would only produce misses — and, before this, the
        // black empty frames the server had answered with.
        minZoom: minZoom > 1 ? minZoom : undefined,
        maxZoom: maxZoom, maxNativeZoom: maxZoom
      }));
      // wmsParams travels in the config: on the next launch the entry has to be rebuilt as
      // a WMS layer, and a bare url + type 'wmts' would come back as a plain XYZ layer
      // requesting the endpoint with no BBOX — the very failure this fixes.
      const wcfg = { id, type: 'wms_tiles', url: sourceEntry._url, wmsParams: p,
        uppercase: !!(sourceEntry.options && sourceEntry.options.uppercase),
        maxZoom: maxZoom, name: 'Offline: ' + name, offline: true, tiles: tiles || 0 };
      if (minZoom > 1) wcfg.minZoom = minZoom;
      /* The saved copy of a paper map is still a paper map: without the marker the white
         backdrop stays off and the downloaded CTR sits on the dark UI, which is the very
         thing the backdrop exists to prevent. */
      const _src = (typeof customMapConfigs !== 'undefined')
        ? customMapConfigs.find(c => c.id === sourceMapId) : null;
      if (_src && _src.group) wcfg.group = _src.group;
      customMapConfigs.push(wcfg);
      _autoSaveConfig();
      _addBasemapUI(wcfg);
      _notifySW();
      return;
    }

    // Use the raw Leaflet template URL (_url) so variable order is preserved
    // exactly as defined (e.g. ESRI uses {z}/{y}/{x}, not {z}/{x}/{y}).
    // Reconstructing from getTileUrl() at z=1,x=0,y=0 produces the wrong
    // template for any server that doesn't use the {z}/{x}/{y} convention.
    let templateUrl = '';
    try { templateUrl = sourceEntry._url || ''; } catch (_) {}
    if (!templateUrl) {
      // Fallback for unusual layer types without _url
      try {
        const sampleCoords = L.point(0, 0); sampleCoords.z = 1;
        templateUrl = sourceEntry.getTileUrl(sampleCoords).replace('/1/0/0', '/{z}/{x}/{y}');
      } catch (_) { templateUrl = ''; }
    }

    BASEMAPS[id] = L.tileLayer(templateUrl, {
      attribution: 'Offline: ' + name,
      minZoom: minZoom > 1 ? minZoom : undefined,
      maxZoom: maxZoom, maxNativeZoom: maxZoom
    });
    const cfg = { id, type: 'wmts', url: templateUrl, name: 'Offline: ' + name, offline: true, tiles: tiles || 0 };
    const _src2 = (typeof customMapConfigs !== 'undefined')
      ? customMapConfigs.find(c => c.id === sourceMapId) : null;
    if (_src2 && _src2.group) cfg.group = _src2.group;
    customMapConfigs.push(cfg);
    _autoSaveConfig();
    _addBasemapUI(cfg);
    _notifySW();
  }

  /* ===== REMOVE ONE OFFLINE BASEMAP (entry only — caller deletes its cache) =====
     Drops the layer, its config entry and its list row. If it is the active
     basemap, falls back to OpenTopoMap. Defensive: every global it touches is
     guarded so a partial app state can't throw here. */
  function _purgeOfflineEntry(id) {
    try {
      // Fall back to the app's own default. This said 'osm' — OpenTopoMap — which is not the
      // default here and has not been since it became 'osm_std': removing the active offline
      // map quietly moved the user to a different map than the one the rest of the code
      // treats as home (map.js does use 'osm_std' on the same fallback).
      if (typeof currentBasemapId !== 'undefined' && currentBasemapId === id && typeof switchBasemap === 'function') {
        switchBasemap('osm_std');
        const osmRadio = document.querySelector('#basemap-list input[name="basemap"][value="osm_std"]');
        if (osmRadio) osmRadio.checked = true;
      }
    } catch (_) {}
    try { if (typeof BASEMAPS !== 'undefined') delete BASEMAPS[id]; } catch (_) {}
    try {
      if (typeof customMapConfigs !== 'undefined') {
        const i = customMapConfigs.findIndex(c => c.id === id);
        if (i !== -1) customMapConfigs.splice(i, 1);
      }
    } catch (_) {}
    const input = document.querySelector('#basemap-list input[name="basemap"][value="' + id + '"]');
    const label = input && input.closest('label');
    if (label) label.remove();
    if (typeof _autoSaveConfig === 'function') _autoSaveConfig();
    _notifySW();
  }
  // Exposed so the cache-full prompt (in geoapp.html) can drop legacy offline
  // entries during the storage re-alignment branch.
  window._nvPurgeOffline = _purgeOfflineEntry;

  /* ===== FORM INIT ===== */
  (function initForm() {
    const kmlInput  = document.getElementById('offline-kml-input');
    const kmlName   = document.getElementById('offline-kml-name');
    const zoomInput = document.getElementById('offline-zoom');
    const mapSelect = document.getElementById('offline-map-select');
    const startBtn  = document.getElementById('btn-offline-start');
    const cancelBtn = document.getElementById('btn-offline-cancel');
    const tosWarn   = document.getElementById('offline-tos-warn');

    if (!startBtn) return;

    let _kmlText = null;

    if (kmlInput) {
      kmlInput.addEventListener('change', function () {
        const f = this.files[0]; if (!f) return;
        const ext = f.name.split('.').pop().toLowerCase();
        if (ext !== 'kml' && ext !== 'kmz') {
          toastMsg('Scegli un file .kml o .kmz per l’area', 'error', undefined, 'sidebar');
          this.value = ''; return;
        }
        if (kmlName) kmlName.textContent = f.name;
        const reader = new FileReader();
        reader.onload = e => { _kmlText = e.target.result; };
        reader.readAsText(f);
      });
    }

    function _populateSelect() {
      if (!mapSelect) return;
      mapSelect.innerHTML = '';
      const offlineIds = new Set(
        (typeof customMapConfigs !== 'undefined' ? customMapConfigs : [])
          .filter(c => c.offline).map(c => c.id)
      );
      /* A map that cannot be downloaded is listed anyway, disabled, with the reason next to
         it. Dropping it silently was worse than useless: someone who had just added their
         regional WMS found it missing from here and no explanation anywhere — and, when the
         list came out empty, an invitation to add a basemap, which is exactly what they had
         done. The reason is the answer to the question being asked at that moment. */
      let usable = 0;
      document.querySelectorAll('#basemap-list input[name="basemap"]').forEach(radio => {
        const id = radio.value;
        if (offlineIds.has(id)) return;
        const entry = BASEMAPS[id];
        if (!entry) return;
        const span = radio.closest('label') && radio.closest('label').querySelector('span');
        const name = span ? span.textContent.trim() : id;
        let why = '';
        if (entry._needsCreds) why = 'richiede l’accesso';
        else if (typeof entry.getTileUrl !== 'function') why = 'immagine unica, non a tile';
        else if (_offlineBlocked(entry)) why = 'il fornitore vieta il download massivo';
        const o = document.createElement('option');
        o.value = id;
        o.textContent = why ? name + ' — non scaricabile (' + why + ')' : name;
        if (why) o.disabled = true; else usable++;
        mapSelect.appendChild(o);
      });
      if (!usable) {
        const o = document.createElement('option');
        o.value = ''; o.disabled = true; o.selected = true;
        o.textContent = mapSelect.options.length
          ? 'Nessuna delle mappe attive è scaricabile'
          : 'Nessuna mappa scaricabile — aggiungine una in Livelli';
        mapSelect.insertBefore(o, mapSelect.firstChild);
      }
      _syncTos();   // the list was rebuilt: match the notice to whatever is now selected
    }

    /* The acknowledgement is per selected map: unticking it on every change is what stops a
       tick given for one source from carrying over to the next. */
    function _syncTos() {
      if (!tosWarn || !mapSelect) return;
      const ack = document.getElementById('offline-tos-ack');
      if (ack) ack.checked = false;
      tosWarn.style.display = _needsAck(mapSelect.value) ? '' : 'none';
    }
    if (mapSelect) mapSelect.addEventListener('change', _syncTos);

    const tabBtn = document.querySelector('[data-panel="offline"]');
    if (tabBtn) tabBtn.addEventListener('click', _populateSelect);
    _populateSelect();

    startBtn.addEventListener('click', async () => {
      if (!_kmlText) { toastMsg('Scegli un file KML per l’area', 'error', undefined, 'sidebar'); return; }
      const zoom = parseInt(zoomInput ? zoomInput.value : '14');
      if (isNaN(zoom) || zoom < 1 || zoom > 18) { toastMsg('Lo zoom deve stare fra 1 e 18', 'error', undefined, 'sidebar'); return; }
      if (!mapSelect || !mapSelect.value) { toastMsg('Scegli una mappa', 'error', undefined, 'sidebar'); return; }
      const rawName = mapSelect.options[mapSelect.selectedIndex].text;
      const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
      await _startDownload(_kmlText, zoom, mapSelect.value, safeName);
    });

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        if (_downloading) { _cancelled = true; if (_batchAbort) _batchAbort.abort(); }
      });
    }

    /* Clear ALL cached tiles: the volatile browsing cache AND every saved
       offline basemap. Does not touch localStorage (saved view), IndexedDB
       (drawings, imported layers) or any other app state. Offline basemap
       entries are removed from the list too, since their tiles are gone. */
    const clearBtn = document.getElementById('btn-offline-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        if (_downloading) { toastMsg('Non si può svuotare mentre un download è in corso', 'error', undefined, 'sidebar'); return; }
        if (!window.caches) { toastMsg('Cache API non disponibile', 'error', undefined, 'sidebar'); return; }
        if (!confirm('Cancellare TUTTI i tile salvati?\n\nVengono svuotate sia la cache automatica di navigazione sia ogni mappa offline che hai scaricato: andranno riscaricate. I tuoi disegni e le impostazioni non vengono toccati.')) return;
        try {
          // Use storage.estimate() to report freed size without enumerating
          // cache entries (cache.keys() can take minutes on a full cache).
          // The estimate is for the whole origin so it includes other storage
          // subsystems, but tile bytes dominate by orders of magnitude.
          const est = navigator.storage && navigator.storage.estimate;
          const before = est ? ((await navigator.storage.estimate()).usage || 0) : 0;

          // Delete the volatile cache and every offline-basemap cache (including
          // any orphans not present in customMapConfigs).
          const names = await caches.keys();
          let deletedAny = false;
          for (const name of names) {
            if (name === TILE_CACHE_NAME || name.startsWith(OFFLINE_PREFIX)) {
              const ok = await caches.delete(name);
              deletedAny = deletedAny || ok;
            }
          }

          // Remove the now-empty offline basemap entries from the list/config.
          const offlineIds = (typeof customMapConfigs !== 'undefined')
            ? customMapConfigs.filter(c => c.offline).map(c => c.id) : [];
          offlineIds.forEach(_purgeOfflineEntry);
          _notifySW();

          if (!deletedAny) { toastMsg('Non c’è niente da svuotare', '', undefined, 'sidebar'); return; }
          let msg = 'Cache cleared';
          if (est) {
            const after = (await navigator.storage.estimate()).usage || 0;
            const freed = Math.max(0, before - after);
            if (freed > 0) {
              const mb = freed / (1024 * 1024);
              msg += ': ' + (mb >= 1024 ? (mb / 1024).toFixed(2) + ' GB' : mb.toFixed(0) + ' MB') + ' freed';
            }
          }
          toastMsg(msg, 'success', undefined, 'sidebar');
        } catch (e) {
          toastMsg('Errore nello svuotamento della cache: ' + e.message, 'error', undefined, 'sidebar');
        }
      });
    }
  })();

})();
