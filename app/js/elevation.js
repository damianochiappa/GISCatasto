/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
/* =====================================================
   ELEVATION — Open-Meteo Elevation API wrapper
   fetchElevation(lat, lon) → Promise<number|null>
   updateGpsElevation(lat, lon) — throttled, for GPS
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

  /* ---- throttled GPS elevation updater ---- */
  let _lastLat = null, _lastLon = null, _debounceTimer = null;
  const _MOVE_THRESHOLD = 0.001; // ~100 m

  window.updateGpsElevation = function updateGpsElevation(lat, lon) {
    // Only re-query if moved significantly
    if (_lastLat !== null) {
      const dlat = Math.abs(lat - _lastLat);
      const dlon = Math.abs(lon - _lastLon);
      if (dlat < _MOVE_THRESHOLD && dlon < _MOVE_THRESHOLD) return;
    }

    /* The reference moves now, not when the query eventually runs. While it only moved on a
       completed query, every fix past the threshold re-armed the debounce — and at roughly one
       fix per second the two-second timer never got to fire, so the elevation in the status bar
       froze for as long as the user kept walking and only caught up once they stopped. */
    _lastLat = lat; _lastLon = lon;
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(async () => {
      const elevItem = document.getElementById('sb-elev-item');
      const elevEl   = document.getElementById('sb-elev');
      if (elevItem && elevEl) {
        elevEl.textContent = '…';
        elevItem.style.display = '';
      }
      const val = await fetchElevation(lat, lon);
      if (elevItem && elevEl) {
        elevEl.textContent = val != null ? val + ' m' : '--';
        elevItem.style.display = '';
      }
    }, 2000);
  };

})();
