/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
/* =====================================================
   ELEVATION — Open-Meteo Elevation API wrapper
   fetchElevation(lat, lon) → Promise<number|null>

   Asked for one point at a time, on a deliberate gesture: the long-press menu. It used to also
   feed a running readout in the status bar, which meant a request to a third party for merely
   panning the map — every other figure in that bar is arithmetic done on this device and true
   with no network, and this one was neither.
===================================================== */

(function() {

  /* ---- in-memory cache (max 200 entries) ---- */
  const _cache = new Map();
  const _CACHE_MAX = 200;
  function _cacheKey(lat, lon) {
    return lat.toFixed(3) + ',' + lon.toFixed(3);
  }

  /* ---- public: fetch elevation ---- */
  window.fetchElevation = async function fetchElevation(lat, lon) {
    const key = _cacheKey(lat, lon);
    if (_cache.has(key)) return _cache.get(key);

    const url = `https://api.open-meteo.com/v1/elevation?latitude=${lat.toFixed(5)}&longitude=${lon.toFixed(5)}`;

    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      const j = await r.json();
      const elev = j?.elevation?.[0];
      if (elev == null || isNaN(elev)) return null;
      const val = Math.round(elev);
      if (_cache.size >= _CACHE_MAX) {
        _cache.delete(_cache.keys().next().value);
      }
      _cache.set(key, val);
      return val;
    } catch(_) { return null; }
  };

})();
