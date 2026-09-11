/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
/* =====================================================
   MAP — init, basemaps, GPS, coord display, contextmenu
===================================================== */

/* ===== BASEMAP DEFINITIONS ===== */
const BASEMAPS = {
  osm: L.tileLayer('https://tile.opentopomap.org/{z}/{x}/{y}.png', {
    attribution: 'Map data: &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Map style: &copy; <a href="https://opentopomap.org">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/">CC-BY-SA</a>)', maxZoom: 17
  }),
  osm_std: L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors', maxZoom: 19
  }),
  /* Stadia (alidade_satellite) removed: production use requires an API key.
     Satellite coverage is served by esri_sat below, online-only. */
  /* CARTO removed 2026-09-08: its tiles require an API key. Street map: osm_std above. */
  esri_sat: L.tileLayer('https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, Maxar, Earthstar Geographics, and the GIS User Community', maxZoom: 20
  }),
  esri_topo: L.tileLayer('https://services.arcgisonline.com/arcgis/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Esri, HERE, Garmin, FAO, NOAA, USGS, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, and the GIS User Community', maxZoom: 20
  }),
  natgeo: L.tileLayer('https://services.arcgisonline.com/ArcGIS/rest/services/NatGeo_World_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'National Geographic, Esri, Garmin, HERE, UNEP-WCMC, USGS, NASA, ESA, METI, NRCAN, GEBCO, NOAA, iPC', maxZoom: 16
  }),
  /* The only national aerial imagery that may be cached: GetCapabilities declares
     AccessConstraints "Nessuno" and Fees "Nessuna condizione applicata", where every other
     bundled basemap forbids bulk download. 50 cm from a 2012 flight, so it is worse than the
     online imagery — but the comparison that matters is against having nothing available
     offline at all.
     Served as WMS rather than tiles, which is fine: L.TileLayer.WMS still has getTileUrl,
     so the offline downloader treats it like any other tile source.
     Cleartext on purpose: the host 301-redirects HTTPS to HTTP and is already the documented
     exception in res/xml/network_security_config.xml (same host as the wizard's ADMIN_WFS).
     Zoom window measured against the live server, not read off the scale hint: z10 and below
     return an all-black 334-byte PNG with HTTP 200, so minZoom stops the request instead of
     painting the map black. z18 matches the 50 cm source; 19 is upscaled client-side. */
  pcn_ortho: L.tileLayer.wms('http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/WMS_v1.3/raster/ortofoto_colore_12.map', {
    layers: 'OI.ORTOIMMAGINI.2012.32,OI.ORTOIMMAGINI.2012.33',
    format: 'image/png', version: '1.3.0', transparent: false,
    minZoom: 11, maxZoom: 19, maxNativeZoom: 18,
    attribution: 'Ortofoto AGEA 2012 &mdash; Geoportale Nazionale, Ministero dell\'Ambiente (PCN)'
  })
};

/* ===== MAP INIT ===== */
const _savedView = (() => { try { return JSON.parse(localStorage.getItem('giscatasto_view')); } catch(_) { return null; } })();
const map = L.map('map', {
  center:  (_savedView && _savedView.lat  != null) ? [_savedView.lat, _savedView.lng] : [43.70, 12.36],
  zoom:    (_savedView && _savedView.zoom != null) ? _savedView.zoom : 6,
  bearing: (_savedView && _savedView.bearing != null) ? _savedView.bearing : 0,
  zoomControl: true,
  rotate: true,
  touchRotate: true,
  rotateControl: false
});

/* Track tile-loading state for the safe-mode flag in geoapp.html. */
map.on('layeradd', e => {
  if (e.layer && e.layer instanceof L.TileLayer) {
    e.layer.on('tileloadstart', window._nvTileStart || (()=>{}));
    e.layer.on('tileload tileerror', window._nvTileEnd || (()=>{}));
    _watchTileErrors(e.layer);
  }
});

/* A tile source that is down stays silent: Leaflet fetches tiles through <img>, so a dead
   host, an HTTP 500 and an OGC ServiceException body all arrive as the same bare onerror,
   with nothing to read. What the user sees is an empty map, which reads as the app's fault.
   Count failures per layer and name the source once per outage; the counter is reset by the
   first tile that loads again, so a server that comes back goes quiet on its own.
   The threshold and the cooldown are what keep this from becoming noise: single tiles fail
   at the edge of a scale window routinely, and panning in and out of a downloaded area would
   otherwise re-arm the notice on every drag.
   The single-image WMS layer has its own notice (_notifyErr): there the response body is
   readable, so it can quote the server's own message. Here there is none. */
const _TILE_ERR_MIN = 4;        // consecutive failures before speaking
const _TILE_ERR_GAP = 30000;    // ms between two notices about the same layer

function _tileLayerLabel(layer) {
  // Prefer the name shown in the basemap list — the string the user picked the map by.
  try {
    const id = Object.keys(BASEMAPS).find(k => BASEMAPS[k] === layer);
    if (id) {
      const inp = document.querySelector('input[name="basemap"][value="' + id + '"]');
      const sp  = inp && inp.parentElement && inp.parentElement.querySelector('span');
      if (sp && sp.textContent.trim()) return sp.textContent.trim();
    }
  } catch(_) {}
  // Otherwise the attribution, stripped of the markup the bundled basemaps carry in it.
  const a = ((layer.options && layer.options.attribution) || '').replace(/<[^>]*>/g, '').trim();
  if (!a) return 'la mappa';
  return a.length > 40 ? a.slice(0, 40) + '…' : a;
}

function _watchTileErrors(layer) {
  if (layer._tileErrWired) return;
  layer._tileErrWired = true;
  layer._tileErrN = 0;
  layer.on('tileerror', () => {
    if (++layer._tileErrN < _TILE_ERR_MIN) return;
    const now = Date.now();
    if (layer._tileErrAt && now - layer._tileErrAt < _TILE_ERR_GAP) return;
    layer._tileErrAt = now;
    const who = _tileLayerLabel(layer);
    _loadToast(navigator.onLine === false
      ? 'Nessuna connessione: "' + who + '" non può caricare'
      : '"' + who + '" non risponde — server non disponibile', 'error');
    // The toast is gone in seconds; the diagnostic report is what survives to be read later.
    console.warn('[giscatasto] tile source failing:', who, '|', layer._url || '(no url)');
  });
  layer.on('tileload', () => { layer._tileErrN = 0; });
}

let currentBasemap = BASEMAPS.osm_std;
currentBasemap.addTo(map);

window._panelZTop = 800;
window._navFollowing = true;
window._navSetFollowing = function (v) {
  window._navFollowing = v;
  const b = document.getElementById('nav-follow-badge');
  if (b) b.classList.toggle('hidden', v);
};
map.on('dragstart', () => {
  if (typeof navIsActive === 'function' && navIsActive() && window._navFollowing) {
    window._navFollowing = false;
    const b = document.getElementById('nav-follow-badge');
    if (b) b.classList.remove('hidden');
  }
});
document.getElementById('nav-follow-btn').addEventListener('click', () => {
  window._navFollowing = true;
  document.getElementById('nav-follow-badge').classList.add('hidden');
  if (typeof gpsMarker !== 'undefined' && gpsMarker) {
    const _ll = gpsMarker.getLatLng();
    if (typeof navIsActive === 'function' && navIsActive()) {
      map.setView(_ll, Math.max(map.getZoom(), 17), { animate: true });
    } else {
      map.panTo(_ll, { animate: true, duration: 0.3 });
    }
  }
});

L.control.scale({ maxWidth: 200, metric: true, imperial: false, position: 'bottomleft' }).addTo(map);

/* Startup grace window: the bundled catasto layers all fire at once at a wide zoom, so
   their "zoom in to load" hints and any slow-server errors arrive as an invasive burst
   before the server has had time to answer. Swallow layer-load toasts for the first few
   seconds; anything still wrong resurfaces normally on the next pan/zoom. */
const _BOOT_QUIET_MS = 7000;
const _bootAt = Date.now();
/* Nothing from the layers speaks while the map is turning, or in the moment right after.
   Rotation does not raise these messages by itself — a gesture ends with a small pan, every
   layer refreshes, and the ones with no data here answer empty together. But that burst lands
   on a main thread that is still busy, so the timers that dismiss the toasts bunch up and
   discharge at once, and the result is the flicker reported from the field. Without rotation the
   very same machinery behaves, which is what says the toasts are a SYMPTOM here and not a cause.
   So they are dropped, not queued: they describe a transient state that has already moved on by
   the time the gesture ends, and replaying them late would be worse than silence.
   The window has to outlast the refresh the gesture triggers, not just the gesture: moveend, the
   400 ms fetch debounce, then the network. 2 s covers the common case; a slow reply still gets
   through, which is a safe way to degrade. It is a latency choice, not a measured quantity.
   ⚠ Failures are not lost: every caller writes its own console.warn, so the diagnostic report
   still records them even when nothing is shown. */
const _ROT_TOAST_QUIET_MS = 2000;
let _rotLastRotateAt = 0;

function _loadToast(msg, type, dur, target) {
  if (Date.now() - _rotLastRotateAt < _ROT_TOAST_QUIET_MS) return;
  if (Date.now() - _bootAt < _BOOT_QUIET_MS) return;
  toastMsg(msg, type, dur, target);
}

/* ONE collector, four callers — the empty view, the failed request, the below-scale notice and
   the WMS failure. They are the same situation wearing four coats: a message that NAMES a layer,
   raised by several layers at once because one viewport change reaches all of them. And they
   share one failure: a different name means a different text, which defeats toastMsg's
   identical-text dedupe AND its (target, type, first 40 chars) cooldown key, so every layer gets
   through — and the FIFO cap of two then tears the older ones out the instant the next arrives,
   with no fade. Measured with the five layers from the field report: 5 inserted, 3 torn out,
   2 left standing. Collected, the same burst is one toast.
   ⚠ Deliberately ONE mechanism with four renderings, not four copies of the same window: the
   first two were written separately and the other two were then left behind for days, which is
   exactly how four copies drift apart.
   The per-layer throttles (8 s on the empty view, 5 s on the below-scale notice) stay upstream
   where they already were: they are what stops the COUNT changing on every pan, which would mint
   a new cooldown key each time and walk straight past the rate limit this leans on.
   The window is a UI-latency choice, not a measured quantity — the layers are scheduled by one
   moveend so their requests leave together, but their replies arrive a network round trip apart
   and that spread cannot be measured from here. It degrades safely: a reply that misses the
   window opens the next one, so the worst case is two toasts rather than five. */
const _BURST_MS = 1200;

/* These messages describe a STATE, not an event: "no features here" stays true until the user
   moves, and "below this scale" until they zoom. A state is worth saying when it CHANGES —
   saying it again every cooldown, for as long as it holds, is what the field reported as
   "troppi e ripetuti". toastMsg's dedupe only merges toasts visible at the same moment, and its
   cooldown just delays the repeat by 8 s; neither stops a message recurring for ever while
   nothing about the situation has changed. So the collector remembers what it last said and
   stays quiet until the answer is different.
   Two escapes keep the silence from becoming a hole: `reset()`, called when the condition
   actually clears (features come back, the zoom rises above the layer's minimum), so the same
   message can be said again for a NEW occurrence; and _SAY_AGAIN_MS, after which it may repeat
   anyway — a user coming back to the same spot ten minutes later has forgotten being told. */
/* ⚠ NO reset() calls anywhere. An earlier version cleared the memo whenever the condition
   "ended" — features came back, the zoom rose above a layer's minimum — so that a new occurrence
   would be heard rather than swallowed as a repeat. It backfired badly and was reported from the
   device as the same toast firing many times in a fraction of a second: the resets were GLOBAL
   and fired constantly. With eleven layers at different minZooms there is always one above its
   threshold, so `_reportBelowScale.reset()` in _update wiped the memo on essentially every
   update; and one layer answering with features re-armed the empty message for all the others.
   The message then became formally "new" many times a second, and no downstream rate limit could
   catch it, because none of them was wrong.
   What remains is enough and is predictable: the text itself is the memo, so the message speaks
   again as soon as the ANSWER changes (a different count, a different layer), and _SAY_AGAIN_MS
   lets it be heard again after a minute for a genuinely new visit. */
const _SAY_AGAIN_MS = 60000;

function _makeBurstToast(render, type, target, kind) {
  let names = [], first = '', tid = null, lastKind = '', lastAt = 0;
  const fn = (name, msg) => {
    if (names.indexOf(name) === -1) {
      names.push(name);
      if (!first) first = msg || '';   // the lone case keeps the first layer's own words
    }
    if (tid) return;
    tid = setTimeout(() => {
      tid = null;
      const list = names, f = first;
      names = []; first = '';
      if (!list.length) return;
      const text = render(list, f);
      const now = Date.now();
      /* Keyed on the KIND of message, not on its text, and that distinction is the whole point.
         When a burst holds a single layer the rendered string carries that layer's NAME, so three
         layers answering in three separate windows produce three DIFFERENT strings — which opens
         every text-keyed gate at once: this memo, toastMsg's cooldown and its re-appearance
         buffer. And it gets worse exactly when it matters: under load the replies arrive further
         apart, fall into different windows, and are therefore reported one by one rather than
         collected. The harder the app is working, the blinder the text-based gates become.
         Reported from the device as redundant toasts surviving "a thousand gates". */
      /* Only where repetition is the defect. A status message describes a STATE — "there is
         nothing here", "you are too far out" — and saying it again while it still holds is noise.
         A failure is an EVENT: every new episode has to speak, or the latch upstream turns into a
         mute button. So the error collector passes no kind and is never held back here; it is
         rationed by _errShown, one report per layer per episode, which is the right unit for it. */
      if (kind && kind === lastKind && now - lastAt < _SAY_AGAIN_MS) return;
      if (kind) { lastKind = kind; lastAt = now; }
      _loadToast(text, type, undefined, target);
    }, _BURST_MS);
  };
  return fn;
}

// A single layer keeps its name: that is worth knowing, and on its own it cannot flash.
const _reportWfsEmpty = _makeBurstToast(
  n => n.length === 1 ? n[0] + ': nessuna geometria nella vista corrente' : n.length + ' layer: nessuna geometria nella vista corrente',
  'warn', 'map-quiet', 'wfs-empty');

/* A lone failure keeps its WHOLE message, the server's own words included: that is the case the
   user can act on. Collected, the detail is not lost but moves to the log — every caller writes
   its own console.warn, per layer and unabridged, so the diagnostic report reads as before. */
const _reportLayerError = _makeBurstToast(
  (n, f) => n.length === 1 ? f : n.length + ' layer: richiesta non riuscita',
  'error', undefined, null);   // no kind: every failure EPISODE speaks, see above

/* Below the scale a layer declares, nothing is drawn and nothing is wrong — but with eleven
   layers configured at different minZooms a single zoom level can put several of them out of
   range at once, and each used to say so in its own words. */
const _reportBelowScale = _makeBurstToast(
  n => n.length === 1 ? 'Zooma per caricare ' + n[0] : 'Zooma per caricare ' + n.length + ' layer',
  'warn', 'map-quiet', 'below-scale');

/* Landscape-only collapsible headers for Draw (topleft) and Measure (topright).
   Hidden in portrait via CSS; in landscape they toggle the corresponding stack. */
const _makeToggle = (position, extraCls, title, svg, targetClass) => L.Control.extend({
  options: { position },
  onAdd(mp) {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-toggle ' + extraCls);
    const a = L.DomUtil.create('a', '', div);
    a.href = '#'; a.title = title;
    a.innerHTML = svg;
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.preventDefault(e);
      const on = mp.getContainer().classList.toggle(targetClass);
      a.classList.toggle('toggle-on', on);
    });
    return div;
  }
});
const _svgPencil = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
const _svgRuler  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 15l6-6 12 12-6 6z"/><path d="M9 9l3 3M12 6l3 3M15 3l3 3"/></svg>';
map.addControl(new (_makeToggle('topleft',  'leaflet-toggle-draw',    'Show/hide draw tools',    _svgPencil, 'draw-expanded'))());
map.addControl(new (_makeToggle('topright', 'leaflet-toggle-measure', 'Show/hide measure tools', _svgRuler,  'measure-expanded'))());

const _plMeasure = L.control.polylineMeasure({
  position: 'topright', unit: 'kilometres', showBearings: true,
  clearMeasurementsOnStop: false, showClearControl: true, showUnitControl: true
}).addTo(map);
/* Plugin container is only marked `leaflet-bar` — add a unique class so CSS can target it. */
if (_plMeasure && _plMeasure.getContainer) _plMeasure.getContainer().classList.add('leaflet-polyline-measure');

const drawnItems = L.featureGroup().addTo(map);

/* Dedicated panes so user drawings sit ABOVE the cadastral WFS (panes 402/404) and the
   WMS overlays: polygons (draw-poly 450) below lines (draw-line 460). Markers (points)
   keep the native markerPane (z-index 600), already above everything here — so the final
   drawing order is polygons < lines < points. Created lazily (rotatePane exists by the
   time the first shape is drawn or restored). */
function _ensureDrawPanes() {
  [['draw-poly', 450], ['draw-line', 460]].forEach(([name, z]) => {
    if (!map.getPane(name)) {
      const p = map.createPane(name);
      p.style.zIndex = z;
      const rotatePane = map.getPane('rotatePane');
      if (rotatePane) rotatePane.appendChild(p);
    }
  });
  if (typeof _reorderMapPanes === 'function') _reorderMapPanes(map);
}

/* Route a shape to its drawing pane by geometry. Must run BEFORE drawnItems.addLayer:
   Leaflet reads options.pane in onAdd to choose the renderer/pane. Markers are left as
   they are so they render in the native markerPane (on top of everything). */
function _assignDrawPane(layer) {
  if (!layer || layer instanceof L.Marker) return;   // points stay in markerPane (600)
  _ensureDrawPanes();
  // L.Polygon extends L.Polyline and L.Rectangle extends L.Polygon → test Polygon first.
  if (layer instanceof L.Polyline && !(layer instanceof L.Polygon)) {
    layer.options.pane = 'draw-line';
  } else {
    layer.options.pane = 'draw-poly';   // Polygon / Rectangle / Circle / CircleMarker
  }
}

/* Leaflet.Draw derives a rectangle from a LatLngBounds, which is north-aligned by
   construction: the two drag corners only set min/max lat and lon, so the map bearing
   never enters the result and the shape drifts from the drag box whenever the map is
   rotated. Rebuild the four corners in container (screen) space, which leaflet-rotate
   makes bearing-aware, so the figure follows the pointer at any bearing. The result is
   an L.Polygon, not an L.Rectangle: a rotated quad cannot survive in a LatLngBounds.
   This matches what already happens across a save/reload cycle, where L.Rectangle is
   serialized to a Polygon geometry and restored as an L.polygon. */
function _screenAlignedRect(map, startLatLng, latlng) {
  const a = map.latLngToContainerPoint(startLatLng);
  const b = map.latLngToContainerPoint(latlng);
  return [a, L.point(b.x, a.y), b, L.point(a.x, b.y)]
    .map(pt => map.containerPointToLatLng(pt));
}

L.Draw.Rectangle.include({
  _drawShape(latlng) {
    const corners = _screenAlignedRect(this._map, this._startLatLng, latlng);
    if (!this._shape) {
      this._shape = new L.Polygon(corners, this.options.shapeOptions);
      this._map.addLayer(this._shape);
    } else {
      this._shape.setLatLngs(corners);
    }
  },
  _fireCreatedEvent() {
    const poly = new L.Polygon(this._shape.getLatLngs(), this.options.shapeOptions);
    L.Draw.SimpleShape.prototype._fireCreatedEvent.call(this, poly);
  }
});

map.addControl(new L.Control.Draw({
  position: 'topleft',
  edit: { featureGroup: drawnItems, remove: false, poly: { allowIntersection: true } },
  draw: {
    /* The polygon had no shapeOptions, so it drew in Leaflet.Draw's own #3388ff — a fourth
       blue, close enough to the app's to look like a rendering artefact rather than a choice,
       and not in the swatch list every colour picker here offers. */
    /* fillOpacity 0.3, not Leaflet.Draw's 0.2. Everywhere else the app states the fill as
       three tenths of the shape's opacity — the slider in the popup, the restore at launch,
       the fill-opacity written into an exported KML — and only the moment of drawing used the
       library's own default. The shape therefore came back very slightly more solid than it
       was drawn, in the same silent way the colour used to change. One rule, stated once here
       too. Polylines have no fill and take none. */
    polygon:  { allowIntersection: true, showArea: true, shapeOptions: { color: '#4f8ef7', weight: 2, fillOpacity: 0.3 } },
    polyline: { shapeOptions: { color: '#4f8ef7', weight: 3 } },
    rectangle:{ shapeOptions: { color: '#f0a830', weight: 2, fillOpacity: 0.3 } },
    circle:   { shapeOptions: { color: '#52c97e', weight: 2, fillOpacity: 0.3 } },
    marker: true, circlemarker: false
  }
}));

/* ===== OPENLAYERS PROJECTIONS (WFS GML reader) ===== */
/* OpenLayers is used only as the GML reader for WFS responses (ol.format.WFS /
   ol.format.GML32 in _WFSLayer). WMS overlays and basemaps render through Leaflet's
   _WMSImageLayer, so no ol.Map is created — the ol.format readers work standalone and
   need only the projections registered below. */
(function _initOlProjections() {
  if (!window.ol || !window.proj4) return;

  // Register EPSG:4258 (ETRS89) and EPSG:6706 for Italian/EU WFS servers
  proj4.defs('EPSG:4258', '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs');
  proj4.defs('EPSG:6706', '+proj=longlat +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +no_defs');
  ol.proj.proj4.register(proj4);
  /* EPSG:4258 and EPSG:6706 are geographic CRS whose EPSG axis order is lat,lon. The
     proj4 defs above carry no +axis, so register() leaves the OL projection on the 'enu'
     default, and readFeatures would take a short-form "EPSG:4258" posList as lon,lat.
     Setting the orientation directly makes the reader interpret those pairs as lat,lon;
     putting +axis=neu on the proj4 def would instead corrupt the proj4 transform. (urn
     srsName forms already imply lat,lon, and MapServer cadastral GML falls through to the
     manual parser, so this only affects short-form geographic responses from standard
     WFS servers.) */
  ['EPSG:4258', 'EPSG:6706'].forEach(c => {
    try {
      const p = ol.proj.get && ol.proj.get(c);
      if (p && 'axisOrientation_' in p) p.axisOrientation_ = 'neu';
    } catch(_) {}
  });
})();

/* ===== DRAW TOOL ACTIVE FLAG ===== */
let mapToolActive = false;
map.on(L.Draw.Event.DRAWSTART,   () => { mapToolActive = true; });
map.on(L.Draw.Event.DRAWSTOP,    () => { mapToolActive = false; });
map.on(L.Draw.Event.EDITSTART,   () => { mapToolActive = true; });
map.on(L.Draw.Event.EDITSTOP,    () => { mapToolActive = false; });

/* ===== SCREEN WAKE LOCK ===== */
let _wakeLock = null;
async function _acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    _wakeLock = await navigator.wakeLock.request('screen');
    _wakeLock.addEventListener('release', () => { _wakeLock = null; });
  } catch(_) {}
}
function _releaseWakeLock() {
  if (_wakeLock) { _wakeLock.release().catch(() => {}); _wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && gpsActive) _acquireWakeLock();
});

/* ===== GPS CONTROL ===== */
let gpsMarker = null, gpsCircle = null, gpsActive = false, gpsFirstFix = false, gpsWatchId = null;
/* Which of the three marker shapes is currently on the map ('plane' | 'arrow' | 'dot'). They
   are different Leaflet classes, so only a change of KIND may rebuild the marker — see
   gpsUpdate, where rebuilding it on every fix used to kill the popup a second after it opened. */
let _gpsMarkerKind = null;
// Forgiving geolocation options: accept a fix up to 10s old for an instant first reading, and
// allow a long window before a (non-fatal) timeout — a cold high-accuracy fix on some phones
// (indoors, aggressive battery managers like Motorola) can take well over 20s.
const _GPS_OPTS = { enableHighAccuracy: true, timeout: 60000, maximumAge: 10000 };
let _gpsRetryTid = null;

/* ── Flight detection ──
   On altitude above sea level, not on height above ground. Height above ground needs a terrain
   model, the terrain model needs the network, and so the old rule was unavailable at ten
   kilometres over the sea and perfectly available in the garden — exactly backwards. Altitude
   above sea level is the GNSS fix plus the geoid table, both on board, so this works with no
   connection at all.
   6000 m cannot be reached from the ground: the highest road on Earth stops below 5900 m and no
   cable car passes 3900. Anything else at that height — a glider, a balloon, a parachute — is
   flying, which is the state this is trying to name, so it is not a false positive either.
   (9000 m, above Everest, would make it a proof rather than an argument; 6000 keeps the panel
   up through the climb and the descent, which is the half of a flight worth watching.) */
const _FLIGHT_MSL_M = 6000;
const _FLIGHT_CONFIRM_FIXES = 2;
let _flightStreak = 0;      // consecutive fixes agreeing, signed: above sea level threshold or below
let _flightState  = false;
let _gpsWasFlying   = false;
let _smoothBearing  = null;
let _gpsViewCone    = null;
let _prevGpsLL      = null;
let _lastBearingLL  = null;
let _lastMoveLL     = null;   // last position confirmed as real movement (moving gate)
let _lastMoveT      = 0;      // timestamp of that confirmation
let _isMoving       = false;  // movement gate: drives track-up rotation + view cone

/* A stationary GPS still jitters by a few metres and reports a non-zero speed, so a
   heading derived at standstill is noise — it spun the map and pointed the walking
   cone in random directions. These thresholds gate BOTH the track-up rotation and the
   cone: below them the heading is frozen (map keeps its last bearing) and the cone is
   hidden. Hysteresis (ON > OFF) stops flicker at the boundary; MOVE_DIST is the
   fallback when the device reports a null speed, which happens intermittently. */
const _MOVE_ON_MS  = 1.0;   // m/s — above this: moving
const _MOVE_OFF_MS = 0.5;   // m/s — below this: stopped (state held in between)
const _MOVE_DIST_M = 6;     // m  — displacement counting as real movement when speed is null
const _STOP_MS     = 4000;  // ms — no real progress this long (null speed) → stopped

/* The same jitter, asked about in the other unit. The thresholds above answer "is the rider
   moving", in metres per second, and they gate the rotation. This one answers "would the
   screen visibly change", which is a question about pixels: below it a re-centre moves the
   map by less than the width of a fingernail, and pays for it with a moveend — the event
   every raster and vector overlay refreshes on. Measured on the bench: at a standstill,
   12 fixes of ±4 m jitter issued 12 pans, 11 moveends and 11 refresh requests per overlay.
   24 px is about 21 m at zoom 17 at Italian latitudes, comfortably above a standstill
   jitter, and out of the ~450 px between the centre and the edge of a phone screen it
   leaves the marker within 5% of centre. Pixels, not metres, so it holds at every zoom. */
const _FOLLOW_MIN_PX = 24;

/* The two heading icons carry NO angle of their own: the direction is a marker option
   (`rotation`, radians) that leaflet-rotate applies inside the same _setPos it already runs to
   reposition every marker on a bearing change. Two things came out of that, measured on the
   bench and not assumed:
   - the icon HTML used to be rebuilt on every GPS fix, purely to change one angle: `setIcon`
     goes through DivIcon.createIcon, which rewrites innerHTML, so the inner div — the one
     carrying filter:drop-shadow, i.e. the one that gets its own compositing layer — was
     destroyed and recreated about once a second. Counted: 10 subtree rebuilds over 10 updates
     before, 0 after, with the arrow still turning. The screen result is identical to the
     pixel: 20 combinations of map bearing x travel direction, worst angle difference 0.000
     deg and worst centre shift 0.000 px, read through getScreenCTM (which composes every
     transform above the icon, so it answers about the screen and not about our markup).
   - `rotateWithView` adds the map's own bearing, which removes the manual `+ map.getBearing()`
     the arrow used to do, and fixes a defect that arithmetic could not: the angle was baked in
     at fix time, so turning the map by hand BETWEEN fixes left the arrow pointing the old way
     until the next one arrived. Measured: map turned to 90 with no new fix read 0 deg before
     and 90 deg after. The aeroplane never did the addition at all, so on a turned map it was
     wrong by the whole bearing — same fix, and it is what "pointing along travel" means: a
     direction over the ground, not over the screen. */
function _makeNavArrowIcon() {
  return L.divIcon({
    html: `<div style="width:32px;height:32px;transform-origin:center;` +
          `filter:drop-shadow(0 1px 4px rgba(0,0,0,.6))">` +
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="32" height="32">` +
          `<polygon points="12,2 20,20 12,15 4,20" fill="#4f8ef7" stroke="white" stroke-width="1.5"/>` +
          `</svg></div>`,
    className: '',
    iconSize:    [32, 32],
    iconAnchor:  [16, 16],
    popupAnchor: [0, -18]
  });
}

function _makeAirplaneIcon() {
  return L.divIcon({
    html: `<div style="width:34px;height:34px;transform-origin:center;` +
          `filter:drop-shadow(0 1px 5px rgba(0,0,0,.7))">` +
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="34" height="34" fill="#4f8ef7">` +
          `<path d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19` +
          `l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/>` +
          `</svg></div>`,
    className: '',
    iconSize:    [34, 34],
    iconAnchor:  [17, 17],
    popupAnchor: [0, -20]
  });
}

/* Degrees in, radians out, and a non-finite heading reads as zero: the two callers below take
   their angle from the GPS, which reports null often enough that this cannot be an assertion. */
function _headingRad(deg) {
  return (deg != null && isFinite(deg)) ? deg * (Math.PI / 180) : 0;
}

const GpsControl = L.Control.extend({
  options: { position: 'bottomright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-gps');
    const a = L.DomUtil.create('a', '', div);
    a.href = '#'; a.title = 'GPS location';
    a.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/></svg>';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(a, 'click', e => { L.DomEvent.preventDefault(e); toggleGPS(a); });
    return div;
  }
});
new GpsControl().addTo(map);

function gpsUpdate(pos) {
  const ll  = L.latLng(pos.coords.latitude, pos.coords.longitude);
  const acc = pos.coords.accuracy;
  const spd = pos.coords.speed;
  const alt = pos.coords.altitude;
  const ts  = pos.timestamp || Date.now();

  /* Moved, not rebuilt. Removing and re-adding the accuracy circle on every fix made it
     flicker, and doing the same to the marker destroyed whatever popup the user had just
     opened — the reason the GPS balloon only ever lasted about a second. */
  if (gpsCircle) { gpsCircle.setLatLng(ll); gpsCircle.setRadius(acc); }
  else gpsCircle = L.circle(ll, { radius: acc, color: '#4f8ef7', fillColor: '#4f8ef7', fillOpacity: 0.12, weight: 1 }).addTo(map);

  const dd   = `${ll.lat.toFixed(6)}, ${ll.lng.toFixed(6)}`;
  const mgrs = mgrsForward(ll.lng, ll.lat);
  let utm = '--';
  try { const u = UTM.fromLatLng({lat: ll.lat, lng: ll.lng}); utm = `${u.zone} ${Math.round(u.x)} ${Math.round(u.y)}`; } catch(_) {}

  /* Height above sea level: the fix from the receiver, corrected by the geoid table on board.
     It is the one altitude this app has — the track, the GPX <ele>, the elevation profile and
     the flight panel all record exactly this number, so the figure read here is the figure
     written there. The terrain model used to hold a second row in this balloon and fed nothing
     else; two figures for one place, differing by ten metres, with the one on screen not the
     one being saved. Terrain is now asked for on one gesture only — the long-press menu — and
     answers about the point pressed, not about where the receiver thinks it is. */
  const altMsl = (typeof ellipsoidToMsl === 'function') ? ellipsoidToMsl(alt, ll.lat, ll.lng) : null;
  /* Two consecutive fixes to change state, either way: one wild altitude must not open the
     panel and one dropout must not close it. A fix carrying no altitude says nothing in either
     direction, so it leaves the state untouched. */
  if (altMsl != null) {
    if (altMsl > _FLIGHT_MSL_M) _flightStreak = _flightStreak > 0 ? _flightStreak + 1 : 1;
    else                        _flightStreak = _flightStreak < 0 ? _flightStreak - 1 : -1;
    if (_flightStreak >= _FLIGHT_CONFIRM_FIXES)       _flightState = true;
    else if (_flightStreak <= -_FLIGHT_CONFIRM_FIXES) _flightState = false;
  }
  const _isFlying = _flightState;

  const gpsDiv = document.createElement('div');
  gpsDiv.style.cssText = 'font-size:12px;font-family:monospace;line-height:1.9;min-width:200px';
  gpsDiv.innerHTML =
    `<div><b>GPS</b> &mdash; Acc: &plusmn;${Math.round(acc)} m` +
    (spd != null ? ` &mdash; ${(spd*3.6).toFixed(1)} km/h` : '') + '</div>' +
    `<div><b style="color:var(--accent)">ALT&nbsp; </b>` +
      (altMsl != null ? `${altMsl.toFixed(0)} m <small style="opacity:0.6">(GPS, sul livello del mare)</small>` : '--') +
    `</div>` +
    `<div><b style="color:var(--accent)">DD&nbsp;&nbsp; </b>${dd}</div>` +
    `<div><b style="color:var(--accent)">UTM&nbsp; </b>${utm}</div>` +
    `<div><b style="color:var(--accent)">MGRS </b>${mgrs}</div>`;
  const cpBtn = document.createElement('button');
  cpBtn.className = 'draw-save-btn'; cpBtn.style.marginTop = '4px';
  cpBtn.textContent = '\uD83D\uDCCB Copia le coordinate';
  cpBtn.addEventListener('click', () => {
    const text = `DD: ${dd}\nUTM: ${utm}\nMGRS: ${mgrs}`;
    if (navigator.clipboard) navigator.clipboard.writeText(text)
      .then(() => toastMsg('Coordinate GPS copiate', 'success')).catch(() => fallbackCopy(text));
    else fallbackCopy(text);
  });
  gpsDiv.appendChild(cpBtn);

  // _isFlying is settled with the popup above, since the marker shape depends on it.
  if (_isFlying !== _gpsWasFlying) {
    _gpsWasFlying = _isFlying;
    toastMsg(_isFlying ? '\u2708 Modalit\u00e0 volo — ' + Math.round(altMsl) + ' m' : 'Modalit\u00e0 terra', _isFlying ? 'success' : '');
    const fp = document.getElementById('flight-panel');
    if (fp) {
      fp.classList.toggle('hidden', !_isFlying);
      if (_isFlying) fp.style.zIndex = ++window._panelZTop;
    }
  }

  // Update flight panel values on every flying fix
  if (_isFlying) {
    const hdg = pos.coords.heading;
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    const dir  = (hdg != null && isFinite(hdg)) ? ' ' + dirs[Math.round(hdg / 45) % 8] : '';
    const _setFp = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    _setFp('fp-spd', spd != null && spd >= 0 ? Math.round(spd * 3.6) : '--');
    /* Above sea level, not above ground: height above ground needs a terrain model, the model
       needs the network, and in the one place this panel exists for there is none. The altitude
       is the receiver's own, corrected by the geoid table on board — no staleness, no lookup. */
    _setFp('fp-alt', altMsl != null ? Math.round(altMsl) : '--');
    _setFp('fp-hdg', hdg != null && isFinite(hdg) ? Math.round(hdg) + dir : '--');
  }

  // Pedestrian nav uses circleMarker + view cone (no arrow) — driving/cycling
  // keep the rotated arrow. On foot the map is already track-up, so the cone marks
  // position and the forward sector instead of duplicating a heading arrow.
  const _navProfMarker = typeof window.navGetProfile === 'function' ? window.navGetProfile() : 'driving';
  const _kind = _isFlying ? 'plane'
              : (typeof navIsActive === 'function' && navIsActive() && _smoothBearing != null && _navProfMarker !== 'walking') ? 'arrow'
              : 'dot';
  /* The heading is the direction of travel over the GROUND, so it is given to the marker as an
     angle and left to leaflet-rotate, which adds the map's own bearing (rotateWithView) inside
     the _setPos every marker already runs on a bearing change. See _makeNavArrowIcon above for
     what this replaced and what was measured. The rotation is written BEFORE setLatLng on
     purpose: setLatLng calls update(), so position and angle land in one write instead of two. */
  const _rot  = () => _kind === 'plane' ? _headingRad(pos.coords.heading) : _headingRad(_smoothBearing);
  const _icon = () => _kind === 'plane' ? _makeAirplaneIcon() : _makeNavArrowIcon();
  const _popupWasOpen = !!(gpsMarker && gpsMarker.isPopupOpen && gpsMarker.isPopupOpen());
  if (gpsMarker && _gpsMarkerKind === _kind) {
    if (_kind !== 'dot') gpsMarker.options.rotation = _rot();
    gpsMarker.setLatLng(ll);
  } else {
    if (gpsMarker) map.removeLayer(gpsMarker);
    gpsMarker = (_kind === 'dot')
      ? L.circleMarker(ll, { radius: 8, color: '#4f8ef7', fillColor: '#fff', fillOpacity: 1, weight: 3 })
      : L.marker(ll, { icon: _icon(), rotation: _rot(), rotateWithView: true, zIndexOffset: 1000 });
    /* autoPan off, for the same reason as the WFS and drawing popups. This balloon is anchored
       to a marker that moves at every fix: Leaflet has an open popup follow its source, and the
       follow calls _adjustPan, which stops the running pan animation and slides the map until
       the balloon fits. Each of those slides is a moveend, and moveend is what every WMS and
       WFS layer refreshes on — so a popup left open over a live position redrew the whole map
       at fix rate. Turning while it was open kept re-triggering it, because rotation keeps
       changing where the balloon sits on screen. The cost is the usual one: a popup opened near
       the edge no longer slides into view. */
    gpsMarker.addTo(map).bindPopup(gpsDiv, { maxWidth: 260, autoPan: false });
    _gpsMarkerKind = _kind;
  }
  /* The readout is refreshed only while the balloon is shut. Swapping the content of an open
     popup would replace the "Copy coordinates" button under the user's finger and re-run the
     auto-pan on every fix, so what stays on screen is the reading that was tapped for. */
  if (!_popupWasOpen && gpsMarker.getPopup()) gpsMarker.setPopupContent(gpsDiv);



  if (!gpsFirstFix) { gpsFirstFix = true; map.setView(ll, Math.max(map.getZoom(), 15)); }
  else if (typeof navIsActive === 'function' && navIsActive() && window._navFollowing) {
    /* Follow the rider, not the receiver's noise. The bearing has been gated on real
       movement since the jitter fix below; the pan never was, so a receiver wandering a
       few metres at a standstill re-centred the map on every fix — and each of those
       re-centres fires moveend, which is what _WMSImageLayer and _WFSLayer refresh on.
       The deviation is taken against the map CENTRE, not against the previous fix, so it
       accumulates: a rider too slow to trip _MOVE_ON_MS still gets re-centred once the
       marker has crept _FOLLOW_MIN_PX off centre, which a gate on _isMoving alone would
       not have done — it would have stopped following them. */
    const _off = map.latLngToContainerPoint(ll)
                    .distanceTo(map.latLngToContainerPoint(map.getCenter()));
    if (_off >= _FOLLOW_MIN_PX) map.panTo(ll, { animate: true, duration: 0.3 });
  }

  // Update GPS accuracy in statusbar
  const accItem = document.getElementById('sb-acc-item');
  const accEl   = document.getElementById('sb-acc');
  if (accItem && accEl) {
    accEl.textContent = '\u00b1' + Math.round(acc) + ' m';
    accItem.style.display = '';
  }

  // Update speed in statusbar
  const spdItem = document.getElementById('sb-spd-item');
  const spdEl   = document.getElementById('sb-spd');
  // Android reports a null speed on and off (stationary, or a network-provider
  // fix), so toggling display here pulled the item in and out of the flex row on
  // every fix and shunted the whole statusbar sideways — a visible flicker at
  // ~1 Hz. Keep the item in flow and blank the value instead; the reserved width
  // lives in the CSS, without it the text length alone still shifts the row.
  if (spdItem && spdEl) {
    spdEl.textContent = (spd != null && spd >= 0) ? (spd * 3.6).toFixed(1) + ' km/h' : '--';
    spdItem.style.display = '';
  }

  // Rotate map to heading during active navigation (ground mode only), but only while
  // genuinely moving. Travel direction comes from GPS course / position delta — NOT the
  // magnetometer, which is unreliable on some devices and was the source of a wrong
  // heading (the driving arrow, GPS-only, already proves the GPS path is sound). At a
  // standstill the movement gate freezes the heading, so the map no longer spins on GPS
  // jitter. Low-pass filter (alpha=0.55) smooths the result.
  if (!_isFlying && typeof navIsActive === 'function' && navIsActive()) {
    // ── Movement gate: speed with hysteresis, displacement fallback for null speed ──
    if (spd != null && spd >= _MOVE_ON_MS) {
      _isMoving = true; _lastMoveLL = ll; _lastMoveT = ts;
    } else if (spd != null && spd < _MOVE_OFF_MS) {
      _isMoving = false;
    } else if (_lastMoveLL) {
      // speed null, or inside the hysteresis band → decide on real displacement
      if (ll.distanceTo(_lastMoveLL) >= _MOVE_DIST_M) { _isMoving = true; _lastMoveLL = ll; _lastMoveT = ts; }
      else if (ts - _lastMoveT > _STOP_MS)            { _isMoving = false; }
      // otherwise keep the previous _isMoving
    } else {
      _lastMoveLL = ll; _lastMoveT = ts;
    }

    if (_isMoving) {
      let rawBrg = null;
      const _hdg = pos.coords.heading;
      if (_hdg != null && isFinite(_hdg)) {
        rawBrg = _hdg;                                   // GPS course — accurate while moving
      } else {
        const _ref = _lastBearingLL || _prevGpsLL;
        if (_ref && ll.distanceTo(_ref) >= _MOVE_DIST_M) {
          // Spherical bearing ref→current
          const dLng = (ll.lng - _ref.lng) * Math.PI / 180;
          const lat1 = _ref.lat * Math.PI / 180;
          const lat2 = ll.lat * Math.PI / 180;
          rawBrg = (Math.atan2(
            Math.sin(dLng) * Math.cos(lat2),
            Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng)
          ) * 180 / Math.PI + 360) % 360;
        }
      }
      if (rawBrg != null) {
        _lastBearingLL = ll;
        if (_smoothBearing === null) {
          _smoothBearing = rawBrg;
        } else {
          let diff = rawBrg - _smoothBearing;
          if (diff > 180) diff -= 360;
          if (diff < -180) diff += 360;
          _smoothBearing = (_smoothBearing + 0.55 * diff + 360) % 360;
        }
        // leaflet-rotate setBearing applies CSS rotate(+theta) clockwise.
        // Track-up (heading at top of screen) requires CCW rotation, so negate.
        _setBearingIfVisible(-_smoothBearing);
      }
    }
    // stopped → do nothing: the map keeps its last bearing (no random spin)
  } else {
    _smoothBearing = null;
    _lastBearingLL = null;
    _lastMoveLL    = null;
    _isMoving      = false;
  }

  // View cone: sector showing direction of travel, only while WALKING and actually
  // moving. Hidden at standstill — with no real motion the direction is undefined, and
  // drawing it from a jittery source pointed it the wrong way. Uses the same gated,
  // GPS-derived _smoothBearing as the map rotation, so cone and view stay consistent.
  const _navProf = typeof window.navGetProfile === 'function' ? window.navGetProfile() : 'driving';
  if (!_isFlying && typeof navIsActive === 'function' && navIsActive()
      && _navProf === 'walking' && _isMoving && _smoothBearing != null) {
    const _sectorPts = (function(c, brg, halfAng, rM, steps) {
      const pts = [c];
      const cosLat = Math.cos(c.lat * Math.PI / 180);
      for (let i = 0; i <= steps; i++) {
        const a = (brg - halfAng + (2 * halfAng * i / steps)) * Math.PI / 180;
        pts.push(L.latLng(c.lat + (rM / 111320) * Math.cos(a),
                          c.lng + (rM / (111320 * cosLat)) * Math.sin(a)));
      }
      pts.push(c);
      return pts;
    })(ll, _smoothBearing, 35, 45, 12);
    /* Reshape in place instead of destroying and recreating. Rebuilding removed what was ON
       SCREEN and only then added the replacement — once per fix, in the overlay pane, beside
       every other vector on the map. Same mistake _dropNext was written to fix on the WMS
       double buffer, and the marker and accuracy circle just above already avoid it by moving
       in place. Safe to reuse: the only other place that removes the cone nulls it as well, so
       a non-null _gpsViewCone is always still on the map, and setLatLngs takes the same flat
       ring the constructor was given, keeping style and pane untouched. */
    if (_gpsViewCone) {
      _gpsViewCone.setLatLngs(_sectorPts);
    } else {
      _gpsViewCone = L.polygon(_sectorPts, {
        color: '#4f8ef7', weight: 1, opacity: 0.7,
        fillColor: '#4f8ef7', fillOpacity: 0.18
      }).addTo(map);
    }
  } else {
    if (_gpsViewCone) { map.removeLayer(_gpsViewCone); _gpsViewCone = null; }
  }

  _prevGpsLL = ll;

  // Forward to GPS track
  /* altMsl, not alt: a GPX <ele> is defined as height above sea level, and the elevation
     profile is read against contour lines that mean the same thing. */
  if (typeof trackActive !== 'undefined' && trackActive) updateTrack(ll, altMsl, ts);
  // Forward to navigation
  if (typeof navGpsUpdate === 'function') navGpsUpdate(ll);
  if (typeof navHudUpdate === 'function') navHudUpdate(ll, spd);
}

function gpsError(err, btn) {
  const msgs = { 1: 'permission denied', 2: 'position unavailable', 3: 'timeout' };
  // Only permission-denied is fatal — retrying is pointless. Stop the watch and turn GPS off.
  if (err.code === 1) {
    toastMsg('GPS: permesso negato — Impostazioni › App › GISCatasto › Autorizzazioni', 'error', undefined, 'sidebar');
    gpsActive = false; btn.classList.remove('gps-on');
    _releaseWakeLock();
    if (_gpsRetryTid) { clearTimeout(_gpsRetryTid); _gpsRetryTid = null; }
    if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
    const accItem = document.getElementById('sb-acc-item');
    if (accItem) accItem.style.display = 'none';
    return;
  }
  // Timeout / position-unavailable are TRANSIENT (cold fix, indoors, battery throttling): the
  // fix may still arrive, so keep GPS "on" and restart the watch instead of giving up — the
  // old code cleared the watch here, so a single slow first fix killed GPS until re-toggled.
  // Restart after a short delay so an immediately-firing error can't spin a tight loop.
  if (!gpsActive) return;
  toastMsg('GPS: ricerca del segnale…', 'warn', undefined, 'map-quiet');
  if (gpsWatchId !== null) { try { navigator.geolocation.clearWatch(gpsWatchId); } catch(_) {} gpsWatchId = null; }
  if (_gpsRetryTid) clearTimeout(_gpsRetryTid);
  _gpsRetryTid = setTimeout(() => {
    _gpsRetryTid = null;
    if (!gpsActive) return;   // user turned GPS off during the delay
    gpsWatchId = navigator.geolocation.watchPosition(pos => gpsUpdate(pos), e => gpsError(e, btn), _GPS_OPTS);
  }, 5000);
}

/* Start (or restart) the position watch. One path for both the GPS toggle and the
   transient-error retry. Guards gpsActive so a late callback can't re-arm a stopped GPS. */
function _startGpsWatch(btn) {
  if (!gpsActive) return;
  if (gpsWatchId !== null) { try { navigator.geolocation.clearWatch(gpsWatchId); } catch(_) {} }
  gpsWatchId = navigator.geolocation.watchPosition(pos => gpsUpdate(pos), err => gpsError(err, btn), _GPS_OPTS);
}

function toggleGPS(btn) {
  if (!navigator.geolocation) { toastMsg('GPS non supportato', 'error'); return; }
  if (!gpsActive) {
    gpsActive = true; gpsFirstFix = false;
    btn.classList.add('gps-on');
    _acquireWakeLock();
    // If device location is off, ask Android to turn it on (system one-tap dialog) before
    // watching — this is the fix for "GPS on in the app but nothing detected until I
    // re-toggle". Falls back to watching directly in the browser or without Play Services.
    const _la = window.cordova && cordova.plugins && cordova.plugins.locationAccuracy;
    if (_la && _la.request) {
      // BALANCED (not HIGH): the dialog appears only when device location is fully OFF —
      // if it's already on in any mode we proceed silently. High-accuracy GPS is still
      // requested by the watch itself via enableHighAccuracy.
      _la.request(() => _startGpsWatch(btn), () => _startGpsWatch(btn), _la.REQUEST_PRIORITY_BALANCED_POWER_ACCURACY);
    } else {
      _startGpsWatch(btn);
    }
  } else {
    gpsActive = false;
    btn.classList.remove('gps-on');
    _releaseWakeLock();
    if (_gpsRetryTid) { clearTimeout(_gpsRetryTid); _gpsRetryTid = null; }
    if (gpsWatchId !== null) { navigator.geolocation.clearWatch(gpsWatchId); gpsWatchId = null; }
    if (gpsMarker) { map.removeLayer(gpsMarker); gpsMarker = null; _gpsMarkerKind = null; }
    if (gpsCircle) { map.removeLayer(gpsCircle); gpsCircle = null; }
    const _fp = document.getElementById('flight-panel');
    if (_fp) _fp.classList.add('hidden');
    _gpsWasFlying = false;
    const accItem = document.getElementById('sb-acc-item');
    if (accItem) accItem.style.display = 'none';
    const brgItem = document.getElementById('sb-brg-item');
    if (brgItem) brgItem.style.display = 'none';
    const spdItem = document.getElementById('sb-spd-item');
    if (spdItem) spdItem.style.display = 'none';
  }
}

/* ===== KML POPUP SANITIZE ===== */
map.on('popupopen', e => {
  const el = e.popup.getElement();
  if (!el) return;
  el.querySelectorAll('[bgcolor]').forEach(n => n.removeAttribute('bgcolor'));
  el.querySelectorAll('[background]').forEach(n => n.removeAttribute('background'));
  el.querySelectorAll('[color]').forEach(n => n.removeAttribute('color'));
  el.querySelectorAll('[style]').forEach(n => {
    let s = n.getAttribute('style') || '';
    s = s.replace(/background(-color)?:[^;]+;?/gi, '').replace(/\bcolor:[^;]+;?/gi, '');
    n.setAttribute('style', s);
  });
});

/* ===== MAP TOOLS BUTTON ===== */
const MapToolsControl = L.Control.extend({
  options: { position: 'topright' },
  onAdd() {
    const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-tools');
    const a = L.DomUtil.create('a', '', div);
    a.href = '#'; a.title = 'Coordinate tools';
    a.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="10" r="3"/><path d="M12 2a8 8 0 0 1 8 8c0 5.25-8 14-8 14S4 15.25 4 10a8 8 0 0 1 8-8z"/></svg>';
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.on(a, 'click', e => {
      L.DomEvent.preventDefault(e);
      const _mt = document.getElementById('map-tools');
      _mt.classList.toggle('hidden');
      if (!_mt.classList.contains('hidden')) _mt.style.zIndex = ++window._panelZTop;
    });
    return div;
  }
});
new MapToolsControl().addTo(map);

/* ===== TOPBAR SEARCH (Nominatim) ===== */
const topbarSearchInput = document.getElementById('search-input');
const searchClearBtn    = document.getElementById('search-clear');
let searchMarker = null;

topbarSearchInput.addEventListener('input', () => {
  searchClearBtn.style.display = topbarSearchInput.value ? 'flex' : 'none';
});
searchClearBtn.addEventListener('click', () => {
  topbarSearchInput.value = '';
  searchClearBtn.style.display = 'none';
  topbarSearchInput.focus();
});
_attachAddressSearch(
  topbarSearchInput,
  (lat, lon, name) => {
    map.flyTo([+lat, +lon], 14);
    if (searchMarker) map.removeLayer(searchMarker);
    searchMarker = L.circleMarker([+lat, +lon], { radius: 8, color: '#4f8ef7', fillColor: '#4f8ef7', fillOpacity: 0.6 })
      .addTo(map).bindPopup(`<b>${name}</b>`).openPopup();
    toastMsg('Trovato: ' + name.split(',')[0], 'success');
  }
);

/* ===== COORDINATE DISPLAY ===== */
function updateCoordDisplays(lat, lon) {
  const latStr = lat.toFixed(6), lonStr = lon.toFixed(6);
  let utmStr = '--', mgrsStr = '--';
  try { const utm = UTM.fromLatLng({ lat, lng: lon }); utmStr = `${utm.zone} ${Math.round(utm.x)} ${Math.round(utm.y)}`; } catch(e) {}
  mgrsStr = mgrsForward(lon, lat);
  const dmStr = coordToDM(lat, lon);

  document.getElementById('tc-lat').textContent  = latStr;
  document.getElementById('tc-lon').textContent  = lonStr;
  document.getElementById('tc-mgrs').textContent = mgrsStr;
  document.getElementById('sb-lat').textContent  = latStr;
  document.getElementById('sb-lon').textContent  = lonStr;
  document.getElementById('sb-dm').textContent   = dmStr;
  document.getElementById('sb-utm').textContent  = utmStr;
  document.getElementById('sb-mgrs').textContent = mgrsStr;
}

map.on('mousemove', e => updateCoordDisplays(e.latlng.lat, e.latlng.lng));
map.on('move', () => { const c = map.getCenter(); updateCoordDisplays(c.lat, c.lng); });
function _saveView() {
  const c = map.getCenter();
  try { localStorage.setItem('giscatasto_view', JSON.stringify({ lat: c.lat, lng: c.lng, zoom: map.getZoom(), bearing: map.getBearing() })); } catch(_) {}
}

/* Debounced exactly the way _WMSImageLayer._schedule debounces a refresh, and for the same
   reason. leaflet-rotate has no 'rotateend': the two-finger gesture calls setBearing once per
   touch frame and setBearing fires 'rotate' unconditionally, so one turn used to write the view
   tens of times — and each write is a synchronous JSON.stringify plus a localStorage.setItem on
   the main thread, while the map itself turns on the compositor. Measured on this bench with a
   real clock: 0.338 ms per rotation frame with the write against 0.051 ms without it.
   Nothing reads the saved view during a gesture; only the next cold start does, so the last
   write was always the only one that mattered.
   Losing it on a kill is not a risk: visibilitychange, pagehide and pause call _saveView
   directly and unthrottled, so the pending write is flushed by whichever of those fires. */
let _saveViewTid = null;
function _saveViewSoon() {
  clearTimeout(_saveViewTid);
  _saveViewTid = setTimeout(_saveView, 300);
}

/* Looked up on first use rather than at parse time: the element happens to precede this
   script today, and a reordering of the page must not silently stop the readout. */
let _zoomLevelEl = null;

map.on('moveend zoomend rotate', () => {
  _saveViewSoon();
  /* A rotation cannot change the zoom, so this used to rewrite the same string once per frame.
     Same question _FOLLOW_MIN_PX asks of a pan: does the screen actually change? */
  if (!_zoomLevelEl) _zoomLevelEl = document.getElementById('zoom-level');
  const z = String(map.getZoom());
  if (_zoomLevelEl && _zoomLevelEl.textContent !== z) _zoomLevelEl.textContent = z;
});

document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') _saveView(); });
window.addEventListener('pagehide', _saveView);
document.addEventListener('pause', _saveView, false);

/* Let a long-press select/copy popup text: stop the contextmenu (long-press) from
   reaching the map, so Leaflet neither opens the coordinate menu nor preventDefaults
   the browser's native text selection. Bound once; every popup gets it on open. */
map.on('popupopen', e => {
  const node = e.popup && e.popup._container;
  if (node) L.DomEvent.on(node, 'contextmenu', L.DomEvent.stopPropagation);
});

/* ===== CONTEXTMENU ===== */
map.on('contextmenu', e => {
  const pmActive = !!document.querySelector('.polyline-measure-controlOnBgColor');
  if (mapToolActive || pmActive) return;
  // Belt-and-suspenders: if a long-press inside a popup still reaches here, it is the
  // user selecting text — don't open the coordinate menu over the selection.
  const oe = e.originalEvent;
  if (oe && oe.target && oe.target.closest && oe.target.closest('.leaflet-popup')) return;
  const { lat, lng } = e.latlng;
  const dd   = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
  const dm   = coordToDM(lat, lng);
  const dms  = `${latToDMS(lat)}, ${lonToDMS(lng)}`;
  const mgrs = mgrsForward(lng, lat);
  let utm = '--';
  try { const u = UTM.fromLatLng({lat, lng}); utm = `${u.zone} ${Math.round(u.x)} ${Math.round(u.y)}`; } catch(_) {}

  const div = document.createElement('div');
  div.style.cssText = 'font-size:12px;font-family:monospace;line-height:1.9';
  div.innerHTML =
    `<div><b style="color:var(--accent)">DD&nbsp;&nbsp;&nbsp;</b>${dd}</div>` +
    `<div><b style="color:var(--accent)">DM&nbsp;&nbsp;&nbsp;</b>${dm}</div>` +
    `<div><b style="color:var(--accent)">DMS&nbsp;&nbsp;</b>${dms}</div>` +
    `<div><b style="color:var(--accent)">UTM&nbsp;&nbsp;</b>${utm}</div>` +
    `<div><b style="color:var(--accent)">MGRS&nbsp;</b>${mgrs}</div>` +
    `<div><b style="color:var(--accent)">ELEV&nbsp;&nbsp;</b><span class="ctx-elev">fetching&hellip;</span></div>`;

  // Async elevation fetch for contextmenu
  if (typeof fetchElevation === 'function') {
    fetchElevation(lat, lng).then(val => {
      const el = div.querySelector('.ctx-elev');
      if (el) el.textContent = val != null ? val + ' m' : '--';
    });
  }

  const copyBtn = document.createElement('button');
  copyBtn.className = 'draw-save-btn'; copyBtn.style.marginTop = '6px';
  copyBtn.textContent = '\uD83D\uDCCB Copia tutto';
  copyBtn.addEventListener('click', () => {
    const text = `DD: ${dd}\nDM: ${dm}\nDMS: ${dms}\nUTM: ${utm}\nMGRS: ${mgrs}`;
    if (navigator.clipboard) navigator.clipboard.writeText(text)
      .then(() => toastMsg('Coordinate copiate', 'success')).catch(() => fallbackCopy(text));
    else fallbackCopy(text);
  });
  div.appendChild(copyBtn);

  // Quick add marker
  const mrkBtn = document.createElement('button');
  mrkBtn.className = 'draw-save-btn';
  mrkBtn.style.cssText = 'margin-top:4px;background:linear-gradient(135deg,#4f8ef7,#6c5ce7)';
  mrkBtn.textContent = '\uD83D\uDCCD Aggiungi un segnaposto qui';
  mrkBtn.addEventListener('click', () => {
    map.closePopup();
    const layer = L.marker([lat, lng], { icon: makeEmojiIcon('pos') });
    layer._geoName = ''; layer._geoDesc = ''; layer._geoIcon = 'pos'; layer._geoColor = '#4f8ef7';
    /* The same fields and the same wiring a drawn marker gets. Three were missing here: the
       type, so a later popup could not tell it was a marker and dropped the icon picker; the
       click handler, so the popup was never rebuilt; and the save, so a marker added and left
       alone was gone at the next launch. */
    layer._geoType = 'marker'; layer._geoOpacity = 1;
    _assignDrawPane(layer);   // no-op for markers (kept for a single consistent add path)
    drawnItems.addLayer(layer);
    updateDrawStats(layer);
    layer.on('click', () => _openDrawPopup(layer, layer._geoType));
    _openDrawPopup(layer, 'marker');
    if (typeof _saveDraws === 'function') _saveDraws();
  });
  div.appendChild(mrkBtn);

  // Bookmark
  const bmBtn = document.createElement('button');
  bmBtn.className = 'draw-save-btn';
  bmBtn.style.cssText = 'margin-top:4px;background:linear-gradient(135deg,#f5a623,#e67e22)';
  bmBtn.textContent = '\u2B50 Salva questa posizione';
  bmBtn.addEventListener('click', () => {
    map.closePopup();
    const defName = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    showPromptModal('Nome del segnalibro:', defName, name => {
      addBookmark(name || defName, lat, lng, map.getZoom());
    });
  });
  div.appendChild(bmBtn);

  L.popup({ maxWidth: 300 }).setLatLng(e.latlng).setContent(div).openOn(map);
});

/* ===== RESIZE / ORIENTATION (portrait fix) ===== */
(function() {
  let _rsTimer;
  function _doResize() {
    clearTimeout(_rsTimer);
    _rsTimer = setTimeout(() => {
      try { map.invalidateSize(); } catch(_) {}
    }, 250);
  }
  window.addEventListener('resize', _doResize);
  window.addEventListener('orientationchange', _doResize);
})();

/* ===== FLIGHT PANEL — drag + close ===== */
(function() {
  const panel = document.getElementById('flight-panel');
  const grip  = panel ? panel.querySelector('.flight-drag-header') : null;
  if (!panel || !grip) return;

  /* --hud-lane is how far the toast has to rise to clear this panel. It was a measured constant
     (112 px here, 152 in the sibling app) \u2014 a snapshot of a height that is not fixed: the panel
     declares no height, it grows with the Android font scale, and collapsing it hides the whole
     grid. Collapsed, the toast still floated the full lane. So read the height the browser has
     already computed rather than remembering one screen's answer; it then tracks the panel in
     every state, at every font size, on every device, and the two apps stop needing two numbers.
     The 10 px is the same gap --lane-bottom already puts between stacked things, not a new
     measurement. The literal in the CSS stays as the fallback for a browser without
     ResizeObserver, and for the case where this block throws. */
  const _setHudLane = () => {
    try {
      const h = panel.offsetHeight;
      if (h > 0) document.documentElement.style.setProperty('--hud-lane', (h + 10) + 'px');
    } catch (_) {}
  };
  /* Two observers, because the height changes for two different reasons and each misses the
     other's. ResizeObserver catches the content growing — a larger system font, a longer
     readout. MutationObserver on the class catches the panel being shown, hidden or collapsed,
     which is done from several places in this file and would otherwise have to be hooked at
     each of them; it also fires as a microtask, so the new height is already laid out when it
     is read, whereas waiting for the resize callback leaves the lane briefly stale. */
  /* Both observers are HELD in variables on purpose. An observer whose only target is
     display:none has no active observation, so nothing keeps an unreferenced one alive and it
     can be collected before the panel is ever shown — measured on the bench: written as
     `new ResizeObserver(cb).observe(panel)` it never fired once, while the same construct on an
     already-visible element fired normally. */
  let _hudRO = null, _hudMO = null;
  if (window.ResizeObserver) {
    try { _hudRO = new ResizeObserver(_setHudLane); _hudRO.observe(panel); } catch (_) {}
  }
  if (window.MutationObserver) {
    try { _hudMO = new MutationObserver(_setHudLane);
          _hudMO.observe(panel, { attributes: true, attributeFilter: ['class'] }); } catch (_) {}
  }
  _setHudLane();

  const _fpCol = document.getElementById('flight-collapse');
  if (_fpCol) _fpCol.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    _fpCol.textContent = panel.classList.contains('collapsed') ? '+' : '\u2212';
    _setHudLane();   // collapsing removes the grid; the lane must follow it down
  });

  let dragging = false, startX, startY, origLeft, origTop;
  function _onStart(cx, cy) {
    dragging = true; startX = cx; startY = cy;
    panel.style.zIndex = ++window._panelZTop;
    if (!panel.style.left || panel.style.bottom) {
      const r = panel.getBoundingClientRect();
      panel.style.bottom = 'auto'; panel.style.right = 'auto';
      panel.style.left = r.left + 'px'; panel.style.top = r.top + 'px';
    }
    origLeft = parseFloat(panel.style.left); origTop = parseFloat(panel.style.top);
  }
  function _onMove(cx, cy) {
    if (!dragging) return;
    panel.style.left = Math.max(0, Math.min(window.innerWidth  - panel.offsetWidth,  origLeft + cx - startX)) + 'px';
    panel.style.top  = Math.max(0, Math.min(window.innerHeight - panel.offsetHeight, origTop  + cy - startY)) + 'px';
  }
  function _onEnd() { dragging = false; }

  grip.addEventListener('mousedown',  e => { _onStart(e.clientX, e.clientY); e.preventDefault(); });
  grip.addEventListener('touchstart', e => { _onStart(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); }, { passive: false });
  document.addEventListener('mousemove',  e => _onMove(e.clientX, e.clientY));
  document.addEventListener('touchmove',  e => { if (dragging) { _onMove(e.touches[0].clientX, e.touches[0].clientY); e.preventDefault(); } }, { passive: false });
  document.addEventListener('mouseup',  _onEnd);
  document.addEventListener('touchend', _onEnd);
})();

/* ===== BASEMAP SWITCHER ===== */
let wsCounter = 0, currentBasemapId = 'osm_std';
// WFS server traits learned from GetCapabilities, keyed by URL: { jsonSupported, version }.
// Consumed at Add time so legacy servers (e.g. MapServer PCN: WFS 1.1.0, GML-only) skip outputFormat=json.
const _wfsCapsByUrl = {};
// WMS min zoom derived from each layer's scale window (MaxScaleDenominator) at GetCapabilities,
// keyed by `url|layerName`. Consumed at Add time so a WMS overlay stops requesting an empty
// image below the range where the server actually draws it.
const _wmsMinZoomByLayer = {};
const customMapConfigs = [];

/* Hand TLS trust back to the platform. The historic 'nocheck' bypass is gone — it accepted any
   certificate from any server, and Play's security review flags it — but simply dropping the call
   was not enough: the plugin's own default builds a TrustManager straight from "AndroidCAStore",
   which is blind to res/xml/network_security_config.xml. 'legacy' is a misleading name for
   setTrustManagers(null), and SSLContext.init(…, null, …) means "use the platform default", i.e.
   the trust manager that does read the network security config.
   That matters here: the Agenzia Entrate WMS chains to a root absent from older Android CA stores,
   so every cadastral overlay failed with SSLException (plugin status -2) until the extra anchor
   declared there could apply. Certificate and hostname validation stay fully standard. */
document.addEventListener('deviceready', () => {
  if (window.cordova && cordova.plugin && cordova.plugin.http) {
    cordova.plugin.http.setServerTrustMode('legacy', function(){}, function(){});
  }
});

/* Non-tiled WMS image layer: requests one GetMap image per map view.
   Correct approach for WMS servers (e.g. Italian cadastral) that do not properly
   handle 256×256 tile requests — they return the full-extent image for every
   small-BBOX tile, making the whole country appear repeated in every tile slot.
   This layer instead requests a single image covering the current viewport,
   refreshing on moveend/zoomend.  Fetch is via cordova.plugin.http (certificates validated).
   BBOX and CRS are computed from current map bounds — no screen-pixel coordinates
   are used as geographic values. */
/* Revoke an object URL if that is what it is — no-op for plain http(s) URLs, which is
   what _show receives on the non-Cordova path. */
function _revokeObj(u) {
  if (u && u.indexOf('blob:') === 0) { try { URL.revokeObjectURL(u); } catch(_) {} }
}

/* Diagnostic only: name a non-image WMS response in the console instead of letting it
   be drawn as a broken image. Covers the servers the content-type check cannot catch —
   those that omit the header, and those that return a ServiceException labelled
   image/png. Never changes what is displayed. */
function _warnIfNotImage(data, url) {
  try {
    const b = new Uint8Array(data);
    if (b.length < 4) { console.warn('[giscatasto] WMS response is empty or truncated:', b.length, 'bytes —', url); return; }
    const isPNG  = b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47;
    const isJPEG = b[0] === 0xFF && b[1] === 0xD8;
    const isGIF  = b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46;
    // RIFF….WEBP and BMP too: a server legitimately answering in these formats must not
    // be reported as an error just because the sniff list was too short.
    const isWEBP = b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46;
    const isBMP  = b[0] === 0x42 && b[1] === 0x4D;
    if (isPNG || isJPEG || isGIF || isWEBP || isBMP) return;
    console.warn('[giscatasto] WMS response is not an image —', _wmsErrorText(data), '|', url);
  } catch(_) {}
}

/* Turn a WMS error response body (HTML page or OGC ServiceException) into one short
   readable line for a toast. Prefers the ServiceException text when present. */
function _wmsErrorText(data) {
  if (!data) return 'nessuna risposta dal server';
  try {
    const all = data instanceof Uint8Array ? data : new Uint8Array(data);
    /* Only the head is decoded. A ServiceException message lives in the first few
       hundred bytes, while this also runs on the per-response sniff — decoding a whole
       multi-megabyte image to a string on every pan would cost far more than the
       diagnostic is worth. */
    const bytes = all.length > 4096 ? all.subarray(0, 4096) : all;
    const txt = new TextDecoder('utf-8', { fatal:false }).decode(bytes);
    const se  = txt.match(/<ServiceException[^>]*>([\s\S]*?)<\/ServiceException>/i);
    const raw = se ? se[1] : txt;
    return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160)
           || 'risposta del servizio illeggibile';
  } catch(_) { return 'risposta del servizio illeggibile'; }
}

/* Ceiling on a single GetMap, in pixels per side. Only a rotated request can reach it: at
   bearing 0 the image is the screen. */
const _WMS_MAX_PX = 2048;
/* How long a frame that has been asked for may stay pending before it is given up on. It
   used to be the deadline for dropping the frame ALREADY on screen, which is the opposite
   trade — see the swap in _update. */
const _WMS_FRAME_MS = 12000;

const _WMSImageLayer = L.Layer.extend({
  options: { layers:'', version:'1.1.1', crs:null, format:'image/png',
             transparent:true, opacity:0.8, attribution:'', minZoom:null },

  initialize(url, options) {
    // Keep non-OGC query params (e.g. MapServer's mandatory ?map=/path.map) instead of
    // dropping the whole query string — without them a MapServer endpoint returns an
    // error page instead of an image. Same split the WFS layer uses.
    const _sp = _splitOgcUrl(url);
    this._wmsUrl = _sp.base.replace(/\/$/, '');
    this._wmsPre = _sp.pre;
    L.setOptions(this, options);
    this._overlay = null;
    this._overlayUrl = null;   // object URL backing _overlay, revoked when replaced
    this._reqId   = 0;
  },

  onAdd(map) {
    this._map = map;
    // Render the image in a dedicated pane inside rotatePane so vectors (KML, drawings,
    // WFS) draw on top. Without this the image lands in the default overlayPane and
    // re-stamps over sibling vectors on every moveend/zoomend (they flicker and vanish
    // under it). A basemap uses z-index 250 (above tiles at 200, below overlayPane 400);
    // a WMS overlay uses 260, so it sits above the basemap but still below the vectors.
    const paneName = this.options.pane || 'wms-basemap-img';
    const paneZ    = this.options.paneZIndex || 250;
    if (!map.getPane(paneName)) {
      const p = map.createPane(paneName);
      p.style.zIndex = paneZ;
      const rotatePane = map.getPane('rotatePane');
      if (rotatePane) rotatePane.appendChild(p);
    }
    _reorderMapPanes(map);
    /* moveend goes through the coverage guard below; zoomend and resize do not, because a
       zoom changes the resolution the image was asked at and a resize changes the screen it
       has to cover, so both always need a fresh one. */
    map.on('moveend', this._onViewChange, this);
    map.on('zoomend resize', this._schedule, this);
    map.on('rotate', this._onRotate, this);
    this._schedule();
  },

  onRemove(map) {
    clearTimeout(this._timer);
    /* Invalidate any in-flight request, as the WFS layer already does. The success callback
       only checks the generation, so without this a reply landing after the layer was switched
       off still runs _show(): it adds its image overlay to the map and assigns this._overlay,
       AFTER _removeOverlay() has run — and nothing would ever take that frame off again.
       The hasLayer test on the -2 retry path below is kept as well; it now guards a case this
       already covers, which is the right way round for two independent checks. */
    this._reqId = (this._reqId || 0) + 1;
    map.off('moveend', this._onViewChange, this);
    map.off('zoomend resize', this._schedule, this);
    map.off('rotate', this._onRotate, this);
    this._fetchedBounds = null;
    this._fetchedZoom   = null;
    this._removeOverlay();
  },

  setOpacity(opacity) {
    this.options.opacity = opacity;
    if (this._overlay) this._overlay.setOpacity(opacity);
  },

  _removeOverlay() {
    if (this._overlay) {
      try { this._map.removeLayer(this._overlay); } catch(_) {}
      this._overlay = null;
    }
    _revokeObj(this._overlayUrl);
    this._overlayUrl = null;
  },

  _schedule() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this._update(), 300);
  },

  /* The area to ask the image for. Asking for the viewport envelope ties the request to the
     bearing it was made at, and the envelope is TIGHT: measured on the bench, one degree of
     turn is enough for the corners of the screen to leave it. That cannot be answered by
     re-fetching on every rotation — a GPS course wobbles a degree or two at cycling speed
     and the fetch would be back to once a second, which is the whole defect. So a rotated
     map asks for the square that circumscribes the viewport instead: it covers the screen at
     EVERY bearing, so once one image has been fetched no amount of turning asks for another.
     It costs 2.67× the pixels of a screen-sized request (1003² against 412×915 on the test
     phone) but is asked for only when the view really moves, which is far less often than
     the once-per-fix it replaces. A north-up map asks for the screen exactly as before, so
     the ordinary browsing case pays nothing for this. */
  _requestBounds() {
    const map = this._map;
    if (typeof map.getBearing !== 'function' || !map.getBearing()) return map.getBounds();
    const size = map.getSize();
    const r    = Math.ceil(Math.sqrt(size.x * size.x + size.y * size.y) / 2);
    const z    = map.getZoom();
    const c    = map.project(map.getCenter(), z);
    return L.latLngBounds(map.unproject(c.add(L.point(-r,  r)), z),
                          map.unproject(c.add(L.point( r, -r)), z));
  },

  /* Rotation fires no moveend, so nothing else would notice that the screen has left the
     image. In practice this fires once — on the first degree of the first turn, when the
     north-up request above is still the one on screen — and the image it asks for is the
     bearing-independent square, which no later turn can uncover. It closes the same gap for
     the two-finger rotate gesture, which never fired moveend either. */
  /* Is the image already on screen still good enough? Only if it was asked for at this zoom
     and the four corners of the screen all fall inside the area it covers. */
  _covered() {
    const b = this._fetchedBounds;
    if (!b || !this._map) return false;
    const map = this._map;
    if (this._fetchedZoom !== map.getZoom()) return false;
    const s = map.getSize();
    return [[0, 0], [s.x, 0], [s.x, s.y], [0, s.y]]
      .every(p => b.contains(map.containerPointToLatLng(p)));
  },

  _onRotate() {
    if (this._fetchedBounds && !this._covered()) this._schedule();
  },

  /* The same question, asked on moveend, where it never used to be asked at all. A rotated map
     is holding the circumscribed square — 2.67x the screen — fetched precisely so that turning
     cannot uncover it; and then a few pixels of finger drift at the end of a two-finger gesture
     threw that away and made every layer fetch again and repaint. Measured on the bench: a pure
     45 degree turn costs nothing, while the same turn followed by 18x12 px of drift refetched
     all five WMS layers and rebuilt four image overlays.
     At bearing 0 the fetched bounds ARE the screen, so any pan uncovers them and this behaves
     exactly as it did before: the north-up browsing case pays nothing and changes nothing. */
  _onViewChange() {
    if (!this._covered()) this._schedule();
  },

  /* The pixel size to ask the image at. On a north-up map this is the screen and the request
     is byte-for-byte the one that has always been sent. Under track-up navigation it is not:
     leaflet-rotate's getBounds() returns the envelope of the four ROTATED corners, which is
     larger than the screen, and asking for that area at screen size stretches the image and
     — the part that shows — changes metres per pixel with the bearing. A WMS reads its
     per-layer scale window off exactly that ratio, so the same view at the same zoom crossed
     scale windows as the map turned: measured on the bench at 412×915, 0.861 m/px at 0°,
     1.461 at 30°, 1.620 at 45°, nearly a full zoom level lost. On the Agenzia Entrate
     cadastre out of window is not an error but an empty PNG with HTTP 200 (particelle draw
     from z17), so the layer blanked and came back as the bearing turned. Sizing the request
     to the envelope keeps one image pixel on one screen pixel at every bearing. The cap
     bounds what a rotated request on a large screen can ask for; the floor keeps it from
     ever asking for less than it does today. */
  _imageSize(bounds) {
    const map = this._map;
    const screen = map.getSize();
    if (typeof map.getBearing !== 'function' || !map.getBearing()) return screen;
    const z  = map.getZoom();
    const nw = map.project(bounds.getNorthWest(), z);
    const se = map.project(bounds.getSouthEast(), z);
    let w = Math.max(screen.x, Math.round(Math.abs(se.x - nw.x)));
    let h = Math.max(screen.y, Math.round(Math.abs(se.y - nw.y)));
    /* Over the ceiling both sides come down by the same factor, so the image keeps one scale
       on both axes — capping them independently would ask for a different number of metres
       per pixel across than down, which is the defect this method exists to remove. */
    const over = Math.max(w, h) / _WMS_MAX_PX;
    if (over > 1) { w = Math.round(w / over); h = Math.round(h / over); }
    return L.point(w, h);
  },

  _buildUrl(bounds, size) {
    const crs     = this.options.crs || L.CRS.EPSG4326;
    const crsCode = this.options.crsCode || crs.code || 'EPSG:4326';
    const geoAxes = this.options.geoAxes !== undefined
      ? this.options.geoAxes
      : /^EPSG:(4326|4258|6706)$/.test(crsCode) || crsCode === 'CRS:84';
    const ver   = this.options.version || '1.1.1';
    const isV13 = parseFloat(ver) >= 1.3;
    const sw    = crs.project(bounds.getSouthWest());
    const ne    = crs.project(bounds.getNorthEast());
    // WMS 1.3.0 + geographic CRS: axis order is lat,lon (south,west,north,east)
    // WMS 1.1.x or projected CRS: x,y order (west,south,east,north)
    const bbox  = (isV13 && geoAxes)
      ? [sw.y, sw.x, ne.y, ne.x].join(',')
      : [sw.x, sw.y, ne.x, ne.y].join(',');
    const p = {
      SERVICE:'WMS', VERSION:ver, REQUEST:'GetMap',
      LAYERS:this.options.layers, STYLES:'',
      FORMAT:this.options.format,
      TRANSPARENT:this.options.transparent ? 'TRUE' : 'FALSE',
      WIDTH:size.x, HEIGHT:size.y, BBOX:bbox
    };
    // An opaque request needs the paper colour spelled out: several servers compose on black
    // when BGCOLOR is missing, which is how a line-work map arrives as a negative.
    if (!this.options.transparent) p.BGCOLOR = this.options.bgcolor || '0xFFFFFF';
    p[isV13 ? 'CRS' : 'SRS'] = crsCode;
    return this._wmsUrl + '?' +
      (this._wmsPre ? this._wmsPre + '&' : '') +
      Object.entries(p).map(([k,v]) => encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');
  },

  _update() {
    const map = this._map;
    if (!map) return;
    /* The screen size is the "is the map laid out yet" guard; the requested size is the one
       that keeps the scale bearing-independent (see _imageSize). */
    if (!map.getSize().x || !map.getSize().y) return;
    const bounds = this._requestBounds();
    const size   = this._imageSize(bounds);
    // Below the layer's scale window there is nothing to draw — the server would answer with an
    // empty image. Skip the request (and drop any stale frame) and nudge the user to zoom in,
    // mirroring the WFS minZoom behaviour. Only set for overlays, so a basemap is never blanked.
    if (this.options.minZoom != null && map.getZoom() < this.options.minZoom) {
      this._reqId++;   // invalidate any in-flight response so it can't paint a below-scale frame
      this._removeOverlay();
      const now = Date.now();
      if (!this._lastZoomWarn || now - this._lastZoomWarn > 5000) {
        const who = this.options.attribution ? '"' + this.options.attribution + '"' : 'WMS layer';
        _reportBelowScale(who);
        this._lastZoomWarn = now;
      }
      return;
    }
    const reqId = ++this._reqId;
    /* What the image about to be asked for will cover — the reference _onRotate checks the
       screen against. Recorded when the request is issued, not when it lands, so a turn
       during a slow fetch does not queue a second one for the same view. */
    this._fetchedBounds = bounds;
    this._fetchedZoom   = map.getZoom();
    const url   = this._buildUrl(bounds, size);
    const _show = imgUrl => {
      // A response that lost the race must still release its object URL, otherwise the
      // fast-panning case leaks exactly the buffers this path exists to avoid copying.
      if (reqId !== this._reqId) { _revokeObj(imgUrl); return; }
      this._errShown = false;   // a good frame clears the error latch for the next failure
      const prev    = this._overlay;
      const prevUrl = this._overlayUrl;
      const next    = L.imageOverlay(imgUrl, bounds, {
        opacity:this.options.opacity, zIndex:200, pane:this.options.pane || 'wms-basemap-img'
      });
      /* Keep the previous frame on screen until the new one has actually decoded and
         painted. Adding the new image and dropping the old one in the same tick looked
         like double buffering but was not: the browser had nothing to show in between,
         which is the flicker seen on every pan and zoom. Handlers are attached before
         addTo because an object URL can finish loading immediately. */
      let settled = false;
      const _dropPrev = () => {
        if (settled) return;
        settled = true;
        if (prev) try { map.removeLayer(prev); } catch(_) {}
        _revokeObj(prevUrl);
      };
      /* The other half of the same rule, and the half that was missing: a frame that never
         arrives must take ITSELF off, not the one on screen. Dropping the previous frame on
         a timer read as "never hold two frames at once", but on a slow link it is what
         blanked the layer — the old image left before the new one had come. An error is the
         same case: replacing a good frame with a broken one is a blank. Either way the
         pending frame goes and the visible one stays, so there is still never more than one
         frame on the map. Guarded on identity because a newer request may already have
         superseded this one, in which case this frame is nobody's current overlay. */
      const _dropNext = () => {
        if (settled) return;
        settled = true;
        try { map.removeLayer(next); } catch(_) {}
        _revokeObj(imgUrl);
        if (this._overlay === next) { this._overlay = prev; this._overlayUrl = prevUrl; }
      };
      next.on('load',  _dropPrev);
      next.on('error', _dropNext);
      setTimeout(_dropNext, _WMS_FRAME_MS);
      next.addTo(map);
      this._overlay    = next;
      this._overlayUrl = imgUrl;
    };
    // Surface a broken service once per failure period (not on every pan) so the user sees
    // why nothing is drawn instead of a silent blank. Latch clears on the next good frame.
    const _notifyErr = detail => {
      if (reqId !== this._reqId) return;
      /* Before the latch, deliberately, and for the same reason the WFS layer clears it: a view
         whose request FAILED must not count as covered. `_fetchedBounds` is recorded when the
         request is ISSUED, so without this the coverage guard reads a failure as a fetched
         result and never asks again — the layer stays blank until the screen leaves those
         bounds. The latch below rations the toast; it must not ration this.
         Not hypothetical: four HTTP 500 from the Agenzia WMS inside one minute, field
         diagnostic 2026-09-05. Clearing cannot loop — only moveend asks again, through the
         300 ms debounce, so nothing is re-requested while the user sits still. */
      this._fetchedBounds = null;
      if (this._errShown) return;
      this._errShown = true;
      const who = this.options.attribution ? '"' + this.options.attribution + '"' : 'layer';
      _reportLayerError(who, 'WMS ' + who + ' — ' + detail);
      // Also record it: the toast is gone in seconds, the diagnostic report is
      // what survives long enough to be looked at afterwards.
      console.warn('[giscatasto] WMS ' + who + ' failed:', detail, '|', this._wmsUrl);
    };

    if (window.cordova && cordova.plugin && cordova.plugin.http) {
      /* Sent through a wrapper so a single failure can be retried once, and ONLY for
         status -2. In this plugin -2 is exactly an SSLException (CordovaHttpBase.java);
         every other transport failure keeps the old behaviour of reporting immediately.
         The -2 seen here is an ordering problem at startup: TLS trust is handed back to
         the platform with setServerTrustMode('legacy'), which the plugin queues on the
         SAME cordova thread pool as this request, so the first GetMap of a session can
         still be validated against the plugin's default trust managers — the ones built
         from AndroidCAStore, which do not read network_security_config.xml and therefore
         miss the extra anchor the Agenzia Entrate chain needs. Once the swap lands the
         identical URL succeeds. Without the retry the overlay stays blank until something
         fires moveend/zoomend/resize, because nothing else calls _update: on a launch that
         restores the saved view the cadastral layers sit empty, error toasts and all, until
         the user happens to pan. Worst case when TLS is genuinely broken: one extra
         request, once — the second failure is reported exactly as before. */
      const _send = isRetry => {
        cordova.plugin.http.sendRequest(url, { method:'get', responseType:'arraybuffer' },
          res => {
            if (reqId !== this._reqId) return;
            const hdrs = res.headers || {};
            const ct = hdrs['content-type'] || hdrs['Content-Type'] || '';
            // A non-image body (HTML error page or OGC ServiceException) means the server
            // rejected the request — show its message rather than a blank. An empty header
            // is treated as an image (some servers omit it), so a valid tile is never blocked.
            if (ct && !/image\//i.test(ct)) { _notifyErr(_wmsErrorText(res.data)); return; }
            // The content-type check above misses two real cases: servers that omit the
            // header, and servers that label a ServiceException as image/png. Sniff the
            // magic bytes so an XML error is named in the console instead of being drawn
            // as a broken image. Diagnostic only — the response is still shown as before.
            _warnIfNotImage(res.data, url);
            try {
              // Blob instead of a base64 data URL: no main-thread string building, no 33%
              // size inflation. See the same change in the OpenLayers imageLoadFunction.
              _show(URL.createObjectURL(new Blob([res.data], { type:'image/png' })));
            } catch(e) {
              console.warn('[giscatasto] WMS image could not be displayed:', e.name, url);
            }
          },
          err => {
            /* The retry is dropped unless this request is still the current one AND the
               layer is still on the map: hasLayer is checked because onRemove does not
               invalidate _reqId, so without it a layer switched off during the delay could
               still paint a frame. */
            if (!isRetry && err && err.status === -2) {
              setTimeout(() => {
                if (reqId === this._reqId && this._map && this._map.hasLayer(this)) _send(true);
              }, 800);
              return;
            }
            _notifyErr('richiesta non riuscita' + (err && err.status ? ' (HTTP ' + err.status + ')' : ''));
          }
        );
      };
      _send(false);
    } else {
      // Browser path (no cordova-plugin-http): the image is handed straight to
      // the overlay, so a failed load has no response body to inspect. Report it
      // anyway rather than leaving a blank pane with no explanation.
      _show(url);
      if (this._overlay) this._overlay.once('error', () => _notifyErr('immagine non caricata'));
    }
  }
});

/* ===== OVERLAY SELECTION (WFS) ===== */
const _selKeys    = new Set();   // stable feature keys — survive WFS reload
const _selLayers  = new Map();   // key → current screen layer (rebuilt after each render)
const _selLabels  = new Map();   // key → label string for cadastral tooltips
const _selFeatures = new Map();  // key → GeoJSON captured at select-time (survives pan/zoom)
const _SEL_STYLE = { color:'#ffcc00', fillColor:'#ffff00', fillOpacity:0.5, weight:2.5 };
let _selMode   = false;         // click-to-select mode active
let _selTarget = null;          // typeName of WFS layer currently targeted (null = any)
let _wfsCount  = 0;             // active WFS layers on map
const _wfsRegistry = [];        // {typeName, name, layer} for each active WFS

/* Vector geometry is not re-projected while the map is being turned BY HAND.
   The overlay SVG stores screen pixels, not coordinates, so a new bearing invalidates every
   path: measured on the bench with 120 polygons over a 40-frame gesture, the renderer rewrites
   the `d` of EVERY path on EVERY frame — 4800 attribute writes, against 28 on the WMS images
   in the same gesture. That is the work that leaves the layer above the map lagging behind the
   tiles, which move on the compositor; it looks like everything flickering at once.
   Detaching the rendered features for the duration takes it to 0 during the gesture and costs
   240 node operations once (120 removals, 120 creations) instead of 4800 spread over frames.
   ⚠ Hiding the pane in CSS does NOT work, and this was measured rather than assumed: Leaflet
   does not know the pane is hidden and keeps rewriting every path — identical 4800. It saves
   the paint, not the work.

   Triggered on the RATE of rotate events, not on an angle. leaflet-rotate has no rotateend and
   fires 'rotate' unconditionally from setBearing, so one event means two very different things:
   a two-finger gesture produces roughly one per frame, track-up navigation roughly one per GPS
   fix. Those regimes are a factor of fifty apart. An angle cannot separate them — a slow bend
   in navigation crosses any sensible threshold, and that is exactly when the cadastre must stay
   on screen.

   Only the WFS features are detached. The WMS overlays stay: they are moved by the pane
   transform and cost almost nothing, and dropping them would empty the map precisely while the
   user is orienting. The GPS marker and accuracy circle stay for the same reason.
   ⚠ The rendered `_geo` is detached, never the `_WFSLayer` itself: removing the layer would run
   its onRemove, clear `_fetchedBounds` and make the restore issue a fresh request — one refetch
   per turn, which is the defect the coverage guard exists to prevent. */

/* The follow pan asks whether the screen actually changes (_FOLLOW_MIN_PX); the bearing never
   did — setBearing was called on every fix, unguarded, while the pan beside it was gated. And
   the smoother is exponential (0.55), so it approaches the true course without ever reaching it:
   a slightly different value every fix, for ever, on top of the degree or two a real GPS course
   wobbles by.
   Same question as the pan, in the same units: how far does the farthest point on screen move?
   At radius r (half the diagonal) a change of d degrees moves it r*d*PI/180 pixels. Below one
   pixel nothing can change on screen, so this is not a trade-off — it removes work that has no
   effect. It sits upstream of the rotation freeze and is still worth having: a call skipped here
   also skips the rotate event, the view save it schedules and the coverage check every WMS layer
   runs on it.
   ⚠ Compared against map.getBearing(), i.e. what is ACTUALLY on screen, never against the
   previous target. Against the previous target a slow drift of a tenth of a degree per fix would
   stay under the threshold for ever and the map would silently accumulate error; against the
   applied bearing the drift adds up and is applied as soon as it becomes visible. It is also
   immune to bearing changes coming from elsewhere — the compass reset, a two-finger gesture. */
const _BEARING_MIN_PX = 1;

function _setBearingIfVisible(b) {
  if (typeof map.getBearing !== 'function') { map.setBearing(b); return; }
  const s = map.getSize();
  const r = Math.sqrt(s.x * s.x + s.y * s.y) / 2;
  const d = Math.abs(((b - map.getBearing() + 540) % 360) - 180);
  if (r * d * Math.PI / 180 < _BEARING_MIN_PX) return;
  map.setBearing(b);
}

/* MEASURED, and it is the whole point: a bearing change never needs the geometry re-projected.
   The overlay pane sits inside the rotate pane, so the pane's own transform already turns every
   path — and the browser routes pointer events through that transform too. Probe of 31/08: with
   the `d` rewriting blocked, a polygon at bearing 45 lands on exactly the same screen pixels as
   with it active (0x0 over 20 blocked writes), a tap still reaches the layer's click handler, and
   a point outside the rotated shape still misses it.
   So the writes triggered BY THE ROTATION are skipped and nothing else is touched: the features
   stay on screen, rotating with the pane, and the per-frame DOM cost disappears. A pan or a zoom
   change the projection for real and still write as they always did — the freeze is only up
   during the synchronous work of the rotate event itself.

   Two earlier designs, both worse, kept here so they are not tried again:
   - detaching the layers for the duration of the gesture. It worked, but made the cadastre
     vanish exactly while the user was orienting — a compromise this does not need.
   - freezing only at gesture rate, then redrawing once the gesture settled. That protected
     track-up navigation from a risk that does not exist, and left it paying the full cost: one
     bearing change per GPS fix, 120 paths rewritten each time. The rate detector, the settle
     window and the deferred redraw are all gone with it.
   The user put the whole thing in one sentence before any of this was measured: "first rotate,
   THEN paste the rest on top — I get the impression you redraw EVERYTHING at every angle". */
let _rotFreeze = false;
let _rotThawTid = null;
let _rotSwallowed = 0;                  // _setPath calls the freeze skipped — see the probe below

(function _patchPathWriteDuringRotation() {
  if (!L.SVG || !L.SVG.prototype || L.SVG.prototype.__nvRotFreeze) return;
  const orig = L.SVG.prototype._setPath;
  L.SVG.prototype._setPath = function (layer, path) {
    if (_rotFreeze) { _rotSwallowed++; return; }
    return orig.call(this, layer, path);
  };
  L.SVG.prototype.__nvRotFreeze = true;
})();

/* ===== ROTATION COST PROBE — what the freeze does NOT save =====
   The freeze intercepts `_setPath`, which is the LAST step of drawing a path. Everything above it
   still runs on every bearing change: Leaflet projects each layer, walks its rings and builds the
   `d` STRING through pointsToPath — and then this hands that string to nothing. So the guard saves
   the DOM write and the string's insertion, never its computation.
   That was an argument until now; these two numbers make it a measurement.
   · the SYNCHRONOUS span of setBearing — everything a turn costs before the frame can be drawn,
     unquantised, so it resolves what a frame median (a multiple of 16.5 ms) cannot;
   · how many `_setPath` calls were swallowed inside that span — reaching `_setPath` means all the
     upstream projection and string building for that path already happened. If the count comes
     back near the path count, the upstream work is being paid in full on every turn, and the
     remedy is to gate ABOVE `_update`, not at the write.
   ⚠ Reading, not assuming: a low swallowed count would mean Leaflet is already skipping the paths
   somewhere above us, and the whole line of enquiry would be wrong. The probe can say so.
   Cost: two performance.now() and an integer add per setBearing — about 120 calls a second at
   gesture rate, tens of nanoseconds each. It cannot move what it measures. */
window._nvRotCost = { n: 0, totalMs: 0, worstMs: 0, swallowed: 0, worstSwallowed: 0 };
(function _patchSetBearingTiming() {
  if (!L.Map || !L.Map.prototype || typeof L.Map.prototype.setBearing !== 'function') return;
  if (L.Map.prototype.__nvRotTimed) return;
  const orig = L.Map.prototype.setBearing;
  L.Map.prototype.setBearing = function (theta) {
    const sw0 = _rotSwallowed, t0 = performance.now();
    const r = orig.call(this, theta);
    const ms = performance.now() - t0, sw = _rotSwallowed - sw0;
    const a = window._nvRotCost;
    a.n++;
    a.totalMs += ms;
    a.swallowed += sw;
    if (ms > a.worstMs) a.worstMs = ms;
    if (sw > a.worstSwallowed) a.worstSwallowed = sw;
    return r;
  };
  L.Map.prototype.__nvRotTimed = true;
})();

/* ===== FRAME PROBE — instrumentation only, nothing acts on it yet =====
   Times how long frames take while the map is DOING something, so that the threshold for a
   future "the app is slowing down" notice can be picked from real numbers rather than guessed.

   Not tied to rotation, and that is the point rather than a convenience. Measuring only while
   the map turns assumes the answer: it can only ever find slowness during a turn, and could
   never report that a pan on the same view is just as slow — which is the one observation that
   would clear rotation of the blame. The speed panel was already suspected the same way and
   turned out to be a victim, not a cause.

   A byte counter would be the wrong instrument regardless: performance.memory reports the JS
   heap alone, and the cost here is DOM nodes, path rewrites and tile bitmaps, none of which
   live there. The vertex editor is the precedent — 16003 nodes and 53 MB of DOM against a heap
   that never moved. (measureUserAgentSpecificMemory would see all of it, but needs cross-origin
   isolation, which a file:// Cordova page cannot have.) Frame time is the symptom the user
   actually feels, so that is what is timed.

   ⚠ Sampling is anchored to ACTIVITY, never to the clock, and a perpetual rAF was rejected for
   a reason that outranks its battery cost: on a still map frames do not arrive because there is
   nothing to draw, not because the app is slow, so an idle sampler would read its own silence as
   a 900 ms frame. Frame time only means anything while rendering work is in flight. In exchange
   the probe costs nothing at rest, and while the map moves it adds no frames — it rides the ones
   already being drawn.

   Shaped after the cache probe in geoapp.html, deliberately: a median, a best-ever baseline kept
   per device, and the ratio between the two — the ratio being the only device-independent part.
   Two things travel with every reading because a duration alone calibrates nothing: the count of
   paths in the overlay pane (the independent variable) and WHICH interaction opened the window,
   which is what makes "rotation is to blame" a falsifiable claim instead of an assumption.
   The path count is read once per window, never per frame: querySelectorAll at frame rate would
   be a cost of its own inside the measurement meant to observe it. */
const _FRAME_PROBE_QUIET_MS    = 400;   // the interaction is over once nothing has arrived for this long
/* Raised from 3 on 06/09. Frame intervals are quantised to the refresh period, so a median over
   three or four samples can only land on a multiple of it: the difference between "4x" and "6x"
   is one dropped frame out of four. The field reports of 05/09 put exactly such windows in the
   headline — 233.3 ms over 3 frames, 99.3 ms over 4 — while the informative windows of 11 to 19
   frames sat further down the log. Eight is the point where the median stops being one sample. */
const _FRAME_PROBE_MIN_SAMPLES = 8;
const _FRAME_PROBE_BASE_KEY    = 'nv_frame_base';
const _FRAME_PROBE_LOG_RATIO   = 2;     // below this a window is unremarkable; logging it would drown the log
/* One coupled cache reading per this interval, at most. Track-up navigation opens a frame window
   per GPS fix, and a probe on each would be four cache lookups a second — the measurement would
   become a load of its own. */
const _FRAME_PROBE_COUPLE_MS   = 15000;
const _FRAME_HIST_MAX          = 400;   // intervals kept for the refresh-rate estimate
/* Thresholds that turn a window into a CLASS. Deliberately coarse: they exist to tell a gesture
   apart from the noise floor of a still map, not to measure anything. 8 px is below what a finger
   does and above what a GPS follow-pan does when the rider is stopped. */
const _FRAME_MOVE_MIN_PX = 8, _FRAME_ROT_MIN_DEG = 2, _FRAME_ZOOM_MIN = 0.05;
let _frameProbeOn = false, _frameProbeSamples = [], _frameProbeLastFrame = 0;
let _frameProbeActivityAt = 0;          // own timestamp: _rotLastRotateAt belongs to the toast quiet window
let _frameProbeCauses = null;           // Set of the interactions this window saw
let _frameProbeOpenedAt = 0;            // wall clock, to tell whether a coupled reading belongs to this window
let _frameProbeView = null;             // the view as the window opened, for the measured deltas
let _frameHist = [];                    // every interval this session — the refresh-rate estimate reads this
let _coupledCache = null;               // {startedAt, ms} of the cache reading taken DURING a window
let _coupledLastAt = 0;

/* Opened by every interaction that makes the map render. Track-up navigation pans on each GPS
   fix, so windows follow one another closely while navigating — that is intended: those frames
   are exactly the ones worth measuring, and they are frames the map was drawing anyway. */
/* The causes are kept as a SET and joined, never collapsed to a single label. The first version
   wrote 'mixed' for any window that saw more than one interaction, and the field report proved
   that useless: a zoom fires 'zoom' AND 'move', so every zoom read 'mixed' too, and 'mixed' could
   no longer be told apart from a turn made while panning — which is exactly the comparison the
   whole probe exists to make. 'rotate+move' and 'move+zoom' answer it; 'mixed' hid it. */
function _frameProbeStart(cause) {
  _frameProbeActivityAt = Date.now();
  if (_frameProbeOn) { _frameProbeCauses.add(cause); return; }
  _frameProbeOn = true;
  _frameProbeLastFrame = 0;
  _frameProbeCauses = new Set([cause]);
  _frameProbeOpenedAt = Date.now();
  _frameProbeView = _frameViewNow();
  _coupleCacheProbe();
  requestAnimationFrame(_frameProbeFrame);
}

function _frameViewNow() {
  try {
    return { bearing: (typeof map.getBearing === 'function') ? map.getBearing() : 0,
             zoom: map.getZoom(), c: map.getCenter() };
  } catch (_) { return null; }
}

/* ⚠ The event NAMES cannot answer "what did this gesture do", and the 05/09 field reports are the
   proof: not one window in six sessions was labelled a plain rotation, because setBearing changes
   the view and Leaflet fires 'move' for it — so every turn reads 'move+rotate', and a turn made
   while pinching reads the same as a pinch made while turning. Whether the map actually TURNED,
   PANNED or ZOOMED is a question about the view, so it is asked of the view.
   The centre distance is projected at the CLOSING zoom, so a zoom does not also read as a pan,
   and rotating about the centre leaves it at zero — which is what makes a pure rotation, the
   sample that was missing, a category that can exist at all. */
function _frameDeltas(a, b) {
  if (!a || !b) return null;
  const dB = Math.abs(((b.bearing - a.bearing + 540) % 360) - 180);
  const dZ = Math.abs(b.zoom - a.zoom);
  let dPx = 0;
  try { dPx = map.project(a.c, b.zoom).distanceTo(map.project(b.c, b.zoom)); } catch (_) {}
  return { dB, dZ, dPx };
}

function _measuredCause(d) {
  if (!d) return 'unknown';
  const p = [];
  if (d.dPx >= _FRAME_MOVE_MIN_PX)  p.push('pan');
  if (d.dB  >= _FRAME_ROT_MIN_DEG)  p.push('rot');
  if (d.dZ  >= _FRAME_ZOOM_MIN)     p.push('zoom');
  // 'still' is a real answer: frames were drawn while the view did not change — a layer building,
  // a tile arriving. Folding it into 'pan' would hide exactly that.
  return p.length ? p.join('+') : 'still';
}

/* The refresh period, ESTIMATED FROM THE SAMPLES rather than assumed to be 16.7 ms: a frame
   interval cannot be shorter than the display's period, so the bottom of the distribution sits on
   it. The 10th percentile rather than the minimum, because a single anomalous sub-frame reading is
   exactly what poisoned the stored baseline on this device (14.6 ms recorded against a ~16.5 ms
   panel — a value no real frame can have), and a minimum has no defence against it. */
/* ⚠ Cached, and this is not premature: a copy-and-sort of 400 numbers on EVERY window would be
   the largest thing this probe does, on a path that runs about once a second under GPS follow —
   an instrument that costs more than what it measures. The estimate moves only as the
   distribution fills, so recomputing every 25 new intervals gives the same answer. */
/* ⚠ PLAUSIBILITY BOUNDS, and they are not decoration — without them this made things worse.
   The estimate rests on one assumption: that somewhere in the session the app drew a frame at full
   speed, so the bottom of the distribution sits on the display's period. When that is false the
   percentile is just the fastest SLOW frame, and using it as a floor CORRUPTS the baseline.
   Field session 06/09 11:45: eleven minutes on a near-empty map with the network stalled, never
   one full-speed frame, estimate 30.6 ms — 32 Hz, a display that does not exist — and the floor
   RAISED a correct 16.5 ms baseline to it, understating every ratio in that report by 1.85x.
   Phone panels run at 60, 90 or 120 Hz = 16.7, 11.1, 8.3 ms. Outside this range the number is not
   a refresh period, and the honest answer is NO estimate: NaN touches nothing, leaves the stored
   baseline alone, and the report says so instead of printing a fiction. */
const _VSYNC_MIN_MS = 6, _VSYNC_MAX_MS = 18;
let _vsyncVal = NaN, _vsyncAtLen = -1;
function _vsyncEstimate() {
  if (_frameHist.length < 40) return NaN;
  if (_vsyncAtLen >= 0 && _frameHist.length - _vsyncAtLen < 25) return _vsyncVal;
  const s = _frameHist.slice().sort((a, b) => a - b);
  const p10 = s[Math.floor(s.length * 0.10)];
  _vsyncVal = (p10 >= _VSYNC_MIN_MS && p10 <= _VSYNC_MAX_MS) ? p10 : NaN;
  _vsyncAtLen = _frameHist.length;
  return _vsyncVal;
}

/* Reads the cache channel DURING a frame window, so the two are sampled in the same instant.
   That pairing is the whole point: the 05/09 reports had the frame channel at 3-14x and the cache
   channel at 1.2-2.7x, but never at the same moment, so they could not be compared. If both rise
   together the machine is busy; if only the frame channel rises, the app's own main thread is.
   ⚠ Goes through _nvCacheProbe (probeMedian), which does NOT write the stored cache baseline —
   only the slow-check does. So sampling more often cannot move the baseline the ratio is read
   against. */
function _coupleCacheProbe() {
  if (typeof window._nvCacheProbe !== 'function') return;
  const now = Date.now();
  if (now - _coupledLastAt < _FRAME_PROBE_COUPLE_MS) return;
  _coupledLastAt = now;
  const rec = { startedAt: now, ms: null };
  _coupledCache = rec;
  try {
    Promise.resolve(window._nvCacheProbe())
      .then(ms => { rec.ms = (ms == null) ? null : ms; })
      .catch(() => {});
  } catch (_) {}
}

function _frameProbeFrame(now) {
  if (!_frameProbeOn) return;
  /* The first frame of a window establishes the origin and produces no sample — there is nothing
     to subtract from yet. It is NOT a discarded idle interval: the window opens on the interaction,
     so the very next frame is already part of it, and n frames yield n-1 intervals. */
  if (_frameProbeLastFrame) _frameProbeSamples.push(now - _frameProbeLastFrame);
  _frameProbeLastFrame = now;
  if (Date.now() - _frameProbeActivityAt >= _FRAME_PROBE_QUIET_MS) { _frameProbeEnd(); return; }
  requestAnimationFrame(_frameProbeFrame);
}

function _frameProbeEnd() {
  _frameProbeOn = false;
  const s = _frameProbeSamples;
  const cause = _frameProbeCauses ? Array.from(_frameProbeCauses).sort().join('+') : 'unknown';
  _frameProbeSamples = [];
  _frameProbeLastFrame = 0;
  _frameProbeCauses = null;
  /* Fed BEFORE the short-window return, deliberately: a three-frame window is not a median worth
     publishing, but its intervals are real frames and the refresh-rate estimate wants every one
     it can get — most windows on a still-ish map are short. */
  for (let i = 0; i < s.length; i++) _frameHist.push(s[i]);
  /* Trimmed in batches, not on every overflow: slicing at exactly the cap allocates a fresh
     400-element array once per window for ever. With a margin it happens once per 64 windows. */
  if (_frameHist.length > _FRAME_HIST_MAX + 64) {
    _frameHist = _frameHist.slice(-_FRAME_HIST_MAX);
    if (_vsyncAtLen > _frameHist.length) _vsyncAtLen = -1;   // the cache's length marker moved
  }
  if (s.length < _FRAME_PROBE_MIN_SAMPLES) return;
  s.sort((a, b) => a - b);
  /* A real median on both parities. s[len>>1] alone takes the upper of the two middle values on
     an even count — [16,16,100,500] would read 100 instead of 58 — which biases every even
     window towards "slower than it was" and would make a threshold fire on arithmetic. */
  const mid = s.length >> 1;
  const med = (s.length % 2) ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  /* Best ever, not a rolling average: the baseline has to describe what this device can do when
     nothing is in the way, and an average would drift upward on exactly the slow sessions the
     ratio is supposed to expose. */
  /* ⚠ A pure minimum can only ever fall, and one impossible sample poisons it for the life of the
     install: a stored baseline reached 14.6 ms on a panel whose own frames arrive ~16.5 ms
     apart, which inflated every ratio it ever reported. So the minimum is floored at the
     measured refresh period, and — this is the half that matters — a baseline already below it
     is RAISED back to it. That is the only path by which a poisoned baseline can recover. */
  let base = parseFloat(localStorage.getItem(_FRAME_PROBE_BASE_KEY));
  const vsync = _vsyncEstimate();
  let next = base;
  if (!isFinite(next) || med < next) next = med;
  if (isFinite(vsync) && (!isFinite(next) || next < vsync * 0.95)) next = vsync;
  /* ⚠ Written only on a MATERIAL change. `next !== base` on floats would persist a drift of a
     hundredth of a millisecond, and localStorage.setItem is synchronous — on this device that is
     a main-thread write once per window, about once a second under GPS follow, inside the very
     probe that exists to detect main-thread stalls. The baseline is used at one decimal place, so
     anything under 1% cannot change a printed number. */
  if (!isFinite(base) || Math.abs(next - base) / (base || 1) >= 0.01) {
    base = next;
    try { localStorage.setItem(_FRAME_PROBE_BASE_KEY, String(base)); } catch (_) {}
  } else {
    base = isFinite(base) ? base : next;
  }
  /* Counted across the WHOLE map container, not `.leaflet-overlay-pane`. The first version used
     that selector and the field report came back with "Vector paths 1" on thirteen WFS layers
     over Rome: the WFS layers are given their OWN panes (see `pane:` in the layer options), so
     the shared overlay pane was very nearly empty and the number meant nothing — while being the
     one variable a threshold was going to be calibrated against.
     Markers are counted separately because leaflet-rotate subscribes every Marker to the `rotate`
     event (`markerProto.getEvents` → `{ rotate: this.update }`). The bearing freeze above blocks
     `L.SVG._setPath`, so it stops path rewrites and nothing else — a marker still updates on
     every bearing change. If a turn costs more than a pan on the same view, these are the nodes
     that would explain it, so the count has to be in the report to be checkable at all. */
  let paths = -1, markers = -1;
  try {
    const box = (typeof map.getContainer === 'function') ? map.getContainer() : document;
    paths   = box.querySelectorAll('path').length;
    markers = box.querySelectorAll('.leaflet-marker-icon').length;
  } catch (_) {}
  const ratio = med / (base || 1);
  const d = _frameDeltas(_frameProbeView, _frameViewNow());
  const measured = _measuredCause(d);
  /* The coupled cache reading counts only if it was STARTED inside this window. One taken before
     the window opened describes a machine that may since have got busy, which is the confusion
     the pairing exists to remove. Null when the probe has not resolved yet — reported as
     "in flight", never as a zero. */
  let cacheMs = null, cacheRatio = NaN;
  if (_coupledCache && _coupledCache.startedAt >= _frameProbeOpenedAt) {
    cacheMs = _coupledCache.ms;
    if (cacheMs != null) {
      const cb = parseFloat(localStorage.getItem(window._nvCacheProbeBaseKey || 'nv_cache_probe_base'));
      if (isFinite(cb) && cb > 0) cacheRatio = cacheMs / cb;
    }
  }
  window._nvLastFrame = { ms: med, frames: s.length, paths, markers, cause, measured,
                          dB: d ? d.dB : null, dZ: d ? d.dZ : null, dPx: d ? d.dPx : null,
                          ratio, cacheMs, cacheRatio, vsync };
  /* The worst window of the session is kept beside the last one, because the report is saved
     minutes after the trouble: by then the last window is usually the menu opening, and the
     slow one the user actually wanted to report is gone.
     It no longer picks up the warm-up spike that topped the 05/09 reports (233.3 ms over three
     frames on a map holding nine paths): a window that short does not reach here any more. */
  const w = window._nvWorstFrame;
  if (!w || ratio > w.ratio) window._nvWorstFrame = window._nvLastFrame;
  /* Kept PER MEASURED CLASS and across the whole session, because the question the field asks is
     comparative — does turning cost more than panning over the same view — and one headline
     number from whichever window happened to be last cannot answer it. On 05/09 that comparison
     had to be reconstructed by hand out of the event log. */
  const by = window._nvFrameByCause || (window._nvFrameByCause = {});
  const e = by[measured] || (by[measured] = { n: 0, ms: [], worst: 0 });
  e.n++;
  e.ms.push(med);
  if (e.ms.length > 60) e.ms.shift();
  if (ratio > e.worst) e.worst = ratio;
  /* Logged only when a window stands out. Navigation opens one per GPS fix, and logging each
     would push everything else out of the report the log exists to fill. */
  if (typeof nvLog === 'function' && ratio >= _FRAME_PROBE_LOG_RATIO) {
    nvLog('frame probe', cause, '[' + measured + ']', med.toFixed(1) + 'ms',
          'baseline', base.toFixed(1) + 'ms',
          'ratio', ratio.toFixed(1) + 'x', 'frames', s.length,
          'paths', paths, 'markers', markers,
          'dbearing', d ? d.dB.toFixed(0) : '?', 'dzoom', d ? d.dZ.toFixed(2) : '?',
          'dpan', d ? Math.round(d.dPx) + 'px' : '?',
          'cache', cacheMs == null ? 'none' : (cacheMs.toFixed(1) + 'ms ' +
                   (isFinite(cacheRatio) ? cacheRatio.toFixed(1) + 'x' : '?')));
  }
}
window._nvFrameProbeBaseKey = _FRAME_PROBE_BASE_KEY;

/* Long tasks — the passive half of the measurement, and the only one that sees a block nobody
   gestured for: a large GML parse, the vertex editor building its handles. It needs no rAF and
   costs nothing when the main thread is healthy, since the browser only reports what already
   went wrong. Availability in this WebView is NOT assumed — it is recorded, and the report says
   plainly when the API is missing rather than printing a silent zero that reads like good news. */
(function _observeLongTasks() {
  window._nvLongTasks = null;
  try {
    if (typeof PerformanceObserver !== 'function') return;
    const types = PerformanceObserver.supportedEntryTypes;
    if (types && types.indexOf('longtask') === -1) return;
    const acc = { count: 0, worstMs: 0, totalMs: 0 };
    new PerformanceObserver(list => {
      list.getEntries().forEach(e => {
        acc.count++;
        acc.totalMs += e.duration;
        if (e.duration > acc.worstMs) acc.worstMs = e.duration;
      });
      window._nvLongTasks = acc;
    }).observe({ entryTypes: ['longtask'] });
    window._nvLongTasks = acc;   // supported: an empty accumulator means "none yet", not "unavailable"
  } catch (_) { window._nvLongTasks = null; }
})();

map.on('rotate', () => {
  _rotLastRotateAt = Date.now();
  _rotFreeze = true;
  /* Released on the next tick, so only the writes this rotation triggers are skipped — measured
     synchronous: one write per layer per setBearing. The timeout is also the safety net: however
     this is reached, the freeze cannot outlive the turn that set it. */
  if (_rotThawTid) clearTimeout(_rotThawTid);
  _rotThawTid = setTimeout(() => { _rotThawTid = null; _rotFreeze = false; }, 0);
  _frameProbeStart('rotate');
});

/* Every interaction that makes the map render opens a window, so a slow frame can be attributed
   to what caused it. 'move' covers dragging, panTo and the follow pan; 'zoom' fires through its
   animation. They overlap on purpose — a pinch is a zoom and a move, and the cause becomes
   'mixed', which is the honest label for it. */
map.on('move',  () => _frameProbeStart('move'));
map.on('zoom',  () => _frameProbeStart('zoom'));

function _wfsLayerAdded(wfsLayer) {
  _wfsCount++;
  _wfsRegistry.push({ typeName: wfsLayer.options.typeName, name: wfsLayer.options.attribution, minZoom: wfsLayer.options.minZoom || 14, layer: wfsLayer });
  _selUpdateBadge();
}
function _wfsLayerRemoved(wfsLayer) {
  /* FIRST, before anything that can throw. Its feature count goes with the layer: without this the
     map only ever grows in the eyes of the notice — the `layers < 2` gate stays true for the rest
     of the session once two WFS layers have loaded even once, and the figures the text quotes count
     layers the user has already switched off, so the dialog names a load that is no longer there.
     Ordered ahead of the z-order and selection work below because a throw in any of those would
     leak the count and reinstate exactly the defect this closes. */
  _wfsFeatureTotals.delete(wfsLayer);
  _wfsCount = Math.max(0, _wfsCount - 1);
  const idx = _wfsRegistry.findIndex(e => e.layer === wfsLayer);
  if (idx !== -1) _wfsRegistry.splice(idx, 1);
  // No fixed z to restore any more: the legend order is re-applied for whatever is left.
  if (map && typeof _applyOverlayZOrder === 'function') _applyOverlayZOrder();
  if (_selTarget === wfsLayer.options.typeName) _selModeOff();
  if (!_wfsCount && _selMode) _selModeOff();
  _selUpdateBadge();
}

/* The legend order is the only persisted truth about stacking, so this no longer owns any
   base z-index: it re-applies the legend and then, ONLY while selection mode is on, lays a
   temporary override on top so the badge target catches clicks whatever its position.
   The override lives in the DOM only — it is never written to a store — and leaving
   selection mode restores the user's order exactly. */
const _SEL_Z = 448;   // above the legend band (max 445), below the drawings (draw-poly 450)

function _updateWfsPaneZOrder() {
  if (!map) return;
  if (typeof _applyOverlayZOrder === 'function') _applyOverlayZOrder();
  if (!_selMode) return;

  const targetEntry = _wfsRegistry.find(e => e.typeName === _selTarget);
  if (!targetEntry) return;
  const targetPane = targetEntry.layer.options.pane;

  if (targetPane) {
    const paneEl = map.getPane(targetPane);
    if (paneEl) paneEl.style.zIndex = _SEL_Z;
  } else {
    // Target sits in the shared overlayPane (400) and cannot be raised on its own, so the
    // other WFS panes are pushed under it for the duration instead.
    _wfsRegistry.forEach(e => {
      const paneName = e.layer.options.pane;
      if (!paneName || e.typeName === _selTarget) return;
      const paneEl = map.getPane(paneName);
      if (paneEl) paneEl.style.zIndex = 395;
    });
  }
  if (typeof _reorderMapPanes === 'function') _reorderMapPanes(map);
}

function _selModeOff() {
  _selMode = false; _selTarget = null;
  _hideTargetPicker();
  _updateWfsPaneZOrder();
  const btn = document.getElementById('sel-mode-btn');
  if (btn) { btn.classList.remove('active'); btn.textContent = '\u25CE Seleziona'; }
  const badge = document.getElementById('sel-badge');
  if (badge) badge.classList.remove('mode-active');
}

function _selModeToggle() {
  if (_selMode) { _selModeOff(); return; }
  if (_wfsRegistry.length === 1) {
    // Single WFS — activate immediately, no picker needed
    _selMode = true; _selTarget = _wfsRegistry[0].typeName;
    _updateWfsPaneZOrder();
    const btn = document.getElementById('sel-mode-btn');
    if (btn) { btn.classList.add('active'); btn.textContent = '\u25CE ' + _wfsRegistry[0].name; }
    const badge = document.getElementById('sel-badge');
    if (badge) badge.classList.add('mode-active');
  } else {
    _showTargetPicker();
  }
}

function _showTargetPicker() {
  let picker = document.getElementById('wfs-target-picker');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'wfs-target-picker';
    (document.getElementById('map') || document.body).appendChild(picker);
  }
  picker.innerHTML =
    '<span class="wtp-label">Seleziona su:</span>' +
    _wfsRegistry.map(e =>
      `<button class="wtp-btn" data-type="${e.typeName}">${e.name}</button>`
    ).join('') +
    '<button class="wtp-cancel">Annulla</button>';
  picker.classList.remove('hidden');
  picker.querySelectorAll('.wtp-btn').forEach(b => {
    b.addEventListener('click', e => {
      e.stopPropagation(); e.preventDefault();
      const label = b.textContent;
      _selMode = true; _selTarget = b.dataset.type;
      _hideTargetPicker();
      _updateWfsPaneZOrder();
      const modeBtn = document.getElementById('sel-mode-btn');
      if (modeBtn) { modeBtn.classList.add('active'); modeBtn.textContent = '\u25CE ' + label; }
      const _badge = document.getElementById('sel-badge');
      if (_badge) _badge.classList.add('mode-active');
      toastMsg('Selezione attiva: ' + label, 'success');
      _selUpdateBadge();
    });
  });
  picker.querySelector('.wtp-cancel').addEventListener('click', e => {
    e.stopPropagation(); e.preventDefault();
    _hideTargetPicker();
  });
}

function _hideTargetPicker() {
  const p = document.getElementById('wfs-target-picker');
  if (p) p.classList.add('hidden');
}

function _selKey(f) {
  return f.id || JSON.stringify(f.geometry && f.geometry.coordinates);
}

function _selToggle(key, layer, baseStyle, label) {
  if (_selKeys.has(key)) {
    _selKeys.delete(key);
    _selLayers.delete(key);
    _selLabels.delete(key);
    _selFeatures.delete(key);
    try { layer.setStyle(baseStyle); } catch(_) {}
    try { layer.unbindTooltip(); } catch(_) {}
  } else {
    _selKeys.add(key);
    _selLayers.set(key, layer);
    try { const gj = layer.toGeoJSON ? layer.toGeoJSON() : null; if (gj) _selFeatures.set(key, gj); } catch(_) {}
    try { layer.setStyle(_SEL_STYLE); } catch(_) {}
    if (label) {
      _selLabels.set(key, label);
      try {
        const _center = layer.getBounds ? layer.getBounds().getCenter() : null;
        layer.bindTooltip(label, { permanent:true, className:'sel-label', direction:'center', sticky:false, offset:[0,0] });
        if (_center) layer.openTooltip(_center);
      } catch(_) {}
    }
  }
  _selUpdateBadge();
}

function _selExit() {
  /* Reset from what is ON THE MAP, not only from `_selLayers`. That map holds one screen layer
     per key and is rewritten on every WFS refresh, so an entry can point at a layer that has
     since been discarded — and then the highlight the user is looking at belongs to a different
     object and survives the clear. Walking the live `_geo` of each WFS layer asks the question
     the user is actually asking: is anything still highlighted on screen? It runs only on Clear,
     so a pass over the features costs nothing that matters. */
  _wfsRegistry.forEach(e => {
    const geo = e.layer && e.layer._geo;
    if (!geo) return;
    try {
      geo.eachLayer(l => {
        if (!l.feature || !_selKeys.has(_selKey(l.feature))) return;
        try { l.setStyle(l._selBase || (e.layer.options && e.layer.options.style)); } catch(_) {}
        try { l.unbindTooltip(); } catch(_) {}
      });
    } catch(_) {}
  });
  /* Still walked as well: a selection can be held by a layer whose WFS layer has left the
     registry, and that one is reachable only through `_selLayers`. */
  _selLayers.forEach((l, k) => {
    try { l.setStyle(l._selBase); } catch(_) {}
    try { l.unbindTooltip(); } catch(_) {}
  });
  _selKeys.clear();
  _selLayers.clear();
  _selLabels.clear();
  _selFeatures.clear();
  _selUpdateBadge();
}

function _selUpdateBadge() {
  const badge = document.getElementById('sel-badge');
  if (!badge) return;
  const zoom = map ? map.getZoom() : 0;
  const hasWfs = _wfsRegistry.some(e => zoom >= e.minZoom);
  const hasSel = _selKeys.size > 0;
  if (hasWfs || hasSel) {
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
    return;
  }
  const countEl  = document.getElementById('sel-badge-count');
  const exportEl = document.getElementById('sel-badge-export');
  const closeEl  = document.getElementById('sel-badge-close');
  if (countEl)  { countEl.textContent = _selKeys.size + ' selected'; countEl.style.display  = hasSel ? '' : 'none'; }
  if (exportEl) { exportEl.style.display = hasSel ? '' : 'none'; exportEl.classList.toggle('lit', hasSel); }
  if (closeEl)  closeEl.style.display  = hasSel ? '' : 'none';
}

function _selExportKML() {
  if (!_selKeys.size) { toastMsg('Non hai selezionato niente', 'warn'); return; }
  // Clone the captured features so styling the export never mutates the stored selection.
  const features = [];
  _selFeatures.forEach(f => { if (f) features.push({ type:'Feature', geometry: f.geometry, properties: { ...(f.properties || {}) } }); });
  if (!features.length) { toastMsg('Impossibile esportare la selezione', 'error'); return; }
  // Colour the exported parcels with the target WFS layer's colour so Google Earth shows
  // them styled (with transparency) instead of default white/opaque.
  const _tgt = _wfsRegistry.find(e => e.typeName === _selTarget) || _wfsRegistry[0];
  const _col = (_tgt && _tgt.layer && _tgt.layer.options &&
    (_tgt.layer.options.color || (_tgt.layer.options.style && _tgt.layer.options.style.color))) || '#ff5533';
  if (typeof _styleFeatureForKml === 'function') features.forEach(f => _styleFeatureForKml(f, _col, 1));
  // Area and perimeter of every exported parcel, alongside the cadastral attributes.
  features.forEach(f => stampGeomInfo(f));
  showPromptModal('Nome del file (senza estensione):', 'selection', fname => {
    const base = ((fname || 'selection').trim() || 'selection').replace(/\.kml$/i, '');
    downloadFile(tokml({ type:'FeatureCollection', features }, TOKML_OPTS),
      base + '.kml', 'application/vnd.google-earth.kml+xml');
  }, 'Il file .kml viene salvato nella cartella Download del dispositivo.');
}

/* ===== ONBOARDING ===== */
(function _initOnboarding() {
  const ob     = document.getElementById('onboarding');
  const track  = document.getElementById('ob-track');
  const dots   = document.querySelectorAll('.ob-dot');
  const nextBtn = document.getElementById('ob-next');
  const skipBtn = document.getElementById('ob-skip');
  const guideBtn = document.getElementById('ob-guide-btn');
  if (!ob) return;
  /* Guarded: this runs inside an IIFE, so a throw here would abort the rest of map.js —
     _createLayer and _WFSLayer included. Storage being unreadable must cost the onboarding
     flag, nothing else. */
  let _obDone = false;
  try { _obDone = !!localStorage.getItem('giscatasto_onboarded'); } catch (_) {}
  if (_obDone) return;

  ob.classList.remove('hidden');
  let cur = 0;
  const total = dots.length;

  function _goTo(i) {
    cur = Math.max(0, Math.min(total - 1, i));
    track.style.transform = 'translateX(-' + (cur * 100) + '%)';
    dots.forEach((d, idx) => d.classList.toggle('active', idx === cur));
    nextBtn.textContent = cur === total - 1 ? 'Fatto ✓' : 'Avanti ›';
  }

  /* Hide first, remember second: this overlay is the only thing between the user and the
     app, so a storage write that throws must not be able to trap them on it. Worst case
     the onboarding shows once more on the next launch. */
  function _close() {
    ob.classList.add('hidden');
    try { localStorage.setItem('giscatasto_onboarded', '1'); } catch (_) {}
  }

  nextBtn.addEventListener('click', () => { cur < total - 1 ? _goTo(cur + 1) : _close(); });
  skipBtn.addEventListener('click', _close);
  if (guideBtn) guideBtn.addEventListener('click', () => {
    _close();
    setTimeout(() => {
      const sidebarToggle = document.getElementById('sidebar-toggle');
      const navPanel = document.getElementById('nav-panel');
      if (navPanel && navPanel.classList.contains('hidden') && sidebarToggle) sidebarToggle.click();
      const guideTab = document.querySelector('[data-panel="guide"]');
      if (guideTab) guideTab.click();
    }, 200);
  });
})();

document.addEventListener('DOMContentLoaded', () => {
  const exBtn  = document.getElementById('sel-badge-export');
  const clBtn  = document.getElementById('sel-badge-close');
  const modeBtn = document.getElementById('sel-mode-btn');
  if (exBtn)   exBtn.addEventListener('click', _selExportKML);
  if (clBtn)   clBtn.addEventListener('click', _selExit);
  if (modeBtn) modeBtn.addEventListener('click', _selModeToggle);
  if (map) map.on('zoomend', _selUpdateBadge);
});

/* Sort panes inside rotatePane by z-index so DOM order matches visual z-order.
   leaflet-rotate keeps popup/tooltip in norotatePane (a separate sibling above
   rotatePane), so those never need to be touched here. */
function _reorderMapPanes(map) {
  try {
    const rotatePane = map.getPane('rotatePane');
    if (!rotatePane) return;
    const panes = Array.from(rotatePane.children).filter(el => el.classList.contains('leaflet-pane'));
    panes.sort((a, b) => (parseInt(a.style.zIndex) || 0) - (parseInt(b.style.zIndex) || 0));
    panes.forEach(p => rotatePane.appendChild(p));
  } catch(_) {}
}

/* Decode an XML byte buffer respecting the encoding declared in its prolog.
   Default fetch/text decode is UTF-8: MapServer PCN serves ISO-8859-1 with no
   Content-Type charset, so accented chars become U+FFFD and DOMParser fails.
   Fallback to UTF-8 keeps behavior identical for catasto/deegree/GeoServer. */
function _decodeXmlBuffer(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let start = 0;
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) start = 3;
  let head = '';
  for (let i = start; i < Math.min(start + 200, bytes.length); i++) head += String.fromCharCode(bytes[i]);
  const m = head.match(/encoding\s*=\s*["']([^"']+)["']/i);
  const enc = (m ? m[1] : 'utf-8').toLowerCase();
  try { return new TextDecoder(enc, { fatal:false }).decode(bytes); }
  catch(_) { try { return new TextDecoder('utf-8', { fatal:false }).decode(bytes); } catch(_2) { return ''; } }
}

/* Split an OGC service URL into base + pre-existing non-OGC query params
   (e.g. MapServer's mandatory ?map=/path/to/file.map). The reserved list
   covers all params the OGC requests build below, so they can't be duplicated. */
function _splitOgcUrl(url) {
  const i = url.indexOf('?');
  if (i < 0) return { base: url, pre: '' };
  const reserved = /^(service|version|request|typenames?|bbox|srsname|filter|maxfeatures|count|outputformat|crs|srs|layers|styles|format|width|height|transparent)$/i;
  const pre = url.slice(i + 1).split('&')
    .filter(p => p && !reserved.test(p.split('=')[0]))
    .join('&');
  return { base: url.slice(0, i), pre };
}

/* WFS vector feature layer: fetches GeoJSON features per viewport from a
   Web Feature Service.  Only active at zoom >= minZoom (default 15) to avoid
   loading thousands of features at small scales.  Uses EPSG:4326 BBOX.
   Renders as L.geoJSON with styled polygons/points; features are clickable. */
/* How much more than the screen a WFS request asks for. Leaflet's pad() extends EACH side by
   this fraction of the span, so 0.1 is a 20 % larger box overall.
   Chosen from measurement against the live Agenzia Entrate service, not from feel:
   - it absorbs ~80 px of gesture drift on this screen, against the 18x12 px actually observed
     at the end of a two-finger turn;
   - it costs x1.46-1.55 in payload (CP:CadastralParcel at z18: 56.6 -> 87.6 KB;
     CP:CadastralZoning at z14: 810 KB -> 1.18 MB), paid far less often thanks to _covered();
   - it stays clear of the 1000-feature ceiling the request already asks for: numberMatched
     equalled numberReturned at every size probed, worst case 203 parcels at z18 with a box
     twice this one. The ceiling was the reason to be careful here — a WFS box is features, not
     pixels like a WMS one — so it was measured rather than assumed. */
const _NV_WFS_PAD = 0.1;

/* Zoom below which the Agenzia Entrate cadastre publishes no parcels at all. Read off the
   MaxScaleDenominator of 5000 it declares for CP:CadastralParcel, and confirmed twice against
   the live service. Used ONLY to decide whether an empty answer is worth reporting — never to
   decide what is drawn. See the empty-response branch in _render for why it lives here as
   service knowledge rather than as a per-layer setting. */
const _AE_PARCEL_MIN_Z = 17;

/* ===== SERIAL WFS PARSE QUEUE =====
   Thirteen layers used to parse and build all at once, and their parses landed on the same main
   thread within moments of each other: measured on the bench a single 2000-feature reply is
   ~1700 ms, so the pile-up is the multi-second wall the field session ran into. Parsing one at a
   time turns the same total into short blocks the app can breathe between — and combined with the
   chunked build, no single stretch is long enough to read as a freeze.

   ⚠ It is the PARSE that is serialised, never the request. The first version queued _update()
   itself and was wrong in a way worth recording: the network is not what blocks — it runs off the
   main thread — so putting requests in a queue added thirteen server round trips end to end where
   there had been one wait in parallel. On a field connection that trades a freeze for a much
   longer wait, which for the user is not obviously the better deal. So every layer fires its
   request immediately, exactly as before, and only the replies line up to be read.

   Order is the legend's, bottom-up: the layer drawn underneath is parsed first, the way a GIS
   composes a map. It is read from the pane's applied z-index rather than a stored field, because
   that is the value _applyOverlayZOrder has actually put on screen — a copy of the ordering could
   disagree with it, the live value cannot.

   ⚠ The queue must never wedge: a job that neither finishes nor fails would strand every reply
   behind it, which is worse than the pile-up this replaces. Completion is taken from whichever
   comes first — the wfsupdate a finished build fires, an early return, an error, or a watchdog.
   The watchdog is not a fallback for a case nobody thought of; it is what makes it unnecessary
   for that list to be complete. */
const _WFS_QUEUE_WATCHDOG_MS = 20000;
const _wfsQueue = [];           // { layer, run }
let _wfsQueueBusy = null;

function _wfsPaneZ(layer) {
  try {
    const el = layer._map && layer.options.pane && layer._map.getPane(layer.options.pane);
    const z = el && parseInt(el.style.zIndex, 10);
    return isFinite(z) ? z : 400;
  } catch (_) { return 400; }
}

/* Called with a reply already in hand: `run` performs the parse and the build for it. */
function _wfsEnqueueParse(layer, run) {
  /* A newer reply for the same layer supersedes an older one still waiting: parsing both would
     spend main thread building features that the second job is about to replace. */
  for (let i = _wfsQueue.length - 1; i >= 0; i--) {
    if (_wfsQueue[i].layer === layer) _wfsQueue.splice(i, 1);
  }
  _wfsQueue.push({ layer, run });
  _wfsQueueUpdate();
  _wfsPump();
}

function _wfsPump() {
  if (_wfsQueueBusy || !_wfsQueue.length) return;
  /* Sorted at pump time, not at insert: the legend can be reordered while replies wait, and the
     order that matters is the one in force when a job's turn actually comes. */
  _wfsQueue.sort((a, b) => _wfsPaneZ(a.layer) - _wfsPaneZ(b.layer));
  const job = _wfsQueue.shift();
  // Switched off, or removed from the map, while its reply waited its turn.
  if (!job || !job.layer || !job.layer._map) { _wfsQueueUpdate(); return void setTimeout(_wfsPump, 0); }
  const layer = job.layer;
  _wfsQueueBusy = layer;
  _wfsQueueBusySince = Date.now();
  _wfsCycleBegin();
  _wfsQueueUpdate();

  let settled = false;
  /* The count comes from the EVENT, not from a shared global. The first version parked it in
     window._nvWfsLastCount and read it back here, which is a race between layers by construction:
     the field report totalled "32 features" while 447 paths were on screen, because whichever
     layer finished last had overwritten the value for all of them. */
  const finish = (e, byWatchdog) => {
    if (settled) return;
    settled = true;
    clearTimeout(wd);
    try { layer.off('wfsupdate', finish); } catch (_) {}
    layer._queueDone = null;
    if (e && typeof e.count === 'number') _wfsFeatureTotals.set(layer, e.count);
    /* Split, not summed: a span the watchdog had to end is time we cannot describe, and folding it
       into reading made the notice blame the parse for a queue that was simply stuck. */
    if (_wfsQueueBusySince) {
      const _held = Math.max(0, Date.now() - _wfsQueueBusySince);
      if (byWatchdog) _wfsStalledMs += _held; else _wfsReadMs += _held;
    }
    _wfsQueueBusySince = 0;
    _wfsQueueBusy = null;
    _wfsQueueUpdate();
    _wfsCycleMaybeEnd();
    // Yield before the next one: back-to-back parses would rebuild the wall this exists to avoid.
    setTimeout(_wfsPump, 0);
  };
  /* ⚠ The watchdog used to close a job in silence, and that silence cost a diagnosis: a cycle
     reporting 40.9 s of reading for 265 features had two readings — a genuinely long chunked build,
     or two jobs abandoned at 20 s each, which comes to almost exactly the same number — and the
     report could not tell them apart. A job closed here is not a normal ending: the build it gave
     up on keeps running on its own setTimeout chain, so it says so by name. */
  const wd = setTimeout(() => {
    if (typeof nvLog === 'function') {
      nvLog('queue watchdog', layer.options.attribution || layer.options.typeName || '?',
            'closed after ' + (_WFS_QUEUE_WATCHDOG_MS / 1000).toFixed(0) + 's');
    }
    finish(undefined, true);
  }, _WFS_QUEUE_WATCHDOG_MS);
  layer.on('wfsupdate', finish);
  layer._queueDone = finish;      // read by the render's early returns and by the error paths
  try { job.run(); } catch (_) { finish(); }
}

/* What the legend shows while the queue drains. Without it a user watching layers appear one by
   one has no way to tell "still loading" from "this layer returned nothing" — and a map that
   looks incomplete but finished is a worse failure than a slow one. */
function _wfsQueueUpdate() {
  window._nvWfsQueue = {
    pending: _wfsQueue.length,
    current: _wfsQueueBusy ? (_wfsQueueBusy.options.attribution || '') : null,
    // The layer objects themselves, so the legend can mark its own rows without matching on names.
    waiting: _wfsQueue.map(j => j.layer),
    busy: _wfsQueueBusy
  };
  try { map.fire('wfsqueue', window._nvWfsQueue); } catch (_) {}
}

/* ===== "YOU ARE ASKING FOR TOO MUCH" NOTICE =====
   The advice this gives is the opposite of the obvious one, which is why it has to be given at
   all. Measurement moved the cost off the drawing path entirely: a pure rotation reads 2.0x the
   device baseline against a pure pan's 3.0x, so turning is CHEAPER than panning. What costs is
   parsing WFS replies — ~1700 ms for a 2000-feature answer on a desktop-class CPU — and it is
   paid again on every move that leaves the fetched box. Told to "switch off overlays", a user
   switches off basemaps, which are free, and keeps the thirteen cadastral layers that are the
   whole problem. So the text names WFS layers specifically and says the background maps are fine.

   ⚠ The text nevertheless offers to lock north, which reads like a contradiction of the paragraph
   above and is not one: the 2.0x/3.0x figures are FRAME TIME, and rotation is not named here for
   being slow to draw. It is named for memory. The SVG holds pixels, not coordinates, so every
   degree rewrites the `d` of every path — with thousands of vector features that is the shape of
   the 2.1 GB session reproduced on 2026-08-31 (many WFS over Rome, plus rotation). Frame time and
   footprint are two different costs and only the second one is at stake in this dialog.
   The line is therefore conditional on the map being ACTUALLY turned, not on free rotation being
   unlocked: someone sitting at north pays nothing, whatever the compass allows. And it is only
   ever read outside navigation — see the hold in _wfsNotice — which matters, because navigation
   turns the map track-up whatever the rotation lock says. There, north is not the user's to give
   back, and the advice would be one they cannot act on.

   ⚠ The trigger is the MEASURED duration of a full queue cycle, not a feature count. A count
   threshold would be a number invented on this machine and shipped to every other one; seconds
   are what the user experiences, and the same figure means the same thing on any device.
   It is deliberately NOT silenceable — the condition is not a preference to be dismissed, it is
   a state that will keep costing until something is switched off. But it carries a cooldown:
   without one it would fire after every gesture, and an unsilenceable dialog that reappears every
   few seconds is worse than the slowness it describes. */
/* This is the one number here that is NOT measured, and it is worth saying so: there is no field
   sample of a slow cycle to calibrate against, because in the jammed session no cycle ever closed.
   What IS measured is the healthy case — a refresh of 12 layers and 376 features closes in 0.4 s.
   So the bar sits at thirty times a normal refresh. It was 5 s and fired on the opening load, which
   is now excluded outright; between the two changes a false alarm needs a refresh thirty times
   slower than any yet observed. */
const _WFS_SLOW_CYCLE_MS = 12000;
/* The opening load gets its own, far higher bar rather than an exemption. Exempting it outright
   was the first attempt and it had a hole: the flag that marks the opening load as over is only set
   when that cycle CLOSES, and in the 16:26 field session no cycle ever closed — so a session that
   jams from the very first load would have gone through it in silence, which is the original bug
   back again in the worst case. With a bar instead, a normal opening load stays quiet and a jammed
   one still speaks up. Not measured either: no clean sample of a healthy opening load exists yet,
   because the one in the field ran with the dialog blocking the thread for 233 s of it. */
const _WFS_FIRST_CYCLE_MS = 45000;
const _WFS_NOTICE_COOLDOWN_MS = 120000;
let _wfsCycleStart = 0, _wfsLastNotice = 0, _wfsFeatureTotals = new Map();
let _wfsInFlight = 0;               // requests sent and not yet answered
let _wfsOverdueTimer = null;        // fires the notice while a cycle is STILL open
let _wfsFirstCycleDone = false;     // the opening load is expected to be long; it never warns
let _wfsNoticeHeld = false;         // this cycle was already reported as held; do not log it again
/* Replies that have LANDED in this cycle, whatever their content. Not derivable from _wfsInFlight:
   twelve layers answered and one still outstanding leaves the same "in flight > 0, nothing to
   parse" state as twelve seconds of total silence, and only the second of those is a saturated
   connection. The notice says which one it is, so it has to be able to tell them apart. */
let _wfsArrivedThisCycle = 0;
/* How long this cycle spent turning replies into map, against the wall time the user waited.
   Counting replies was the first attempt and the field killed it on its first firing: 2026-09-02,
   45 s into an opening load, FOUR of six layers had answered and two had not, so a majority test
   read "most replies are in, therefore the reading is the problem" — while the four answers
   together carried THREE features and the parse had cost under a millisecond. How many replies
   came back says nothing about where the time went; only the clock does.
   ⚠ This is queue OCCUPANCY, not main-thread time, and the difference is not pedantry: the build
   is chunked with a setTimeout(0) between chunks, so the span from job start to `wfsupdate`
   includes those yields and the paint that happens in them. A field report on the same day made
   the gap visible by arithmetic — 40.9 s claimed inside a session whose long tasks totalled
   22.4 s of blocked thread. It is still the right quantity to weigh against waiting for the
   network, because the yields and the paint are the app's own work; it is simply not "CPU", and
   nothing here or in the report may call it that. */
let _wfsReadMs = 0;           // accumulated across the cycle, jobs that have finished
let _wfsQueueBusySince = 0;   // start stamp of the job running right now, 0 when idle
/* Time held by jobs the WATCHDOG had to close, kept apart from reading rather than folded into it.
   When the watchdog fires we do not know what that span was — a genuinely long build or a job that
   said nothing — so calling it "reading" asserts something unmeasured. It also has to suppress the
   network verdict: a wedged queue is neither a slow pipe nor a busy one, and 2026-09-02 12:10
   showed the notice reporting 86% reading for a span in which nothing was being read. */
let _wfsStalledMs = 0;

/* ⚠ The cycle is the wait the USER sits through: first request out, last layer drawn. The first
   version started it when a PARSE began and ended it when the parse queue emptied, and the field
   report showed what that measures — "0.0 s (7 layers, 32 features)". With the requests running in
   parallel their replies arrive spread out, so the parse queue drains between them and the "cycle"
   was timing one parse in isolation, never the wait. It could not have crossed a 5 s threshold at
   all, which is why the notice never appeared however long the map took to fill. */
/* ⚠⚠ And the second field report showed the OPPOSITE failure. Ending the cycle only when nothing
   is in flight and nothing is queued is correct as a measurement and useless as a trigger: with
   thirteen layers and a user who keeps panning and turning, every gesture that leaves the fetched
   box fires thirteen fresh requests, so the quiet moment the cycle waits for never comes. The
   report logged EIGHT cycles when the bug was "ends too early" and ZERO across three and a half
   minutes of a jammed map — the notice cannot fire on an event that never happens.
   So the notice no longer waits for the cycle to close. A watchdog armed when the cycle opens
   fires it while the jam is still going, which is also when it is worth reading. The cycle's own
   end still reports the measurement, and still fires the notice for a slow cycle that DID close
   inside the window. */
function _wfsCycleBegin() {
  if (_wfsCycleStart) return;
  _wfsCycleStart = Date.now();
  _wfsNoticeHeld = false;                    // a new cycle may report its own hold once
  _wfsArrivedThisCycle = 0;
  /* Safe to zero here and only here: this runs when no cycle is open, which is also the one state
     in which nothing can be mid-parse — the cycle does not close while the queue is busy. */
  _wfsReadMs = 0;
  _wfsStalledMs = 0;
  _wfsQueueBusySince = 0;
  window._nvWfsCycleOpen = _wfsCycleStart;   // read by the diagnostic report
  clearTimeout(_wfsOverdueTimer);
  _wfsOverdueTimer = null;
  /* ⚠ The FIRST cycle of a session is the opening load: every layer is fetched for the first time,
     and taking several seconds over it is normal rather than a jam. At 5 s it fired exactly there in
     the field — before the user had touched the map at all, "no map interaction yet this session" —
     which is the one moment when "switch some overlays off" is both useless and wrong advice. A
     refresh, by contrast, measured 0.4 s. */
  _wfsOverdueTimer = setTimeout(() => {
    if (!_wfsCycleStart) return;                       // closed in the meantime; nothing to say
    _wfsNotice(Date.now() - _wfsCycleStart, true);
  }, _wfsFirstCycleDone ? _WFS_SLOW_CYCLE_MS : _WFS_FIRST_CYCLE_MS);
}

/* Is the map turned right now? Asked instead of "has the user unlocked free rotation", which is
   the state the compass keeps to itself: the cost is paid per degree redrawn, so a map sitting at
   north pays nothing however the compass is set. Bearing is enough to tell the two apart because
   the compass forces it back to 0 whenever rotation is locked and navigation is off, and this is
   only ever read outside navigation. Guarded: without leaflet-rotate there is no getBearing.
   Any non-zero bearing counts, with no tolerance band: a fraction of a degree is still a bearing
   the paths were rewritten for, and it is the same plain truth test the rest of this file uses
   (map.js _paddedBounds, _screenPolygon, _rotatedSnapshot all read `!map.getBearing()`). */
function _mapIsTurned() {
  try {
    return typeof map.getBearing === 'function' && !!map.getBearing();
  } catch (_) { return false; }
}

/* The states in which a dialog must not take the screen. Navigation is the user's own doing;
   flight is detected, not chosen (_flightState, set from a run of fixes above the MSL threshold),
   and in both the advice is one the reader cannot act on where they are. Read through a guard
   each: navigation.js may not have loaded, and _flightState is plain module state.
   ⚠ Offline belongs here rather than as an early return, so it inherits what this branch already
   does right: logged once, watchdog re-armed, cooldown not spent. "You are asking for too much" is
   a question about load, and with no network there is no load to be asking too much of — the wait
   is not a threshold matter. Unreachability is reported on its own channel: _reportLayerError is
   built with no `kind` precisely so every failure episode speaks, so nothing is hidden by holding
   here. Compared against `false` and not negated: on older WebViews the property can be undefined,
   and an unknown state must keep today's behaviour rather than fall silent. */
function _wfsNoticeMustHold() {
  if (typeof navIsActive === 'function') { try { if (navIsActive()) return 'navigation'; } catch (_) {} }
  try { if (_flightState) return 'flight'; } catch (_) {}
  try { if (navigator.onLine === false) return 'offline'; } catch (_) {}
  return '';
}

/* One notice, two callers: a cycle that closed slowly, and one still open past the threshold.
   `open` only changes the tense — the advice is identical, and so is the cooldown that stops an
   unsilenceable dialog from reappearing every few seconds. */
function _wfsNotice(took, open) {
  let feats = 0, layers = 0;
  _wfsFeatureTotals.forEach(n => { feats += n; layers++; });
  if (layers < 2) return;
  if (Date.now() - _wfsLastNotice < _WFS_NOTICE_COOLDOWN_MS) return;
  /* ⚠ Never over a map someone is navigating by, or flying with. The dialog is unsilenceable by
     design and wants a tap, which is the one thing a rider or a driver cannot give it — and its
     advice is not actionable there either: nobody re-picks overlays at 50 km/h, and the map is
     track-up whatever the rotation lock says. So while either state holds, the condition is
     recorded and the dialog is withheld, not cancelled: the watchdog is re-armed so it is
     delivered at the first stop rather than lost with the cycle it belonged to.
     ⚠ The cooldown stamp is deliberately NOT taken here. Stamping it would spend the 120 s on a
     dialog nobody saw, and the stop that follows would be silent for two minutes — exactly the
     moment the notice is worth reading.
     The report line is written once per cycle: re-arming every 12 s for a whole ride would fill
     the section of the report used to diagnose the very slowness this reports. */
  const _hold = _wfsNoticeMustHold();
  if (_hold) {
    if (!_wfsNoticeHeld && typeof nvLog === 'function') {
      nvLog('notice held', _hold + ' active', (took / 1000).toFixed(1) + 's',
            'layers', layers, 'features', feats);
    }
    _wfsNoticeHeld = true;
    if (open && _wfsCycleStart) {
      clearTimeout(_wfsOverdueTimer);
      _wfsOverdueTimer = setTimeout(() => {
        if (!_wfsCycleStart) return;
        _wfsNotice(Date.now() - _wfsCycleStart, true);
      }, _WFS_SLOW_CYCLE_MS);
    }
    return;
  }
  /* ===== NOTHING WORTH SAYING =====
     ⚠ A wait that is about to end on its own must not raise an unsilenceable dialog. Measured in
     Rome on 2026-09-02 13:24: the notice fired at 12.0 s with SEVENTEEN of eighteen replies
     already in and reading at 19% of the wait — and the cycle closed by itself six seconds later.
     What it put on screen was "6 overlays are active, with about 58 features loaded, switch some
     off": advice that is useless (the reading was not the cost), unactionable (one server was
     thinking, not the app) and wrong about the map it described.
     The condition this notice exists for is one that KEEPS costing until something is switched
     off. A straggler is not that condition: it resolves whether or not the user does anything.
     ⚠ Withheld, not cancelled — the same treatment navigation gets, for the same reason. The
     watchdog is re-armed, so if the picture worsens (more requests going out, the reading share
     climbing, replies piling up unread) the notice still arrives within a window. And the cooldown
     is not stamped, so a genuine jam a moment later is not muted by a dialog nobody saw.
     ⚠ A THIRD, not a fifth, and the number was chosen from the measured distribution rather than
     argued. Across the 2026-09-02 stress session the reading shares of the cycles were
     0, 8, 17, 20, 22, 23, 25, 28, 36, 39, 44, 46 per cent — with an empty band between 28 and 36.
     A third falls inside that gap, so no observed cycle sits near the boundary: the stragglers at
     19% (Rome) and 28% (stress) go quiet, and the cycles where the app really was the cost keep
     speaking. A fifth was set from one point and let the 28% case through, which then told a user
     with 64 features loaded to switch overlays off.
     ⚠ The fifth is deliberately KEPT for _starved below, and the asymmetry is the point: this
     branch withholds a message, that one asserts a cause. Claiming "the connection is saturated"
     needs the stricter evidence; staying quiet does not.
     ⚠ The two branches cannot both apply: this one needs fewer than a quarter of the requests
     outstanding, _starved needs a quarter or more. Mutually exclusive by construction, so their
     order here carries no meaning.
     ⚠ And a server that is genuinely UNREACHABLE is not this notice's job at all — it is not a
     threshold question, it is a transport one. The failure callback reports it through
     _reportLayerError, an error toast built with no `kind` precisely so that every failure episode
     speaks (see the note beside it). So withholding here cannot hide a dead endpoint: the two
     channels answer different questions, and only one of them is about how long a wait is. */
  const _backA = _wfsArrivedThisCycle, _outA = _wfsInFlight, _askedA = _backA + _outA;
  const _readA = _wfsReadMs + (_wfsQueueBusySince ? Math.max(0, Date.now() - _wfsQueueBusySince) : 0);
  /* ⚠ TWO shapes of one thing: the wait was not made of this app. Requiring an OPEN cycle was a
     defect, measured the same evening it shipped — 2026-09-02 14:13, a cycle held correctly at
     12 s ("nearly done", 35 of 36 replies in) closed 52 seconds later and the notice came out
     through the other door anyway, saying "11 overlays, 532 features, switch some off" for a
     63.9 s wait of which the reading was 1.4 s. TWO POINT TWO PER CENT.
     On a closed cycle the counting terms are meaningless — everything arrived, so `_out` is 0 and
     the quarter rule has nothing to divide. The reading share is the whole discriminator there,
     and by then the wait is over: a dialog that cannot be dismissed, raised after the condition
     has already ended, has nothing to offer. The user left that one on screen for 190 seconds.
     ⚠ The same third for both, deliberately: it is one question ("was the reading the cost?"), and
     two different fractions for one question would be arbitrary. At 30% of a 64 s cycle the app
     really did spend twenty seconds, and it still speaks. */
  const _quiet = !_wfsQueue.length && !_wfsStalledMs && _readA * 3 < took;
  /* ⚠ ONE silent server is a straggler whatever the denominator, and that is the second term.
     Measured 2026-09-02 14:50: a refresh of only TWO layers, one answered and one did not, and the
     quarter rule passed trivially (4 >= 2) — so a single slow endpoint was announced as "the
     connection is saturated" while the map held 1029 features and the wait resolved itself in
     19.6 s. On a small cycle any outstanding request clears a quarter, so the rule alone cannot
     evidence a LINK; it takes at least two servers gone quiet to say something about the pipe. */
  const _straggler = open && _outA > 0 && (_outA * 4 < _askedA || _outA < 2);  // ends on its own
  const _alreadyOver = !open;                                   // has ended, and it was not us
  const _nearlyDone = _quiet && (_straggler || _alreadyOver);
  if (_nearlyDone) {
    if (!_wfsNoticeHeld && typeof nvLog === 'function') {
      nvLog('notice held', _straggler ? 'nearly done' : 'wait was not the app',
            (took / 1000).toFixed(1) + 's',
            'read ' + _readA + 'ms', 'replies ' + _backA + '/' + _askedA);
    }
    _wfsNoticeHeld = true;
    if (_wfsCycleStart) {
      clearTimeout(_wfsOverdueTimer);
      _wfsOverdueTimer = setTimeout(() => {
        if (!_wfsCycleStart) return;
        _wfsNotice(Date.now() - _wfsCycleStart, true);
      }, _WFS_SLOW_CYCLE_MS);
    }
    return;
  }
  // Claimed before the dialog goes up so a second cycle cannot stack a second alert behind it.
  _wfsLastNotice = Date.now();
  /* ⚠ The trigger cannot, on its own, tell a jammed CPU from a jammed pipe: the cycle clock starts
     when the REQUEST goes out (see the note beside _wfsCycleBegin's caller), so it counts the
     network round trip too, and twelve seconds of a bad link cross the bar with the CPU idle. The
     old text blamed the parse either way — "asks for them again and re-reads them" — which is the
     one cost not being paid in that case.
     Starved is decided on the CLOCK, not on a reply count. Counting was tried and the field broke
     it on the first firing this notice ever had: 45 s into an opening load, four of six layers had
     answered and two had not, which any majority test reads as "the replies are in, so the cost is
     the reading" — while those four replies carried three features between them and the parse had
     cost under a millisecond. The wait was the two servers that had not answered.
     So: replies still outstanding, nothing piled up waiting to be read, and the reading accounted
     for less than a fifth of the wait. The fifth is a judgement, and the one measured point sits
     nowhere near it — that session read for 0.3 s inside 45 s of waiting, under 1%.
     The `!_wfsQueue.length` term is what keeps a parse pile-up from being called a network fault:
     replies queued and unread are the CPU's backlog, not the pipe's silence.
     ⚠ And the last term keeps a STRAGGLER from being called a saturated link. Twelve answers with
     one server still thinking leaves the CPU just as idle as total silence does, so the clock test
     alone would call it a saturated connection — a sentence that is simply untrue when twelve
     replies out of thirteen are already in. A quarter of the requests still outstanding is the
     line, and the field case sits well clear of it: two of six, against one of thirteen for the
     straggler it is there to exclude.
     ⚠ The sentence reports the real arrival count rather than claiming nothing came back, because
     partial arrivals now reach this branch. A message that overstates its own evidence is the
     thing the branch exists to avoid.
     ⚠ Being offline does not reach here: a transport failure calls _arrived() like any reply, so
     the cycle closes in a fraction of a second and never crosses the bar. What reaches here is a
     link that accepts the connection and then says nothing. */
  const _back = _wfsArrivedThisCycle, _out = _wfsInFlight, _asked = _back + _out;
  const _readMs = _wfsReadMs + (_wfsQueueBusySince ? Math.max(0, Date.now() - _wfsQueueBusySince) : 0);
  /* ⚠ `!_wfsStalledMs` last: if the watchdog had to close anything this cycle, the wait has a third
     explanation that is neither pipe nor parse, and the honest answer is not to name a cause. */
  const _starved = open && _out > 0 && !_wfsQueue.length && !_wfsStalledMs
                   && _readMs * 5 < took && _out * 4 >= _asked;
  /* The notice leaves a trace in the report. Without it, whether the dialog appeared at all had to
     be reconstructed from the shape of a long task — twice, and wrong the first time. A dialog that
     blocks the main thread while it is up also inflates the long-task figures, so the report is
     unreadable unless it says which of them was a dialog. Which of the two things it blamed is
     logged too: the report is where a wrong diagnosis would be caught. */
  if (typeof nvLog === 'function') {
    nvLog('notice raised', (took / 1000).toFixed(1) + 's',
          open ? '(cycle still open)' : '(cycle closed)',
          _starved ? 'network' : 'parse',
          'read ' + _readMs + 'ms of ' + Math.round(took) + 'ms',
          _wfsStalledMs ? 'STALLED ' + _wfsStalledMs + 'ms' : '',
          'replies ' + _back + '/' + _asked,
          'layers', layers, 'features', feats);
  }
  /* ⚠ "overlays", not "cadastral layers". Of the thirteen WFS layers in the field configuration
     only six are cadastre — the rest are IGM/INSPIRE, contour lines and toponyms among them — so
     the old wording named the wrong thing to switch off. Deliberately generic: "starting with the
     heaviest" leaves the choice to the user, who knows which ones are worth keeping, rather than
     this code guessing on their behalf. */
  /* ⚠ "Background maps are not the problem" is dropped on the starved branch, and deliberately:
     it is true of the CPU and false of the pipe, where tile requests compete for the same
     bandwidth as the overlays. Same for the rotation line — nothing is being redrawn while
     nothing is arriving.
     On the parse branch it is qualified instead of dropped, and only when the map is turned:
     a satellite basemap does cost more to redraw in rotation than a plain one (field
     observation, 2026-09-06), which is the single case where the flat claim is false. At
     locked north it stays as it was, because there it is simply true. The test is the
     _mapIsTurned() the message already makes two paragraphs above, so the qualification costs
     nothing to decide. */
  /* Italian, unlike the code and the comments around it: the GISCatasto interface is in Italian,
     and this string is one the user reads. */
  const body = _starved
    /* ⚠ ONE denominator per message. This branch used to open with "N overlays are active, with
       about M features loaded" — the count of everything on the map — and then talk about the
       requests of this cycle, so a field report showed "11 overlays … only 1 of 2 requests has
       come back". Eleven and two in the same paragraph, and nothing to reconcile them with. The
       layers-and-features opening belongs to the parse branch, where the whole map IS the subject;
       here the subject is the refresh that is late, so it counts only that. */
    ? 'La connessione è satura: dei ' + _asked + ' overlay in aggiornamento, dopo ' +
      (took / 1000).toFixed(0) + ' secondi ' +
      (_back === 0
        ? 'non ne ha risposto nessuno'
        : (_back === 1 ? 'ne ha risposto solo 1' : 'ne hanno risposto solo ' + _back)) + '.\n\n' +
      'Riduci gli overlay attivi e verifica di avere una buona connessione.'
    : layers + ' overlay attivi, con circa ' + feats.toLocaleString() + ' geometrie caricate.\n\n' +
      'Ogni spostamento, rotazione o zoom le richiede di nuovo e le rilegge: ' +
      (open ? 'sta impiegando oltre ' : 'ha impiegato ') + (took / 1000).toFixed(0) + ' secondi' +
      (open ? ' finora.' : ' questa volta.') + '\n\n' +
      'Spegni gli overlay che non usi, partendo dai più pesanti, ' +
      'oppure avvicina lo zoom prima di spostarti.\n\n' +
      /* Only when the map is actually turned. See the note at the head of this section for why
         rotation is named at all when it is the cheaper gesture to draw: what it costs here is
         memory, not frame time. */
      (_mapIsTurned()
        ? 'La mappa è anche ruotata. Se non ti serve così, tocca la bussola per bloccarla a nord: ' +
          'con questo numero di geometrie ogni rotazione le ridisegna tutte.\n\n'
        : '') +
      (_mapIsTurned()
        ? 'Le mappe di sfondo sono raramente il problema, ma una satellitare pesa di più da ' +
          'ridisegnare con la mappa ruotata.'
        : 'Le mappe di sfondo non sono il problema: puoi lasciarle accese.');

  setTimeout(() => {
    const shown = Date.now();
    /* ⚠ The cooldown restarts when the user CLOSES the dialog, not when it was raised. A dialog
       left open for four minutes had already outlived a cooldown stamped at raise time, so the
       notice came straight back the moment OK was pressed. */
    const dismissed = () => {
      if (typeof nvLog === 'function') {
        nvLog('notice dismissed', 'after ' + ((Date.now() - shown) / 1000).toFixed(1) + 's');
      }
      _wfsLastNotice = Date.now();
    };
    if (typeof showNoticeModal === 'function') {
      showNoticeModal(_starved ? 'La mappa sta aspettando i dati'
                               : 'Gli overlay stanno rallentando la mappa', body, dismissed);
    } else {
      // Only if utils.js failed to load: better a blocking dialog than a silent one.
      try { alert(body); } catch (_) {}
      dismissed();
    }
  }, 0);
}

/* Called wherever a cycle could conclude — a reply parsed, a request that failed. The cycle is over
   only when nothing is in flight AND nothing is left to parse. */
function _wfsCycleMaybeEnd() {
  if (_wfsInFlight > 0 || _wfsQueue.length || _wfsQueueBusy) return;
  _wfsCycleEnd();
}

function _wfsCycleEnd() {
  if (!_wfsCycleStart) return;
  const took = Date.now() - _wfsCycleStart;
  _wfsCycleStart = 0;
  window._nvWfsCycleOpen = 0;
  clearTimeout(_wfsOverdueTimer);
  _wfsOverdueTimer = null;
  let feats = 0, layers = 0;
  _wfsFeatureTotals.forEach(n => { feats += n; layers++; });
  if (typeof nvLog === 'function') {
    nvLog('wfs cycle', (took / 1000).toFixed(1) + 's',
          'read ' + (_wfsReadMs / 1000).toFixed(1) + 's',
          _wfsStalledMs ? 'stalled ' + (_wfsStalledMs / 1000).toFixed(1) + 's' : '',
          'layers', layers, 'features', feats);
  }
  window._nvLastWfsCycle = { ms: took, layers, features: feats,
                             readMs: _wfsReadMs, stalledMs: _wfsStalledMs };
  const w = window._nvWorstWfsCycle;
  if (!w || took > w.ms) window._nvWorstWfsCycle = window._nvLastWfsCycle;

  /* The opening load is measured and reported like any other cycle, and judged against its own
     higher bar. See the note beside _WFS_FIRST_CYCLE_MS. */
  const wasFirst = !_wfsFirstCycleDone;
  _wfsFirstCycleDone = true;
  if (took < (wasFirst ? _WFS_FIRST_CYCLE_MS : _WFS_SLOW_CYCLE_MS)) return;
  _wfsNotice(took, false);
}

const _WFSLayer = L.Layer.extend({
  options: { typeName:'', version:'2.0.0', minZoom:15, opacity:0.8, crs:null,
             filterAttr:'', filterVals:'', color:null, hollow:false, fillOpacity:null, pane:null,
             jsonSupported:true,
             style:{ color:'#e63946', weight:1.5, fillOpacity:0.15 }, attribution:'' },

  initialize(url, options) {
    const _sp = _splitOgcUrl(url);
    this._wfsUrl = _sp.base;
    this._wfsPre = _sp.pre;
    L.setOptions(this, options);
    // Every WFS needs its OWN pane so the legend can restack it: a pane-less layer
    // falls into the shared overlayPane (z 400), which _applyOverlayZOrder skips —
    // pinning it above the legend band regardless of drag order. Cadastre layers
    // pass an explicit pane (wfs-particelle / wfs-fogli) and keep it.
    if (!this.options.pane) this.options.pane = 'wfs-u' + L.stamp(this);
    this.options.style = Object.assign({}, this.options.style); // own copy
    if (this.options.color) { this.options.style.color = this.options.color; this.options.style.fillColor = this.options.color; }
    if (this.options.hollow) { this.options.style.fillOpacity = 0; }
    else if (this.options.fillOpacity !== null && this.options.fillOpacity !== undefined) { this.options.style.fillOpacity = this.options.fillOpacity; }
    this._geo = null; this._reqId = 0;
  },

  onAdd(map) {
    this._map = map;
    if (this.options.pane) {
      const paneZindex = { 'wfs-particelle': 402, 'wfs-fogli': 404 };
      if (!map.getPane(this.options.pane)) {
        const p = map.createPane(this.options.pane);
        p.style.zIndex = paneZindex[this.options.pane] || 403;
        // Move into rotatePane so the pane rotates with the map and stays
        // below norotatePane (which holds popups/tooltips)
        const rotatePane = map.getPane('rotatePane');
        if (rotatePane) rotatePane.appendChild(p);
      }
      _reorderMapPanes(map);
    }
    /* moveend goes through the coverage guard, zoomend does not: a zoom changes both the extent
       and which features are worth drawing, so it always needs a fresh request. Same split the
       WMS layer makes, for the same reason. */
    map.on('moveend', this._onViewChange, this);
    map.on('zoomend', this._schedule, this);
    this._schedule();
    _wfsLayerAdded(this);
  },

  onRemove(map) {
    clearTimeout(this._timer);
    this._reqId = (this._reqId || 0) + 1;  // invalidate any in-flight render so late responses don't re-add features
    map.off('moveend', this._onViewChange, this);
    map.off('zoomend', this._schedule, this);
    this._fetchedBounds = null;
    this._fetchedZoom   = null;
    if (this._geo) { try { map.removeLayer(this._geo); } catch(_) {} this._geo = null; }
    _wfsLayerRemoved(this);
  },

  setOpacity(o) {
    this.options.opacity = o;
    // fillOpacity is a design constant set in initialize — only opacity changes for blending
    if (this._geo) this._geo.setStyle({ opacity: o });
  },

  setStyle(s) {
    Object.assign(this.options.style, s);
    if (this._geo) this._geo.setStyle(this.options.style);
  },

  setFilter(attr, vals) {
    this.options.filterAttr = attr || '';
    this.options.filterVals = vals || '';
    // _schedule (debounced 400 ms) instead of _update: lets a same-tick fitBounds/setZoom collapse
    // with the filter change into one final fetch, avoiding a stale-bounds fetch1 that would fire
    // wfsupdate({count:0}) and consume the caller's .once('wfsupdate') listener before the map
    // has moved to the target area.
    if (this._map) this._schedule();
  },

  /* Resolve the geographic extent of features matching the active filter, ignoring the current viewport.
     Issues a GetFeature with the FILTER predicate only (no BBOX), capped at 50 features.
     Calls callback(bounds, err): bounds is L.LatLngBounds on success, null + err string on failure. */
  findFilteredExtent(callback) {
    if (!this.options.filterAttr || !this.options.filterVals) {
      callback(null, 'no filter active'); return;
    }
    // Agenzia Entrate cadastral WFS does not support server-side FILTER (see _update), so a global
    // find by attribute is impossible — features can only be located by panning into their bbox.
    if (/^CP:(CadastralParcel|CadastralZoning)$/i.test(this.options.typeName || '')) {
      callback(null, 'il server non supporta il filtro — sposta o zooma vicino alla particella');
      return;
    }
    const ver  = parseFloat(this.options.version || '2.0');
    const srsName = this.options.crs || (ver >= 2.0 ? 'urn:ogc:def:crs:EPSG::4326' : 'EPSG:4326');
    const geoUrn  = /^urn:ogc:def:crs:/.test(srsName);
    const geoEpsg = /^EPSG:(4326|4258|6706|4230)$/.test(srsName);
    const swapAxes = geoUrn || (ver >= 2.0 && geoEpsg);

    const is20   = ver >= 2.0;
    const fns    = is20 ? 'fes' : 'ogc';
    const fnsUri = is20 ? 'http://www.opengis.net/fes/2.0' : 'http://www.opengis.net/ogc';
    const gmlNs  = is20 ? 'http://www.opengis.net/gml/3.2' : 'http://www.opengis.net/gml';
    const propTag = is20 ? 'ValueReference' : 'PropertyName';
    const xmlEsc = s => String(s).replace(/[<>&'"]/g,
      c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));

    // Same CP-namespace handling as _update — kept inline to avoid coupling with the bbox-bound path.
    const _isCadFilter = /^CP:(CadastralParcel|CadastralZoning)$/i.test(this.options.typeName || '');
    const _cadNs = 'http://mapserver.gis.umn.edu/mapserver';
    const _userHasPrefix = this.options.filterAttr.includes(':');
    const filterAttrQName = (_isCadFilter && !_userHasPrefix)
      ? 'CP:' + this.options.filterAttr
      : this.options.filterAttr;
    const attrEsc = xmlEsc(filterAttrQName);
    const vals = this.options.filterVals.split(',').map(v => v.trim()).filter(Boolean);
    const _hasWild = v => /[*?]/.test(v);
    const eqs = vals.map(v => {
      const propXml = `<${fns}:${propTag}>${attrEsc}</${fns}:${propTag}>`;
      const litXml  = `<${fns}:Literal>${xmlEsc(v)}</${fns}:Literal>`;
      return _hasWild(v)
        ? `<${fns}:PropertyIsLike wildCard="*" singleChar="?" escapeChar="\\">${propXml}${litXml}</${fns}:PropertyIsLike>`
        : `<${fns}:PropertyIsEqualTo>${propXml}${litXml}</${fns}:PropertyIsEqualTo>`;
    }).join('');
    const attrPred = vals.length > 1 ? `<${fns}:Or>${eqs}</${fns}:Or>` : eqs;
    const cadNsAttr = _isCadFilter ? ` xmlns:CP="${_cadNs}"` : '';
    const filterXml =
      `<${fns}:Filter xmlns:${fns}="${fnsUri}" xmlns:gml="${gmlNs}"${cadNsAttr}>` +
      `${attrPred}</${fns}:Filter>`;

    const p = {
      SERVICE:'WFS', VERSION: this.options.version, REQUEST:'GetFeature',
      TYPENAMES: this.options.typeName,
      TYPENAME:  this.options.typeName,
      SRSNAME: srsName,
      maxFeatures: 50, count: 50,
      FILTER: filterXml
    };
    if (ver < 2.0 && this.options.jsonSupported) p.outputFormat = 'application/json';

    const url = this._wfsUrl + '?' +
      (this._wfsPre ? this._wfsPre + '&' : '') +
      Object.entries(p).map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&');

    // Compute bounds from response — bounds-only extraction (no full feature parsing) keeps this lean
    // and tolerant of GML variants. JSON path uses GeoJSON's always-lon,lat convention; GML path applies
    // axis swap when the negotiated CRS returns lat,lon (urn form or WFS 2.0 with geographic EPSG).
    const _coordsFromGeoJSON = geom => {
      if (!geom) return [];
      const out = [];
      const walk = c => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number') { out.push([c[0], c[1]]); return; }
        c.forEach(walk);
      };
      walk(geom.coordinates);
      return out;
    };
    const _boundsFromText = text => {
      try {
        const gj = JSON.parse(text);
        if (gj && gj.features && gj.features.length) {
          let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
          for (const f of gj.features) for (const [x,y] of _coordsFromGeoJSON(f.geometry)) {
            if (x<minX) minX=x; if (x>maxX) maxX=x; if (y<minY) minY=y; if (y>maxY) maxY=y;
          }
          if (minX === Infinity) return null;
          return L.latLngBounds([minY,minX],[maxY,maxX]);
        }
      } catch(_) {}
      try {
        const dom = new DOMParser().parseFromString(text, 'application/xml');
        if (dom.querySelector('parsererror')) return null;
        const G3 = 'http://www.opengis.net/gml/3.2', G2 = 'http://www.opengis.net/gml';
        // Collect every Envelope in the document (top-level boundedBy + per-feature) and union them.
        const envs = [...dom.getElementsByTagNameNS(G3,'Envelope'), ...dom.getElementsByTagNameNS(G2,'Envelope')];
        let minA=Infinity,minB=Infinity,maxA=-Infinity,maxB=-Infinity;
        for (const env of envs) {
          const lc = env.getElementsByTagNameNS(G3,'lowerCorner')[0] || env.getElementsByTagNameNS(G2,'lowerCorner')[0];
          const uc = env.getElementsByTagNameNS(G3,'upperCorner')[0] || env.getElementsByTagNameNS(G2,'upperCorner')[0];
          if (!lc || !uc) continue;
          const l = lc.textContent.trim().split(/\s+/).map(Number);
          const u = uc.textContent.trim().split(/\s+/).map(Number);
          if (l[0]<minA) minA=l[0]; if (l[1]<minB) minB=l[1];
          if (u[0]>maxA) maxA=u[0]; if (u[1]>maxB) maxB=u[1];
        }
        if (minA === Infinity) {
          // No envelopes — fall back to scanning pos/posList for raw coords.
          for (const el of [...dom.getElementsByTagNameNS(G3,'posList'), ...dom.getElementsByTagNameNS(G2,'posList'),
                            ...dom.getElementsByTagNameNS(G3,'pos'),     ...dom.getElementsByTagNameNS(G2,'pos')]) {
            const n = el.textContent.trim().split(/\s+/).map(Number);
            for (let i=0; i+1<n.length; i+=2) {
              const a=n[i], b=n[i+1];
              if (a<minA) minA=a; if (a>maxA) maxA=a; if (b<minB) minB=b; if (b>maxB) maxB=b;
            }
          }
          if (minA === Infinity) return null;
        }
        return swapAxes
          ? L.latLngBounds([minA, minB], [maxA, maxB])  // server returned lat,lon
          : L.latLngBounds([minB, minA], [maxB, maxA]); // server returned lon,lat
      } catch(_) { return null; }
    };

    const _onText = text => {
      const b = _boundsFromText(text);
      if (b && b.isValid()) callback(b, null);
      else callback(null, 'nessuna geometria corrisponde al filtro');
    };

    if (window.cordova && cordova.plugin && cordova.plugin.http) {
      cordova.plugin.http.sendRequest(url, { method:'get', responseType:'arraybuffer' },
        res => _onText(_decodeXmlBuffer(res.data)),
        () => callback(null, 'richiesta non riuscita')
      );
    } else {
      fetch(url).then(r => r.arrayBuffer()).then(buf => _onText(_decodeXmlBuffer(buf)))
        .catch(() => callback(null, 'richiesta non riuscita'));
    }
  },

  _schedule() { clearTimeout(this._timer); this._timer = setTimeout(() => this._update(), 400); },

  /* Is what was last asked for still enough to cover the screen? Same question, same shape, as
     _WMSImageLayer._covered — this layer simply never asked it. Without it every gesture that
     ended with a few pixels of drift refetched and then rebuilt every feature on the map:
     _render adds the new GeoJSON layer and removes the old one, so the whole SVG is recreated.
     Measured on the bench: a 45 degree turn plus 18x12 px of drift cost 2 _update and 2 full
     replaces with two WFS layers loaded, and the field device carries five.
     It closes the toast flood as well, and that is not a coincidence: three of those five layers
     hold no data over the area being browsed, so they answered EMPTY on every single refetch and
     each gesture opened a fresh burst. Fewer refetches, fewer bursts. */
  _covered() {
    const b = this._fetchedBounds;
    if (!b || !this._map) return false;
    const map = this._map;
    if (this._fetchedZoom !== map.getZoom()) return false;
    const s = map.getSize();
    return [[0, 0], [s.x, 0], [s.x, s.y], [0, s.y]]
      .every(p => b.contains(map.containerPointToLatLng(p)));
  },

  _onViewChange() { if (!this._covered()) this._schedule(); },

  /* The area to ask for. Mirrors _WMSImageLayer._requestBounds and exists for the same reason:
     the viewport envelope is bearing-DEPENDENT — 412x915 at 0 degrees, 938x938 at 45 — so a
     region fetched at one bearing cannot cover the screen at the next. Rotation itself fires no
     moveend, so nothing is asked for while the map turns; the refetch lands at the END of the
     gesture, when the fingers drift a few pixels and the envelope no longer matches. One rebuild
     per turn, which is what consecutive rotations looked like from the field.
     The circumscribed square is bearing-INDEPENDENT: once fetched, no turn uncovers it.
     Two differences from the WMS, both because a WFS box means FEATURES and not pixels:
     - The square is refused at or below the layer's own minZoom, and refused whenever it would
       reach further than one zoom level of the plain request. One level out doubles the ground
       per pixel, and the layer already accepts asking for that much at minZoom, so this never
       asks for more ground than the layer is already willing to ask for. The comparison is made
       in METRES at runtime rather than assumed: the inequality behind it (w²+h² < 4wh) holds
       only for screen aspect ratios between about 1:3.7 and 3.7:1 — true of every phone, not
       true by definition, and this must not become another constant tuned to one device.
     - It is padded like the plain request, and the pad is what makes it work at all: the screen
       corners sit at exactly half a diagonal from the centre, which is the square's inscribed
       radius, so a bare square has ZERO margin against the pan that ends a two-finger gesture.
       The pad turns that into ~100 px of slack against the 18x12 px measured on the bench. */
  _requestBounds() {
    const map   = this._map;
    const plain = map.getBounds().pad(_NV_WFS_PAD);
    if (typeof map.getBearing !== 'function' || !map.getBearing()) return plain;
    if (map.getZoom() <= (this.options.minZoom || 0)) return plain;
    const size = map.getSize();
    const r    = Math.ceil(Math.sqrt(size.x * size.x + size.y * size.y) / 2);
    const z    = map.getZoom();
    const c    = map.project(map.getCenter(), z);
    const square = L.latLngBounds(map.unproject(c.add(L.point(-r,  r)), z),
                                  map.unproject(c.add(L.point( r, -r)), z)).pad(_NV_WFS_PAD);
    /* The square asks for roughly twice the features of the envelope, and a server that reaches
       its count ceiling truncates in SILENCE — the map would simply be missing parcels, which is
       worse than the redraw this exists to avoid. So the server's own answer decides: once a
       response has come back at the ceiling this layer stops enlarging, and goes back to the
       square when one comes back below it. No constant to tune, and it adapts to how dense the
       ground actually is instead of to an assumption about it. */
    if (this._ceilingHit) return plain;
    const side = b => Math.max(map.distance(b.getNorthWest(), b.getNorthEast()),
                               map.distance(b.getNorthWest(), b.getSouthWest()));
    return side(square) > side(plain) * 2 ? plain : square;
  },

  /* Human name for toasts, so a message says WHICH overlay it refers to (there can be
     several WFS at once: Catasto Particelle, Fogli, user-added). Falls back when unnamed. */
  _name() { return this.options.attribution ? '"' + this.options.attribution + '"' : 'WFS layer'; },

  _update() {
    /* Every early return below has to release the queue, or the layers behind this one never run.
       Called through a local alias so the paths that return before any request is built are as
       explicit about finishing as the ones that succeed. */
    const _done = () => { const d = this._queueDone; if (d) { this._queueDone = null; d(); } };
    const map = this._map;
    if (!map) { _done(); return; }
    if (map.getZoom() < this.options.minZoom) {
      if (this._geo) { try { map.removeLayer(this._geo); } catch(_) {} this._geo = null; }
      const now = Date.now();
      if (!this._lastZoomWarn || now - this._lastZoomWarn > 5000) {
        _reportBelowScale(this._name());
        this._lastZoomWarn = now;
      }
      _done();
      return;
    }
    /* Recorded when the request is ISSUED, not when it lands, so a second gesture during a slow
       fetch does not queue another request for the same view. */
    const b = this._requestBounds();
    this._fetchedBounds = b;
    this._fetchedZoom   = map.getZoom();
    const reqId = ++this._reqId;
    const ver  = parseFloat(this.options.version || '2.0');
    const srsName = this.options.crs || (ver >= 2.0 ? 'urn:ogc:def:crs:EPSG::4326' : 'EPSG:4326');
    const geoUrn  = /^urn:ogc:def:crs:/.test(srsName);
    const geoEpsg = /^EPSG:(4326|4258|6706|4230)$/.test(srsName);
    // WFS ≥1.1.0 + geographic CRS → lat/lon axis order (CRS native order per spec); WFS 1.0 → lon/lat
    const latFirst = geoUrn || (ver >= 1.1 && geoEpsg);
    const bbox = latFirst
      ? `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()},${srsName}`
      : ver >= 1.1
        ? `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()},${srsName}`
        : `${b.getWest()},${b.getSouth()},${b.getEast()},${b.getNorth()}`;
    const p = {
      SERVICE:'WFS', VERSION: this.options.version, REQUEST:'GetFeature',
      TYPENAMES: this.options.typeName,
      TYPENAME:  this.options.typeName,
      BBOX: bbox,
      SRSNAME: srsName,
      // 1000 is the ceiling MapServer enforces by default (CountDefault). WFS 1.x clamps
      // silently, but WFS 2.0 rejects an out-of-range COUNT with HTTP 400 — which surfaces
      // as a bare "request failed" toast, since a non-2xx lands in the transport error
      // callback and never reaches the parser. Asking for more than a viewport can usefully
      // draw buys nothing, so cap the request at the value every server accepts.
      maxFeatures: 1000, count: 1000
    };
    // Request JSON only when the server advertised it (default true for back-compat with hand-typed URLs).
    // For GML-only servers (e.g. MapServer PCN) omit the param so the server returns its default GML, parsed below.
    if (ver < 2.0 && this.options.jsonSupported) p.outputFormat = 'application/json';
    // Agenzia Entrate INSPIRE WFS does NOT advertise Filter_Capabilities and rejects any GetFeature
    // carrying a FILTER parameter ("InvalidFormat / Richiesta non valida"), regardless of namespace or
    // operator form. For CP:CadastralParcel / CP:CadastralZoning we must fetch by BBOX only and filter
    // the returned features locally before rendering.
    const _isCadFilter = /^CP:(CadastralParcel|CadastralZoning)$/i.test(this.options.typeName || '');
    const _isCadParcel = /^CP:CadastralParcel$/i.test(this.options.typeName || '');
    // Build a client-side matcher when the filter is active. Supports comma-separated values and
    // OGC-style wildcards (* and ?), matched case-insensitively against the stringified property value.
    let _clientFilter = null;
    if (this.options.filterAttr && this.options.filterVals) {
      const _fAttr = this.options.filterAttr;
      const _fVals = this.options.filterVals.split(',').map(v => v.trim()).filter(Boolean);
      const _matchers = _fVals.map(v => {
        if (/[*?]/.test(v)) {
          const rx = '^' + v.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$';
          return new RegExp(rx, 'i');
        }
        return v.toLowerCase();
      });
      // Case-insensitive key lookup: OL's WFS/GML readers may normalize element local names
      // (e.g. INSPIRE canonical camelCase) so an exact-case match on filterAttr misses.
      const _fAttrLc = _fAttr.toLowerCase();
      const _lookupProp = props => {
        if (props[_fAttr] != null) return props[_fAttr];
        for (const k in props) if (k.toLowerCase() === _fAttrLc) return props[k];
        return null;
      };
      _clientFilter = props => {
        if (!props) return false;
        const raw = _lookupProp(props);
        if (raw == null || raw === '') return false;
        const sv = String(raw).toLowerCase();
        return _matchers.some(m => m instanceof RegExp ? m.test(sv) : sv === m);
      };
    }
    if (!_isCadFilter && this.options.filterAttr && this.options.filterVals) {
      // OGC Filter Encoding XML — WFS standard, supported by deegree, GeoServer, MapServer, QGIS Server.
      // BBOX is embedded inside the same <Filter> via <And>: the spec forbids BBOX param + FILTER together.
      const is20   = ver >= 2.0;
      const fns    = is20 ? 'fes' : 'ogc';
      const fnsUri = is20 ? 'http://www.opengis.net/fes/2.0' : 'http://www.opengis.net/ogc';
      const gmlNs  = is20 ? 'http://www.opengis.net/gml/3.2' : 'http://www.opengis.net/gml';
      const propTag = is20 ? 'ValueReference' : 'PropertyName';
      const xmlEsc = s => String(s).replace(/[<>&'"]/g,
        c => ({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));
      const vals = this.options.filterVals.split(',').map(v => v.trim()).filter(Boolean);
      const attrEsc = xmlEsc(this.options.filterAttr);
      const _hasWild = v => /[*?]/.test(v);
      const eqs = vals.map(v => {
        const propXml = `<${fns}:${propTag}>${attrEsc}</${fns}:${propTag}>`;
        const litXml  = `<${fns}:Literal>${xmlEsc(v)}</${fns}:Literal>`;
        return _hasWild(v)
          ? `<${fns}:PropertyIsLike wildCard="*" singleChar="?" escapeChar="\\">${propXml}${litXml}</${fns}:PropertyIsLike>`
          : `<${fns}:PropertyIsEqualTo>${propXml}${litXml}</${fns}:PropertyIsEqualTo>`;
      }).join('');
      const attrPred = vals.length > 1 ? `<${fns}:Or>${eqs}</${fns}:Or>` : eqs;
      const c1 = latFirst ? b.getSouth() : b.getWest();
      const c2 = latFirst ? b.getWest()  : b.getSouth();
      const c3 = latFirst ? b.getNorth() : b.getEast();
      const c4 = latFirst ? b.getEast()  : b.getNorth();
      const bboxXml =
        `<${fns}:BBOX><gml:Envelope srsName="${xmlEsc(srsName)}">` +
        `<gml:lowerCorner>${c1} ${c2}</gml:lowerCorner>` +
        `<gml:upperCorner>${c3} ${c4}</gml:upperCorner>` +
        `</gml:Envelope></${fns}:BBOX>`;
      p.FILTER =
        `<${fns}:Filter xmlns:${fns}="${fnsUri}" xmlns:gml="${gmlNs}">` +
        `<${fns}:And>${bboxXml}${attrPred}</${fns}:And></${fns}:Filter>`;
      delete p.BBOX;
    }
    const url = this._wfsUrl + '?' +
      (this._wfsPre ? this._wfsPre + '&' : '') +
      Object.entries(p).map(([k,v]) => k + '=' + encodeURIComponent(v)).join('&');

    const _render = geojson => {
      /* A superseded response still ends this layer's turn in the queue. onRemove bumps _reqId
         too, so without this a layer switched off mid-flight would hold the queue until the
         watchdog fired — twenty seconds of nothing for every layer behind it. */
      if (reqId !== this._reqId) { _done(); return; }
      this._errShown = false;   // a good response re-arms the latch for the next failure
      // Client-side filter pass for servers that don't support FILTER (Agenzia Entrate cadastral WFS).
      // Applied before the empty-check so the toast distinguishes "no features at all" vs "filtered out".
      if (_clientFilter && _isCadFilter && geojson.features) {
        geojson = { ...geojson, features: geojson.features.filter(f => _clientFilter(f.properties)) };
      }
      if (!geojson.features || geojson.features.length === 0) {
        const _hasFilter = this.options.filterAttr && this.options.filterVals;
        /* Below the scale window the SERVICE declares, an empty answer says nothing about the
           ground: the parcels exist, the service just does not publish them at this scale, so
           "no features in current view" is a FALSE statement rather than a true one withheld.
           Keyed on typeName, like the FILTER bypass above (_isCadFilter) and for the same
           reason — this is knowledge about one public service, not a user setting. A config
           field was tried first and was worse: the bundled entry is skipped as a duplicate for
           anyone who already has a saved config (tools.js), so the fix would have reached new
           installs only, and the field would have been invisible in the add-service form.
           Reporting only, deliberately: minZoom alone decides what is DRAWN and is untouched
           here, so nothing vanishes that did not vanish before, and the cadastral wizard —
           which overrides minZoom for the duration of a search and never reads toasts — cannot
           be affected at all.
           ⚠ Two known weaknesses, both accepted rather than solved. The precedent above exists
           because the server REJECTS a request; this one is only about the wording of a notice,
           so it rests on a weaker justification. And 17 comes from the MaxScaleDenominator of
           5000 the service declares, which is NOT re-read at runtime: if the Agenzia republishes
           at another scale this line goes quietly wrong, and it is the first place to look. */
        const _belowService = _isCadParcel && map.getZoom() < _AE_PARCEL_MIN_Z;
        // This fires on every empty viewport refresh — i.e. every pan/zoom over an area
        // with no matching features — which is spammy. Throttle to once per 8 s per layer
        // and honour the startup grace window (via _loadToast).
        const _now = Date.now();
        if (!_belowService && (!this._lastEmptyWarn || _now - this._lastEmptyWarn > 8000)) {
          if (_hasFilter) {
            /* A filter matching nothing is actionable and has to name the layer it is set on.
               It cannot pile up the way the plain empty view does: the filter is something the
               user has just typed on one layer, not a condition every layer meets at once. */
            _loadToast(this._name() + ': nessuna geometria corrisponde al filtro — controlla nome attributo e valori',
                       'warn', undefined, 'map-quiet');
          } else {
            _reportWfsEmpty(this._name());
          }
          this._lastEmptyWarn = _now;
        }
        try { this.fire('wfsupdate', { count: 0 }); } catch(_) {}
        return;
      }
      /* The server's own signal that it truncated the answer, used by _requestBounds to stop
         asking for the enlarged square. ⚠ Partial by construction: it can only see the count WE
         asked for, so a server enforcing a LOWER ceiling of its own truncates undetected. Where
         it cannot see, it does nothing — it never makes the request worse than it already was. */
      this._ceilingHit = geojson.features.length >= 1000;
      const prev = this._geo;
      this._selectedLayer = null;
      const self = this;
      const _hlStyle = _SEL_STYLE;
      try {
        const _wfsPane = self.options.pane || null;
        const _gjOpts = {
          style: this.options.style,
          pointToLayer: (f, ll) => L.circleMarker(ll, { radius:5, ...self.options.style, ...(_wfsPane ? { pane: _wfsPane } : {}) }),
          onEachFeature: (f, layer) => {
            if (_wfsPane) try { layer.options.pane = _wfsPane; } catch(_) {}
            const key = _selKey(f);
            layer._selBase = { ...self.options.style };

            const _isCadastral = /CadastralParcel|CadastralZoning/.test(self.options.typeName);
            const _fp = f.properties || {};
            const _labelKeys = _isCadastral
              ? ['label','code','number','numero','NUMERO','codice','CODICE','LABEL','CODE','NUMBER']
              : ['label','LABEL','Label','name','NAME','Name'];
            const _labelRaw = _labelKeys
              .map(k => (_fp[k] != null && _fp[k] !== '') ? String(_fp[k]) : '')
              .find(v => v !== '') || null;

            // Re-apply selection highlight and tooltip if this feature was previously selected
            if (_selKeys.has(key)) {
              _selLayers.set(key, layer);
              try { layer.setStyle(_SEL_STYLE); } catch(_) {}
              const existingLabel = _selLabels.get(key);
              if (existingLabel) try { layer.bindTooltip(existingLabel, { permanent:true, className:'sel-label', direction:'auto' }); } catch(_) {}
            }

            layer.on('click', () => {
              if (!_selMode) return;
              layer._blockNextPopup = true;
              if (_selTarget && self.options.typeName !== _selTarget) return;
              _selToggle(key, layer, self.options.style, _labelRaw);
            });

            layer.on('popupopen', () => {
              if (layer._blockNextPopup) {
                layer._blockNextPopup = false;
                layer.closePopup();
              }
            });

            /* Built when the balloon opens, not when the features arrive. This runs for every
               feature of every response — up to maxFeatures, and again on each viewport
               refresh, which with GPS follow is about once a second — and the geometry section
               measures geodesics per vertex pair. Paid on load it is the whole batch on the
               main thread for popups nobody asked for; paid here it is the one that was
               tapped. The Select button also reads the live selection this way, instead of
               the state the feature happened to be in when it was fetched. */
            const buildPopup = () => {
              const p = f.properties;
              const popupEl = document.createElement('div');
              if (p && Object.keys(p).length) {
                const rows = Object.entries(p).slice(0, 8)
                  .map(([k,v]) => `<tr><td style="opacity:.65;padding-right:6px">${k}</td><td>${v ?? ''}</td></tr>`)
                  .join('');
                const tbl = document.createElement('table');
                tbl.style.cssText = 'font-size:11px;font-family:monospace;margin-bottom:6px';
                tbl.innerHTML = rows;
                popupEl.appendChild(tbl);
              }
              // Area and perimeter of the parcel: the number the attributes never carry.
              const geomSec = geomInfoSection(f);
              if (geomSec) popupEl.appendChild(geomSec);
              const selBtn = document.createElement('button');
              selBtn.style.cssText = 'font-size:11px;padding:3px 10px;cursor:pointer;background:var(--accent);color:#fff;border:none;border-radius:4px;width:100%';
              selBtn.textContent = _selKeys.has(key) ? '✓ Deselect' : '☆ Select';
              selBtn.addEventListener('click', e => {
                e.stopPropagation();
                _selToggle(key, layer, self.options.style, _labelRaw);
                selBtn.textContent = _selKeys.has(key) ? '✓ Deselect' : '☆ Select';
              });
              popupEl.appendChild(selBtn);
              // Prevent popup interactions from leaking to the map (nav pick mode, selection toggle, scroll-zoom)
              L.DomEvent.disableClickPropagation(popupEl);
              L.DomEvent.disableScrollPropagation(popupEl);
              return popupEl;
            };
            // autoPan off: a popup near the edge would nudge the map, and that move
            // triggers the per-viewport WFS refresh which rebuilds features and closes the
            // popup right after it opened. Without the pan it stays until the user moves.
            layer.bindPopup(buildPopup, { maxWidth:500, className:'wfs-popup', autoPan:false });
          }
        };

        /* ===== CHUNKED BUILD =====
           Building the whole answer in one L.geoJSON() call is a single synchronous block, and
           with the ceiling at 1000 features per layer and thirteen layers answering at once that
           block is what the field session hit: about two minutes during which the browser drew
           nothing and queued every tap — the compass tap included, which is why it only took
           effect after the freeze had already passed.
           Measured on the bench, a 2000-feature reply costs ~1700 ms end to end. Chunking does not
           make that work smaller — the total is the same or a shade worse for the scheduling — it
           makes it INTERRUPTIBLE: between chunks the browser paints a frame and collects input,
           so the map keeps answering while it fills.
           Features are added nearest-the-centre first, so what fills in first is what the user is
           looking at. Distance is taken from a feature's FIRST coordinate rather than its true
           centroid, or even its bounding box: those need a walk over every vertex, which is a
           second pass of the same order as the parse this exists to break up. For cadastral
           parcels — small and compact — the two orderings are indistinguishable on screen.
           ⚠ The previous layer is swapped at the END, exactly as before. Dropping it up front
           would be simpler and is wrong: the viewport refresh runs about once a second under GPS
           follow, and the map would blink empty every time. So progressive filling is what the
           user sees on a layer's FIRST load; a refresh keeps the old features until the new set
           is complete. */
        /* The budget caps FEATURES and VERTICES, because the two costs are separate and either
           one alone can blow a chunk. Measured on the bench: adding to a live L.geoJSON costs
           ~0.25 ms per feature plus ~0.0027 ms per vertex. So 150 small parcels of 20 vertices
           build in ~25 ms, while 24 contour lines of 2500 vertices — sixty times FEWER features —
           take 167 ms. A feature cap alone would have waved that second case through as a single
           chunk, which is exactly the case the field session hit. Both numbers are set to the same
           ~50 ms target, the threshold at which the browser itself calls a task long.
           A feature bigger than the whole budget is still added on its own: a geometry cannot be
           split, and that is the floor. */
        const _CHUNK_FEATS = 150;
        const _CHUNK_VERTS = 18000;
        /* Counts vertices without walking them: a coordinate array reports its own length, so this
           recurses over RINGS, not points, and stays O(rings). A true centroid would instead be a
           second full pass over every vertex — the very cost this mechanism exists to break up. */
        const _vertsOf = f => {
          const walk = a => {
            if (!Array.isArray(a) || !a.length) return 0;
            if (typeof a[0] === 'number') return 1;                                   // a position
            if (Array.isArray(a[0]) && typeof a[0][0] === 'number') return a.length;  // a ring
            let s = 0; for (let i = 0; i < a.length; i++) s += walk(a[i]);
            return s;
          };
          const g = f && f.geometry; if (!g) return 1;
          if (g.type === 'GeometryCollection') {
            let s = 0; (g.geometries || []).forEach(x => { s += walk(x && x.coordinates); });
            return s || 1;
          }
          return walk(g.coordinates) || 1;
        };
        const _c = map.getCenter();
        const _firstLL = f => {
          let g = f && f.geometry; if (!g) return null;
          if (g.type === 'GeometryCollection') g = g.geometries && g.geometries[0];
          let a = g && g.coordinates;
          while (Array.isArray(a) && Array.isArray(a[0])) a = a[0];
          return (Array.isArray(a) && typeof a[0] === 'number') ? a : null;
        };
        const _feats = geojson.features.slice().sort((fa, fb) => {
          const a = _firstLL(fa), b = _firstLL(fb);
          if (!a) return b ? 1 : 0;
          if (!b) return -1;
          // Squared degrees: monotonic in true distance, and this runs once per feature.
          const da = (a[0] - _c.lng) ** 2 + (a[1] - _c.lat) ** 2;
          const db = (b[0] - _c.lng) ** 2 + (b[1] - _c.lat) ** 2;
          return da - db;
        });

        const gj = L.geoJSON(null, _gjOpts).addTo(map);
        this._geo = gj;
        let _i = 0;
        const _step = () => {
          /* The same generation check the response already passes through, repeated per chunk:
             a build that started for a view the user has since left must not keep spending main
             thread on it, and must take its half-built layer with it when it goes. */
          /* ⚠ _done() is not optional here, and leaving it out cost a field session: the build
             surrenders but the QUEUE stays occupied, so no other reply can be read until the 20 s
             watchdog closes the job. Measured 2026-09-02 12:10 — five watchdog closures spaced
             exactly 20 s apart, a cycle open 114 s, roughly 100 of the session's 148 s spent
             wedged. And it amplifies: every pan during a build supersedes it, so the more the map
             is moved the more of the wait is this. The check at the head of _render already
             released the queue this way; these three later ones did not. */
          /* ⚠ `this._geo` has to go back to the layer that is still ON the map. It was pointed at
             `gj` before the first chunk, but `prev` is only removed at the END of a completed
             build — so on this path `prev` is still displayed. Leaving the reference on the
             discarded `gj` strands it: nothing points at the visible layer any more, onRemove
             takes the wrong one when the layer is switched off, and every superseded build
             abandons another copy on top of the map. Field diagnostic 2026-09-05: 2016 paths for
             1011 features, then 2616, with the cadastre still on screen after its layer had been
             turned off and its selection cleared. */
          if (reqId !== this._reqId) { try { map.removeLayer(gj); } catch(_) {} this._geo = prev; _done(); return; }
          let _nf = 0, _nv = 0;
          while (_i < _feats.length && _nf < _CHUNK_FEATS && _nv < _CHUNK_VERTS) {
            try { gj.addData(_feats[_i]); } catch(_) {}
            _nv += _vertsOf(_feats[_i]); _nf++; _i++;
          }
          if (_i < _feats.length) { setTimeout(_step, 0); return; }

          // Remove old layer; clear stale screen refs for layers that left the viewport
          if (prev) {
            try {
              /* Walk the SELECTIONS once and ask the outgoing group whether it holds each one,
                 rather than walking the outgoing group's features and searching the selections for
                 each. The old form rebuilt the whole entry array once per feature: a thousand
                 features meant a thousand throwaway arrays, on a path that runs on every pan and for
                 every layer. Same result — hasLayer tests the same direct membership eachLayer
                 iterates — in one pass instead of n. */
              const stale = [];
              _selLayers.forEach((l, k) => { if (prev.hasLayer(l)) stale.push(k); });
              stale.forEach(k => _selLayers.delete(k));
            } catch(_) {}
            try { map.removeLayer(prev); } catch(_) {}
          }
          _selUpdateBadge();
          try { this.fire('wfsupdate', { count: _feats.length }); } catch(_) {}
        };
        _step();
      } catch(_) {}
    };

    // Manual GML 3.2 / 3.1.1 / GML 2 DOM parser — handles non-standard namespaces (e.g. MapServer).
    // swapAxes=true for urn:ogc:def:crs:EPSG::4326 (server returns lat,lon → swap to lon,lat for GeoJSON).
    const _parseGmlManual = (text, swapAxes) => {
      try {
        const dom = new DOMParser().parseFromString(text, 'application/xml');
        if (dom.querySelector('parsererror')) return null;
        const G3 = 'http://www.opengis.net/gml/3.2', G2 = 'http://www.opengis.net/gml';
        const W2 = 'http://www.opengis.net/wfs/2.0', W1 = 'http://www.opengis.net/wfs';
        const root = dom.documentElement;

        // Not a FeatureCollection at all (e.g. ExceptionReport) — surface as network error
        if (root.localName !== 'FeatureCollection') return null;

        const gns = (el, name) => el.getElementsByTagNameNS(G3,name)[0] || el.getElementsByTagNameNS(G2,name)[0];
        const gnsAll = (el, name) => [...el.getElementsByTagNameNS(G3,name), ...el.getElementsByTagNameNS(G2,name)];

        const parsePosList = el => {
          const pl = gns(el,'posList'); if (!pl) return null;
          const n = pl.textContent.trim().split(/\s+/).map(Number), out = [];
          for (let i = 0; i+1 < n.length; i += 2) out.push(swapAxes ? [n[i+1],n[i]] : [n[i],n[i+1]]);
          return out.length ? out : null;
        };
        const parsePolygon = el => {
          const ext = gns(el,'exterior') || gns(el,'outerBoundaryIs'); if (!ext) return null;
          const ring = ext.firstElementChild || ext;
          const ec = parsePosList(ring); if (!ec) return null;
          const rings = [ec];
          gnsAll(el,'interior').concat(gnsAll(el,'innerBoundaryIs')).forEach(i => {
            const c = parsePosList(i.firstElementChild || i); if (c) rings.push(c);
          });
          return rings;
        };
        const parseGeom = el => {
          if (!el) return null;
          const ln = el.localName;
          if (ln === 'Point') {
            const pos = gns(el,'pos'); if (!pos) return null;
            const c = pos.textContent.trim().split(/\s+/).map(Number);
            return { type:'Point', coordinates: swapAxes ? [c[1],c[0]] : [c[0],c[1]] };
          }
          if (ln === 'Polygon') { const r = parsePolygon(el); return r ? {type:'Polygon',coordinates:r} : null; }
          if (ln === 'MultiSurface' || ln === 'MultiPolygon') {
            // Singular wrappers (GML 3.2): <surfaceMember><Polygon/></surfaceMember>
            const polys = [];
            for (const m of gnsAll(el,'surfaceMember').concat(gnsAll(el,'polygonMember'))) {
              const p = m.getElementsByTagNameNS(G3,'Polygon')[0] || m.getElementsByTagNameNS(G2,'Polygon')[0] || m.firstElementChild;
              if (p) polys.push(p);
            }
            // Plural containers (GML 3.1.1, e.g. MapServer): <surfaceMembers><Polygon/><Polygon/></surfaceMembers>
            for (const c of gnsAll(el,'surfaceMembers').concat(gnsAll(el,'polygonMembers'))) {
              polys.push(...gnsAll(c,'Polygon'));
            }
            const cs = polys.map(parsePolygon).filter(Boolean);
            return cs.length ? {type:'MultiPolygon',coordinates:cs} : null;
          }
          if (ln === 'LineString') { const c = parsePosList(el); return c ? {type:'LineString',coordinates:c} : null; }
          if (ln === 'MultiCurve' || ln === 'MultiLineString') {
            const lines = [];
            for (const m of gnsAll(el,'curveMember').concat(gnsAll(el,'lineStringMember'))) {
              const ls = m.getElementsByTagNameNS(G3,'LineString')[0] || m.getElementsByTagNameNS(G2,'LineString')[0] || m.firstElementChild;
              if (ls) lines.push(ls);
            }
            for (const c of gnsAll(el,'curveMembers').concat(gnsAll(el,'lineStringMembers'))) {
              lines.push(...gnsAll(c,'LineString'));
            }
            const cs = lines.map(parsePosList).filter(Boolean);
            return cs.length ? {type:'MultiLineString',coordinates:cs} : null;
          }
          return null;
        };

        const members = [...dom.getElementsByTagNameNS(W2,'member'), ...dom.getElementsByTagNameNS(W1,'member'),
                         ...dom.getElementsByTagNameNS(G3,'featureMember'), ...dom.getElementsByTagNameNS(G2,'featureMember')];
        const features = [];
        for (const member of members) {
          const fe = member.firstElementChild; if (!fe) continue;
          const props = {};
          // Search for geometry anywhere in the feature using known GML geometry types
          const GEOM_TYPES = ['MultiSurface','MultiPolygon','Polygon','Point','LineString','MultiCurve','MultiLineString'];
          let geometry = null;
          for (const gtype of GEOM_TYPES) {
            const el = fe.getElementsByTagNameNS(G3, gtype)[0] || fe.getElementsByTagNameNS(G2, gtype)[0];
            if (el) { geometry = parseGeom(el); if (geometry) break; }
          }
          // Collect leaf-text properties (skip elements that contain child elements)
          for (const child of fe.children) {
            if (!child.firstElementChild) props[child.localName] = child.textContent.trim();
          }
          if (geometry) features.push({type:'Feature', geometry, properties:props});
        }
        // Return even if empty — valid server response with 0 features in view
        return {type:'FeatureCollection', features};
      } catch(_) { return null; }
    };

    /* One toast per failure EPISODE, not per failed request — the same latch the WMS layer
       keeps in _notifyErr, and this was the only reporting path in the app without one. It
       matters more here than anywhere else: an 'error' toast skips the cooldown in toastMsg
       AND is exempt from its FIFO cap, so nothing at all was holding these back, and a layer
       that fails on one gesture fails on every gesture. The server's exception text is part of
       the message, so a server that varies it (a request id, a timestamp) slipped past even the
       identical-text dedupe and every failure added another toast.
       Logged as well as shown, which the WMS path already did and this one did not: a WFS
       failure reached the diagnostic report nowhere, so a report taken while these were
       covering the screen came back clean.
       The latch is per layer, so several failing layers still produce several reports: the toast
       side of that is collected by _reportWfsError, the log side deliberately is not. */
    const _errOnce = msg => {
      // Same rule: a stale generation still has to give the queue back before it walks away.
      if (reqId !== this._reqId) { _done(); return; }
      /* Before the latch, deliberately: a view whose request FAILED must not count as covered,
         or the guard would treat the failure as a fetched result and never retry it. The latch
         below rations the toast, it must not ration this. */
      this._fetchedBounds = null;
      if (this._errShown) return;
      this._errShown = true;
      _reportLayerError(this._name(), msg);
      console.warn('[giscatasto] WFS ' + this._name() + ' failed:', msg, '|', this._wfsUrl);
      _done();   // a failure ends this layer's turn as surely as a success does
    };

    /* ⚠ Instrumented on purpose, and the reason is worth keeping. A single 8 s block in the field
       had two candidates that the report could not tell apart: an unchunked parse of a
       contour-heavy reply, or the notice dialog sitting on screen — a modal holds the main thread
       and lands in the long-task figures exactly like real work does. The cost model predicted
       ~8.2 s for 750 contour features against 7987 ms measured, which matched far too well to
       settle by argument. So a slow parse now names itself: layer, duration, payload size. A
       wrapper rather than four edits, because _parse returns from four different places and every
       one of them had to be covered. */
    const _PARSE_SLOW_MS = 1000;
    const _parse = text => {
      const _t0 = Date.now();
      try { _parseTimed(text); }
      finally {
        const _ms = Date.now() - _t0;
        if (_ms >= _PARSE_SLOW_MS && typeof nvLog === 'function') {
          nvLog('slow parse', this._name(), (_ms / 1000).toFixed(1) + 's',
                Math.round((text ? text.length : 0) / 1024) + ' KB');
        }
      }
    };
    const _parseTimed = text => {
      // Superseded before the parse even began — the queue must not be held for it either.
      if (reqId !== this._reqId) { _done(); return; }
      // Try JSON first (GeoServer, QGIS Server, etc.)
      try { _render(JSON.parse(text)); return; } catch(_) {}
      // GML fallback: OL parser first (standard GML), then manual DOM parser (MapServer / non-standard NS)
      const swapAxes = geoUrn || (ver >= 2.0 && geoEpsg); // WFS 2.0 geographic CRS returns lat,lon
      /* writeFeatures() + JSON.parse() used to sit here: the parsed features were serialised to a
         GeoJSON STRING and immediately parsed back into the objects they had just been. Measured
         on the bench at 170 ms of the 1706 ms a 2000-feature reply costs — 10%, spent to arrive
         where the data already was. writeFeaturesObject() returns the object directly and skips
         both legs. Same OL version, same output shape, one less round trip. */
      const _olToGeoJson = feats => {
        const w = new ol.format.GeoJSON();
        return typeof w.writeFeaturesObject === 'function'
          ? w.writeFeaturesObject(feats, { featureProjection: 'EPSG:4326' })
          : JSON.parse(w.writeFeatures(feats, { featureProjection: 'EPSG:4326' }));
      };
      if (window.ol && ol.format) {
        try {
          const feats = new ol.format.WFS().readFeatures(text, { featureProjection: 'EPSG:4326' });
          if (feats && feats.length) { _render(_olToGeoJson(feats)); return; }
        } catch(_) {}
        try {
          const feats = ol.format.GML32 ? new ol.format.GML32().readFeatures(text, { featureProjection: 'EPSG:4326' }) : [];
          if (feats && feats.length) { _render(_olToGeoJson(feats)); return; }
        } catch(_) {}
      }
      const geojson = _parseGmlManual(text, swapAxes);
      if (geojson !== null) { _render(geojson); return; } // null = not a FeatureCollection (error response)
      // Diagnostic: show what root element the server actually returned
      try {
        const _d = new DOMParser().parseFromString(text, 'application/xml');
        const _root = _d.documentElement;
        const _exc = _d.querySelector('ExceptionText,exceptionText');
        const _hint = (this.options.filterAttr && this.options.filterVals)
          ? ' — filtro attivo: verifica il nome dell’attributo e la versione WFS' : '';
        _errOnce(this._name() + ': il server ha risposto <' + _root.localName + '>' + (_exc ? ': ' + _exc.textContent.substring(0,60) : '') + _hint);
      } catch(_) { _errOnce(this._name() + ': risposta non valida'); }
    };

    /* Abort the previous request outright rather than only ignoring its answer. The reqId check
       already discarded a stale RESPONSE, which is all an image needs — but a WFS reply is text
       that has to be parsed, and dropping it after the fact means the download completed and the
       parse ran in full for a view the user had already left. Under GPS follow that is a refresh
       a second, each one paying up to 1700 ms of main thread for features nobody will see.
       Only the fetch path can be aborted: cordova.plugin.http has no cancel, so there the reqId
       check stays the whole defence. That is a real gap and it is the busier path on the device —
       but the parse guard behind it is the same one, so the worst case is what happens today. */
    try { if (this._abort) this._abort.abort(); } catch(_) {}
    this._abort = (typeof AbortController === 'function') ? new AbortController() : null;
    const _signal = this._abort ? this._abort.signal : undefined;
    /* The request goes out now, in parallel with every other layer's; only the REPLY waits its
       turn to be read. A transport failure never enters the queue — there is nothing to parse —
       so it is reported straight away and holds nobody up. */
    /* The cycle starts HERE, when the first request goes out — not when a parse begins. This is the
       moment the user's wait starts. _wfsInFlight is what tells the cycle it is not over yet while
       replies are still on their way. */
    _wfsCycleBegin();
    _wfsInFlight++;
    let landed = false;
    const _arrived = () => { if (landed) return; landed = true; _wfsArrivedThisCycle++; _wfsInFlight = Math.max(0, _wfsInFlight - 1); };
    if (window.cordova && cordova.plugin && cordova.plugin.http) {
      cordova.plugin.http.sendRequest(url, { method:'get', responseType:'arraybuffer' },
        res => { _arrived(); _wfsEnqueueParse(this, () => _parse(_decodeXmlBuffer(res.data))); },
        /* ⚠ The error callback RECEIVES the response body on a non-2xx, and this one used to
           throw it away. Measured cost, 02/09: IGM's us:OilGasAppurtenance answers 400 to every
           request — its mapfile names a geometry column ('shape') that the PostGIS table does not
           have — and for a whole ride the layer reported itself as a bare "richiesta non riuscita"
           while the server had already explained the fault in 601 bytes of ows:ExceptionReport.
           Since _errShown is only re-armed by a GOOD response, that one toast at second 4 was the
           only word the user ever got about a layer that stayed dead and kept being retried.
           The fetch path below never had this blind spot: fetch RESOLVES on a 400, so the body
           reaches _parse and comes back out as the <ExceptionReport> message it builds. Only the
           cordova transport took the blind path — i.e. only the device, never the bench, which is
           why it went unseen for so long.
           The status is the reliable half and goes in first; the exception text is best effort,
           since the plugin's body arrives as an opaque field. Truncated at 60 like the parse-side
           diagnostic above, because _errOnce feeds the toast and the log the same string. */
        err => {
          _arrived();
          if (reqId === this._reqId) {
            let detail = 'richiesta non riuscita';
            if (err && err.status) detail += ' (HTTP ' + err.status + ')';
            try {
              const _exc = new DOMParser()
                .parseFromString(String((err && err.error) || ''), 'application/xml')
                .querySelector('ExceptionText,exceptionText');
              if (_exc) detail += ': ' + _exc.textContent.trim().substring(0, 60);
            } catch(_) {}
            _errOnce(this._name() + ': ' + detail);
          }
          _wfsCycleMaybeEnd();   // a failure can be what completes the cycle
        }
      );
    } else {
      fetch(url, { signal: _signal }).then(r => r.arrayBuffer())
        .then(buf => { _arrived(); _wfsEnqueueParse(this, () => _parse(_decodeXmlBuffer(buf))); })
        .catch(e => {
          _arrived();
          // An abort is this code's own doing, not a failure worth telling the user about.
          if (e && e.name !== 'AbortError' && reqId === this._reqId) {
            _errOnce(this._name() + ': richiesta non riuscita');
          }
          _wfsCycleMaybeEnd();
        });
    }
  }
});

/* isOverlay decides only the pane a WMS layer renders into (overlay z260 vs basemap
   z250); both use the same Leaflet _WMSImageLayer. If omitted, auto-detected from
   cfg.useAs === 'overlay' (config restore). */
/* Can this WMS be served as tiles?
   "Tiled" is not a property of the server: any WMS answers a GetMap for whatever bounding box
   it is given, so asking for one screen-sized image or for twenty 256 px squares is the
   client's choice. What the choice depends on is the CRS — a tile layer can only request in
   the map's own system, Web Mercator — and the declared list of supported CRS is not
   trustworthy (some services answer 3857 without advertising it, others advertise it and
   fail). So the question is settled by measurement: ask for one real tile and see whether a
   decodable image comes back. An <img> is used rather than fetch() because it needs no CORS —
   the server's cooperation is exactly what is being tested, not its headers.
   It matters because only a tiled layer can be taken offline: the downloader has no way to
   store a single viewport-sized image. */
function _probeWmsTiled(url, layers, version, minZoom, cb) {
  let done = false;
  const finish = ok => { if (!done) { done = true; cb(ok); } };
  try {
    const z = Math.max(minZoom || 0, (map && map.getZoom && map.getZoom()) || 15);
    const c = (map && map.getCenter) ? map.getCenter() : L.latLng(42, 12);
    const n = Math.pow(2, z);
    const tx = Math.floor((c.lng + 180) / 360 * n);
    const la = c.lat * Math.PI / 180;
    const ty = Math.floor((1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 * n);
    const m = (xt, yt) => {
      const lo = xt / n * 360 - 180;
      const lt = Math.atan(Math.sinh(Math.PI * (1 - 2 * yt / n))) * 180 / Math.PI;
      return [lo * 20037508.34 / 180,
              Math.log(Math.tan((90 + lt) * Math.PI / 360)) / (Math.PI / 180) * 20037508.34 / 180];
    };
    const sw = m(tx, ty + 1), ne = m(tx + 1, ty);
    const sp = _splitOgcUrl(url.split('#')[0]);
    const ver = version || '1.1.1';
    const q = {
      SERVICE: 'WMS', VERSION: ver, REQUEST: 'GetMap',
      LAYERS: layers, STYLES: '', FORMAT: 'image/png', TRANSPARENT: 'FALSE',
      BGCOLOR: '0xFFFFFF', WIDTH: 256, HEIGHT: 256,
      BBOX: [sw[0], sw[1], ne[0], ne[1]].join(',')
    };
    // 1.3.0 renamed SRS to CRS. Sending the wrong one gets the request refused for a reason
    // that has nothing to do with the question being asked — which is how this probe first
    // reported the Agenzia delle Entrate service as unable to serve Web Mercator.
    q[parseFloat(ver) >= 1.3 ? 'CRS' : 'SRS'] = 'EPSG:3857';
    const probeUrl = sp.base.replace(/\/$/, '') + '?' + (sp.pre ? sp.pre + '&' : '') +
      Object.entries(q).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
    const img = new Image();
    img.onload  = () => finish(img.naturalWidth >= 8 && img.naturalHeight >= 8);
    img.onerror = () => finish(false);   // an XML ServiceException does not decode as an image
    setTimeout(() => finish(false), 8000);
    img.src = probeUrl;
  } catch (_) { finish(false); }
}

function _createLayer(cfg, token, isOverlay) {
  if (isOverlay === undefined) isOverlay = (cfg.useAs === 'overlay');
  const url = cfg.url.replace(/\/?$/, '');
  switch (cfg.type) {
    case 'wfs': {
      if (!cfg.layers) throw new Error('Per il WFS serve il nome del tipo — usa “Leggi i layer”');
      return new _WFSLayer(cfg.url, {
        typeName: cfg.layers, version: cfg.version || '2.0.0',
        minZoom: cfg.minZoom !== undefined ? cfg.minZoom : 15,
        crs: cfg.crs || null,
        filterAttr: cfg.filterAttr || '',
        filterVals: cfg.filterVals || '',
        attribution: cfg.name, opacity: cfg.opacity !== undefined ? cfg.opacity / 100 : 0.8,
        color: cfg.color || null,
        hollow: cfg.hollow || false,
        fillOpacity: cfg.fillOpacity !== undefined ? cfg.fillOpacity : null,
        pane: cfg.pane || null,
        jsonSupported: cfg.jsonSupported !== false
      });
    }
    case 'wms': {
      if (!cfg.layers) throw new Error('Per il WMS serve il nome del layer — usa “Leggi i layer”');
      // Keep the query string (MapServer ?map=...); _WMSImageLayer splits OGC params off.
      const wmsUrl = cfg.url.split('#')[0];

      /* Basemap and overlay both render through _WMSImageLayer (an L.imageOverlay in a
         dedicated Leaflet pane). This keeps the overlay inside the pane hierarchy, so its
         z-index is comparable with the basemap (250) and the vectors (400+): overlay at
         260 sits above the basemap and below KML/drawings/WFS. The ws-crs dropdown is
         already restricted to geographic CRS (+3857), the only cases this renderer can
         honour without reprojection — the reprojection error over one viewport is far
         below one pixel and the cadastral 6 m, so OpenLayers is not needed to draw. */
      const _crsCode = cfg.crs || 'EPSG:4326';
      const _isGeo   = /^EPSG:(4326|4258|6706)$/.test(_crsCode) || _crsCode === 'CRS:84';
      // A non-Web-Mercator overlay is stretched onto the Web Mercator map by one linear
      // imageOverlay: the mismatch is negligible zoomed in (~0.01 px at z17) but blows up
      // zoomed out (~4 px / ~1.9 km at z8). Floor the overlay minZoom to 8 unless the
      // source is Web Mercator (no reprojection, no error). This runs for every overlay —
      // bundled, user-added via "Add web map", and layers restored from an older install
      // (their saved crs, or geographic when none was stored) — so the guard is universal.
      const _isWebMerc = /3857|900913|3785|102100/.test(_crsCode);
      let _ovMinZoom = (cfg.minZoom != null) ? cfg.minZoom : null;
      if (isOverlay && !_isWebMerc) _ovMinZoom = Math.max(_ovMinZoom || 0, 8);
      const lyr = new _WMSImageLayer(wmsUrl, {
        layers: cfg.layers, version: cfg.version || (isOverlay ? '1.3.0' : '1.1.1'),
        /* Transparency follows the ROLE, not the service. An overlay must let what is under
           it show through; a basemap has nothing under it but the app's dark background, and
           asking a paper map for a transparent image is what turns white paper into holes and
           leaves black line work on a black backdrop — the "negative" effect found on the
           bundled CTRs, which are cabled opaque in the config. A user-added regional map went
           through this branch instead and kept inheriting the defect. */
        transparent: isOverlay, bgcolor: cfg.bgcolor || '0xFFFFFF', format: 'image/png',
        attribution: cfg.name, opacity: 0.8,
        crs: _crsCode === 'EPSG:3857' ? L.CRS.EPSG3857 : L.CRS.EPSG4326,
        crsCode: _crsCode, geoAxes: _isGeo,
        // Gate the request by the layer's own scale window, basemap included: below it the
        // service has nothing to draw, and a spoken "zoom in" beats a silent empty frame.
        // Non-Web-Mercator overlays are additionally floored to z8 by _ovMinZoom above.
        minZoom: _ovMinZoom,
        pane:       isOverlay ? 'wms-overlay' : 'wms-basemap-img',
        paneZIndex: isOverlay ? 260 : 250
      });
      // Mark overlays as raster so the legend omits colour/hollow controls and skips
      // zoom-to-extent (a full-viewport image has no intrinsic bounds).
      if (isOverlay) lyr._isRaster = true;
      return lyr;
    }
    case 'wmts':
      return L.tileLayer(url, { attribution: cfg.name, maxZoom: 21 });
    /* Written only by the offline downloader (offline.js), never by "Add web map": a WMS
       saved for offline use is tiled, so it must come back as a tile layer that rebuilds
       the same BBOX URLs, not as the single-image overlay a user-added WMS becomes. */
    case 'wms_tiles': {
      const wp = L.extend({}, cfg.wmsParams || {});
      delete wp.crs; delete wp.srs;
      return L.tileLayer.wms(cfg.url, L.extend(wp, {
        attribution: cfg.name,
        uppercase: !!cfg.uppercase,
        // Some regional services only draw inside a scale window and answer with a blank
        // image below it (the Liguria CTR starts at ~z16). Not requesting at all is both
        // honest and cheaper than painting empty tiles.
        minZoom: cfg.minZoom != null ? cfg.minZoom : undefined,
        maxZoom: cfg.maxZoom || 21, maxNativeZoom: cfg.maxZoom || undefined
      }));
    }
    case 'arcgis': {
      const tUrl = url + '/tile/{z}/{y}/{x}' + (token ? '?token=' + token : '');
      return L.tileLayer(tUrl, { attribution: cfg.name, maxZoom: 21 });
    }
    default: throw new Error('Unsupported type: ' + cfg.type);
  }
}

async function _fetchServiceInfo(url) {
  try {
    const r = await fetch(url.replace(/\/?$/, '') + '?f=json');
    if (r.status === 401 || r.status === 403) return { isProtected: true, wkid: null };
    const j = await r.json();
    const isProtected = !!(j.error && (j.error.code === 499 || j.error.code === 403 || j.error.code === 401));
    const wkid = j.spatialReference?.wkid ?? j.spatialReference?.latestWkid ?? null;
    return { isProtected, wkid };
  } catch(e) { return { isProtected: false, wkid: null }; }
}

function _applyBasemap(id, layer) {
  /* A regional technical map is ink on paper, and it only draws inside its design scale:
     below its minZoom Leaflet requests nothing and the container shows through. On the dark
     app background that reads as a broken map, so while one of these is active the map sits
     on paper white — out of scale then looks like a blank sheet, which is what it is. */
  /* Same reasoning for a WMS a user added themselves: it was tied to group === 'regionale',
     which only the bundled entries carry, so a CTR added from "Aggiungi mappa web" fell back
     to the dark container. The role is what decides — any WMS serving as the basemap is now
     requested opaque on white (see _createLayer), so the sheet under it must match. */
  try {
    const _cfg = (typeof customMapConfigs !== 'undefined')
      ? customMapConfigs.find(c => c.id === id) : null;
    const _paper = !!_cfg && (_cfg.group === 'regionale' ||
                              _cfg.type === 'wms' || _cfg.type === 'wms_tiles');
    const _el = document.getElementById('map');
    if (_el) _el.classList.toggle('paper-basemap', _paper);
  } catch(_) {}
  try { map.removeLayer(currentBasemap); } catch(e) {}
  currentBasemap = layer; currentBasemapId = id;
  try { layer.addTo(map); } catch(e) { toastMsg('Errore nel caricamento della mappa', 'error'); return; }
  try { if (layer.bringToBack) layer.bringToBack(); } catch(e) {}
  try { localStorage.setItem('giscatasto_basemap', id); } catch(_) {}
}

function switchBasemap(id) {
  const entry = BASEMAPS[id];
  if (!entry) return;
  if (entry._needsCreds) {
    const prevId = currentBasemapId;
    showCredModal(entry._cfg, token => {
      try {
        const layer = _createLayer(entry._cfg, token);
        BASEMAPS[id] = layer; _applyBasemap(id, layer);
        document.querySelector(`input[name="basemap"][value="${id}"]`).checked = true;
      } catch(e) {
        toastMsg('Errore: ' + e.message, 'error');
        document.querySelector(`input[name="basemap"][value="${prevId}"]`).checked = true;
      }
    }, () => {
      document.querySelector(`input[name="basemap"][value="${prevId}"]`).checked = true;
    });
    return;
  }
  _applyBasemap(id, entry);
}

document.querySelectorAll('input[name="basemap"]').forEach(radio => {
  radio.addEventListener('change', () => switchBasemap(radio.value));
});

/* Regional cartography gets its own collapsible block: it is a set of EXAMPLES, not national
   coverage, and eight more rows in the flat list would bury the general basemaps.
   They stay radio inputs INSIDE #basemap-list on purpose: the offline downloader builds its
   source list by walking those radios, so moving them into a <select> would quietly make them
   undownloadable — the one thing they are wired as tiles for. */
function _regionalGroup() {
  let det = document.getElementById('basemap-regional');
  if (!det) {
    det = document.createElement('details');
    det.id = 'basemap-regional';
    det.className = 'basemap-group';
    det.innerHTML =
      '<summary>Cartografia regionale — esempi</summary>' +
      '<p class="hint">Carte tecniche di alcune regioni, a titolo di esempio: non è una copertura ' +
      'nazionale. Le altre regioni si aggiungono da “Aggiungi mappa web”.</p>' +
      '<div class="basemap-group-body"></div>';
    document.getElementById('basemap-list').appendChild(det);
  }
  return det;
}

function _addBasemapUI(cfg) {
  const { id, name } = cfg;
  const isRegional = cfg.group === 'regionale';
  const list = isRegional
    ? _regionalGroup().querySelector('.basemap-group-body')
    : document.getElementById('basemap-list');
  const label = document.createElement('label');
  label.className = 'basemap-item basemap-item-custom';
  label.innerHTML =
    `<input type="radio" name="basemap" value="${id}">` +
    `<span>${name}${cfg.protected ? ' \uD83D\uDD12' : ''}</span>` +
    `<button class="bm-del" title="Rimuovi la mappa">\u2715</button>`;
  label.querySelector('input').addEventListener('change', () => switchBasemap(id));
  label.querySelector('.bm-del').addEventListener('click', async ev => {
    ev.preventDefault(); ev.stopPropagation();
    // Offline basemaps own a downloaded tile cache — confirm before removing,
    // since it means a full re-download to get the area back.
    const cfgEntry = customMapConfigs.find(c => c.id === id);
    const isOffline = !!(cfgEntry && cfgEntry.offline);
    if (isOffline) {
      if (!confirm('Rimuovere questa mappa offline? I tile scaricati vengono eliminati e l’area andrà riscaricata.')) return;
    } else if (!confirm('Rimuovere questa mappa? Se non è salvata nella tua configurazione dovrai aggiungerla di nuovo.')) {
      return;
    }
    if (currentBasemapId === id) {
      try { map.removeLayer(currentBasemap); } catch(e) {}
      currentBasemap = BASEMAPS.osm_std; currentBasemapId = 'osm_std';
      currentBasemap.addTo(map);
      try { currentBasemap.bringToBack(); } catch(e) {}
      document.querySelector('input[name="basemap"][value="osm_std"]').checked = true;
    }
    const entry = BASEMAPS[id];
    if (entry && !entry._needsCreds) { try { map.removeLayer(entry); } catch(e) {} }
    delete BASEMAPS[id];
    const idx = customMapConfigs.findIndex(c => c.id === id);
    if (idx !== -1) customMapConfigs.splice(idx, 1);
    // Remember the deletion the way an overlay does, otherwise a bundled basemap is
    // re-imported at the next launch and the removal quietly undoes itself — with the
    // downloaded tiles of an offline map already gone. Reversible from
    // Configurazione mappe › Ripristina i predefiniti eliminati.
    if (cfgEntry && typeof _addRemovedDefault === 'function') _addRemovedDefault(_sigOf(cfgEntry));
    _autoSaveConfig();
    label.remove();
    // Free the dedicated offline cache and tell the SW its offline list changed.
    if (isOffline && window.caches) {
      try { await caches.delete('giscatasto-offline-' + id); } catch(e) {}
      try {
        if (navigator.serviceWorker && navigator.serviceWorker.controller) {
          navigator.serviceWorker.controller.postMessage({ type: 'offlineChanged' });
        }
      } catch(e) {}
    }
    toastMsg('Mappa rimossa', 'success');
  });
  list.appendChild(label);
  // Keep the regional block last, so a map the user adds later does not end up below it.
  const det = document.getElementById('basemap-regional');
  if (det && !isRegional) document.getElementById('basemap-list').appendChild(det);
  return label;
}

/* ===== WMS / WFS FORM ===== */
(function initWsForm() {
  const typeEl    = document.getElementById('ws-type');
  const layersF   = document.getElementById('ws-layers-field');
  const verF      = document.getElementById('ws-ver-field');
  const toggleBtn = document.getElementById('ws-toggle-btn');
  const form      = document.getElementById('ws-form');

  function syncFields() {
    const t = typeEl.value;
    const isWms = t === 'wms';
    const isWfs = t === 'wfs';
    layersF.style.display = (isWms || isWfs) ? '' : 'none';
    verF.style.display    = (isWms || isWfs) ? '' : 'none';
    document.getElementById('ws-crs-field').style.display = (isWms || isWfs) ? '' : 'none';
    document.getElementById('ws-minzoom-field').style.display = isWfs ? '' : 'none';
    document.getElementById('ws-filter-field').style.display = isWfs ? '' : 'none';
    document.getElementById('ws-filter-vals-field').style.display = isWfs ? '' : 'none';
    document.getElementById('ws-layers-select').style.display = 'none';
    // Tile pyramids (XYZ/WMTS, ArcGIS tile caches) are normally finished cartographic
    // products, so default them to basemap. WMS is the composable one — LAYERS plus
    // TRANSPARENT, usually vector rasterized on demand — and stays on overlay. This is a
    // default and not a rule: transparent pyramids (hillshade, labels) are legitimate
    // overlays, so the choice is left open.
    const useEl = document.getElementById('ws-use');
    if (useEl) {
      const ovOpt = useEl.querySelector('option[value="overlay"]');
      if (ovOpt) ovOpt.disabled = false;
      if (t === 'wmts' || t === 'arcgis') useEl.value = 'basemap';
    }
    // Reset CRS dropdown on type change — capabilities will repopulate it after "Get layers"
    const _crsEl = document.getElementById('ws-crs');
    if (_crsEl) {
      const _defaults = { wms: 'EPSG:4258', wfs: 'EPSG:4258' };
      _crsEl.innerHTML = `<option value="${_defaults[t] || 'EPSG:4326'}">${_defaults[t] || 'EPSG:4326'}</option>`;
    }

    // Update version label + options based on protocol
    const verSel = document.getElementById('ws-version');
    const verLbl = document.getElementById('ws-ver-label');
    if (isWfs) {
      verLbl.textContent = 'WFS version';
      const cur = verSel.value;
      verSel.innerHTML =
        '<option value="2.0.0">2.0.0 (recommended)</option>' +
        '<option value="1.1.0">1.1.0</option>' +
        '<option value="1.0.0">1.0.0</option>';
      if (['2.0.0','1.1.0','1.0.0'].includes(cur)) verSel.value = cur;
    } else {
      verLbl.textContent = 'WMS version';
      const cur = verSel.value;
      verSel.innerHTML =
        '<option value="1.1.1">1.1.1</option>' +
        '<option value="1.3.0">1.3.0</option>';
      if (['1.1.1','1.3.0'].includes(cur)) verSel.value = cur;
    }

    const hints = {
      wms:    'Solo l’indirizzo base — per esempio<br><code style="font-size:10px;word-break:break-all">https://wms.cartografia.agenziaentrate.gov.it/inspire/wms/ows01.php</code><br>Puoi incollare anche un URL di GetCapabilities: i parametri OGC vengono tolti, il <code>?map=...</code> di MapServer resta. Tocca <b>Leggi i layer</b> per ricavare nomi, CRS e versione.',
      wfs:    'Solo l’indirizzo base — per esempio<br><code style="font-size:10px;word-break:break-all">https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php</code><br>Il GetCapabilities compila layer, CRS e versione. Con i server che rispondono solo in GML, tocca <b>Leggi i layer</b> prima di <b>Aggiungi</b>.',
      wmts:   'Modello di URL con {z}/{x}/{y} &mdash; per esempio https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      arcgis: 'URL fino a .../MapServer &mdash; per esempio https://server/.../MapServer'
    };
    document.getElementById('ws-hint').innerHTML = hints[t] || '';
  }
  typeEl.addEventListener('change', syncFields);
  syncFields();

  toggleBtn.addEventListener('click', () => {
    const open = form.style.display !== 'none';
    form.style.display = open ? 'none' : 'flex';
    toggleBtn.innerHTML = open
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Aggiungi mappa web'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"/></svg> Chiudi';
  });

  function _fillSelect(sel, values, selected) {
    sel.innerHTML = '';
    values.forEach(v => {
      const o = document.createElement('option');
      o.value = v; o.textContent = v;
      if (selected !== undefined && v === selected) o.selected = true;
      sel.appendChild(o);
    });
  }

  document.getElementById('btn-ws-caps').addEventListener('click', () => {
    const url = document.getElementById('ws-url').value.trim();
    const type = typeEl.value;
    if (!url) { toastMsg('Scrivi prima l’URL', 'error'); return; }
    if (type !== 'wms' && type !== 'wfs') {
      toastMsg('“Leggi i layer” funziona solo con WMS e WFS', 'error');
      return;
    }
    const capsBtn = document.getElementById('btn-ws-caps');
    capsBtn.disabled = true; capsBtn.textContent = '…';
    const _sp = _splitOgcUrl(url);
    const _prefix = _sp.pre ? _sp.pre + '&' : '';
    const capsUrl = type === 'wms'
      ? _sp.base + '?' + _prefix + 'SERVICE=WMS&REQUEST=GetCapabilities'
      : _sp.base + '?' + _prefix + 'SERVICE=WFS&REQUEST=GetCapabilities';

    function _done() { capsBtn.disabled = false; capsBtn.textContent = 'Leggi i layer'; }

    function _parseCaps(text) {
      const xml = new DOMParser().parseFromString(text, 'text/xml');
      if (xml.querySelector('parsererror')) { toastMsg('XML non valido dal server', 'error'); return; }

      let names = [];
      if (type === 'wms') {
        // getElementsByTagName works with WMS 1.3.0 namespaces
        names = [...xml.getElementsByTagName('Name')]
          .filter(el => {
            const p = el.parentNode;
            return p && (p.nodeName === 'Layer' || p.localName === 'Layer');
          })
          .map(el => el.textContent.trim()).filter(Boolean);
      } else if (type === 'wfs') {
        // WFS FeatureTypeList / FeatureType / Name
        const ftList = xml.getElementsByTagName('FeatureType');
        names = [...ftList]
          .map(ft => {
            const n = ft.getElementsByTagName('Name')[0];
            return n ? n.textContent.trim() : '';
          })
          .filter(Boolean);
      }

      if (!names.length) {
        toastMsg('Nessun layer trovato', 'error');
        return;
      }

      const sel = document.getElementById('ws-layers-select');
      _fillSelect(sel, names, names[0]);
      sel.style.display = '';
      sel.onchange = () => {
        document.getElementById('ws-layers').value = sel.value;
        if (type === 'wms') _showScaleHint(sel.value);
      };
      document.getElementById('ws-layers').value = names[0];

      // Normalize any EPSG CRS form → EPSG:xxxx
      // Handles: EPSG:4258, urn:ogc:def:crs:EPSG::4258, urn:...EPSG:6.9:4258, http://.../EPSG/0/4258
      const _normCrs = raw => {
        const m = raw.match(/EPSG.*?[:\s\/](\d+)\s*$/i);
        return m ? 'EPSG:' + m[1] : raw.toUpperCase();
      };

      /* ── Scale window → zoom range ──
         A WMS layer declares the scale range it draws at; outside it the server answers
         with a valid but empty image, which is indistinguishable from a broken layer.
         (Agenzia Entrate CP.CadastralParcel: MaxScaleDenominator 5000 → nothing below
         zoom 17.) The number is already in the capabilities we fetch, so surface it.
         Only WMS 1.3.0 ScaleDenominator is read: the 1.1.1 ScaleHint means the diagonal
         of a pixel and is implemented inconsistently across servers, so it is skipped
         rather than guessed at. */
      const _scaleToZoom = (denom, lat) =>
        Math.log2(156543.03392 * Math.cos(lat * Math.PI / 180) / (denom * 0.00028));

      // Scale limits are inheritable in WMS: walk up the Layer chain until one is declared.
      const _scaleWindow = name => {
        const target = [...xml.getElementsByTagName('Layer')].find(L =>
          [...L.children].some(c => c.localName === 'Name' && c.textContent.trim() === name));
        if (!target) return null;
        let min = null, max = null;
        for (let el = target; el && el.localName === 'Layer'; el = el.parentNode) {
          for (const c of el.children) {
            if (min === null && c.localName === 'MinScaleDenominator') min = parseFloat(c.textContent);
            if (max === null && c.localName === 'MaxScaleDenominator') max = parseFloat(c.textContent);
          }
          if (min !== null && max !== null) break;
        }
        return (min || max) ? { min, max } : null;
      };

      const _showScaleHint = name => {
        const el = document.getElementById('ws-scale-hint');
        if (!el) return;
        el.textContent = ''; el.style.display = 'none';
        _wmsMinZoomByLayer[url + '|' + name] = null;   // cleared unless a scale window is found
        try {
          const w = _scaleWindow(name);
          if (!w) return;
          const lat  = map.getCenter().lat;
          const zMin = w.max ? Math.ceil(_scaleToZoom(w.max, lat))  : null;
          const zMax = w.min ? Math.floor(_scaleToZoom(w.min, lat)) : null;
          // Remember the lower bound so Add can gate the overlay's requests to this range.
          if (zMin != null && isFinite(zMin)) _wmsMinZoomByLayer[url + '|' + name] = zMin;
          const parts = [];
          if (zMin !== null) parts.push('dallo zoom ' + zMin);
          if (zMax !== null) parts.push('fino allo zoom ' + zMax);
          if (!parts.length) return;
          // Bold-italic so the visibility window and the zoom reminder stand out. Text is
          // built only from computed integers (no server-supplied strings) → innerHTML is safe.
          el.innerHTML = '<b><i>Questo layer viene disegnato ' + parts.join(', ') +
                         ' — fuori da quell’intervallo il server restituisce un’immagine vuota. ' +
                         'Zooma sulla tua area dentro questo intervallo per vederlo.</i></b>';
          el.style.display = '';
        } catch(_) { /* hint only: never break the capabilities flow */ }
      };

      if (type === 'wms') {
        _showScaleHint(names[0]);

        /* Adopt the version the server declares on the capabilities root:
           <WMS_Capabilities version="1.3.0"> or <WMT_MS_Capabilities version="1.1.1">.
           GetCapabilities is issued without VERSION, so what comes back is the highest
           the server supports — and the CRS list parsed below comes from that same
           document, so the GetMap should speak it too. Mirrors what the WFS branch does
           with ServiceTypeVersion. Only adopted if the dropdown actually offers it. */
        const _capsVer   = xml.documentElement.getAttribute('version');
        const _verSelect = document.getElementById('ws-version');
        if (_capsVer && _verSelect && [..._verSelect.options].some(o => o.value === _capsVer)) {
          _verSelect.value = _capsVer;
        }

        // Extract supported CRS/SRS from capabilities and update dropdown
        const crsCodes = [...new Set(
          [...xml.getElementsByTagName('CRS'), ...xml.getElementsByTagName('SRS')]
            .map(el => _normCrs(el.textContent.trim()))
            .filter(c => c.startsWith('EPSG:'))
        )];
        // Prefer native geographic CRS (INSPIRE servers always support 4258/4326;
        // EPSG:3857 is often advertised but BBOX-ignored for non-native requests)
        const preferred = ['EPSG:4258', 'EPSG:4326', 'EPSG:6706', 'EPSG:3857'];
        const crsSelect = document.getElementById('ws-crs');
        if (crsCodes.length) {
          // Only offer CRS the renderer can actually honour. _WMSImageLayer projects the
          // BBOX with L.CRS.EPSG4326 for anything that is not EPSG:3857, so a projected
          // CRS (UTM etc.) would ship degrees labelled as metres and the server answers
          // with an empty image. Codes advertised by the server but outside `preferred`
          // are dropped rather than listed as choices that cannot work.
          const supported = preferred.filter(c => crsCodes.includes(c));
          const all = supported.length ? supported : preferred;
          _fillSelect(crsSelect, all, all[0]);
        }
      } else if (type === 'wfs') {
        // WFS 2.0: DefaultCRS + OtherCRS per FeatureType; WFS 1.x: SRS element
        const rawCodes = [
          ...xml.getElementsByTagName('DefaultCRS'),
          ...xml.getElementsByTagName('DefaultSRS'),
          ...xml.getElementsByTagName('OtherCRS'),
          ...xml.getElementsByTagName('OtherSRS'),
          ...xml.getElementsByTagName('SRS')
        ].map(el => _normCrs(el.textContent.trim())).filter(c => c.startsWith('EPSG:'));
        const crsCodes = [...new Set(rawCodes)];
        // For INSPIRE/Italian servers: EPSG:4258 (ETRS89) is native. Geographic only — unlike the
        // WMS branch, EPSG:3857 is not offered here: _WMSImageLayer is handed an L.CRS object and
        // projects the BBOX through it, while _update concatenates map.getBounds() degrees with
        // whatever srsName is set, so a projected CRS ships degrees labelled as metres and the
        // server answers HTTP 200 with zero features — a silent miss, not an error.
        const preferred = ['EPSG:4258', 'EPSG:4326', 'EPSG:6706'];
        const crsSelect = document.getElementById('ws-crs');
        if (crsCodes.length) {
          // Same constraint as the WMS branch: the GML reader takes coordinates as
          // lat/lon degrees and proj4 is registered for OpenLayers only, so features
          // requested in a projected CRS would land off-map. Offer only what the
          // reader can consume.
          const supported = preferred.filter(c => crsCodes.includes(c));
          const all = supported.length ? supported : preferred;
          // DefaultCRS is listed first in rawCodes — honour it only if it survived the
          // filter, otherwise fall back to the first offered code rather than selecting
          // a value that is no longer in the list.
          const defaultCrs = rawCodes[0];
          const selCrs = all.includes(defaultCrs) ? defaultCrs : all[0];
          _fillSelect(crsSelect, all, selCrs);
        }
        // Output format support: scan WFS 1.x <Format> and WFS 2.0 <Parameter name="outputFormat"><Value>.
        // getElementsByTagNameNS('*', name) is namespace-agnostic — needed because PCN uses ows:Value/ows:Parameter.
        // If no format token contains "json", server is GML-only (e.g. MapServer) → skip outputFormat=json in GetFeature.
        const fmtTexts = [
          ...[...xml.getElementsByTagNameNS('*', 'Format')].map(el => el.textContent),
          ...[...xml.getElementsByTagNameNS('*', 'Value')].filter(v => {
            const par = v.parentNode;
            return par && par.localName === 'Parameter' && (par.getAttribute('name') || '').toLowerCase() === 'outputformat';
          }).map(el => el.textContent)
        ].map(t => t.trim().toLowerCase()).filter(Boolean);
        const jsonSupported = fmtTexts.length === 0 || fmtTexts.some(t => t.includes('json'));
        // Auto-select WFS version from <ows:ServiceTypeVersion> if dropdown lists it (PCN advertises only 1.1.0)
        const verEl = xml.getElementsByTagNameNS('*', 'ServiceTypeVersion')[0];
        let capsVersion = null;
        if (verEl) {
          const v = verEl.textContent.trim();
          const verSelect = document.getElementById('ws-version');
          if (verSelect && [...verSelect.options].some(o => o.value === v)) {
            verSelect.value = v;
            capsVersion = v;
          }
        }
        _wfsCapsByUrl[url] = { jsonSupported, version: capsVersion };
        if (!jsonSupported) toastMsg('Server: solo GML, il GeoJSON non è dichiarato', 'warn');
      }

      toastMsg(names.length === 1 ? '1 layer trovato' : names.length + ' layer trovati', 'success');
    }

    function _fetchViaFetch() {
      // AbortController safe (AbortSignal.timeout not available on older WebViews)
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 10000);
      fetch(capsUrl, { signal: ctrl.signal })
        .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(buf => _parseCaps(_decodeXmlBuffer(buf)))
        .catch(e => toastMsg('Connessione non riuscita: ' + e.message, 'error'))
        .finally(() => { clearTimeout(tid); _done(); });
    }

    if (window.cordova && cordova.plugin && cordova.plugin.http) {
      const doGet = () => {
        cordova.plugin.http.sendRequest(capsUrl, { method:'get', responseType:'arraybuffer' },
          res => { try { _parseCaps(_decodeXmlBuffer(res.data)); } catch(e) { toastMsg('Errore di lettura: ' + e.message, 'error'); } _done(); },
          err => {
            const detail = err ? (err.error || err.message || JSON.stringify(err)) : 'unknown';
            toastMsg('Errore del plugin: ' + detail, 'error');
            try { _fetchViaFetch(); } catch(e) { toastMsg('Errore di rete: ' + e.message, 'error'); _done(); }
          }
        );
      };
      doGet();
    } else {
      toastMsg('cordova.plugin.http non disponibile', 'warn');
      _fetchViaFetch();
    }
  });

  document.getElementById('btn-ws-add').addEventListener('click', async () => {
    const type    = typeEl.value;
    const url     = document.getElementById('ws-url').value.trim();
    const layers  = document.getElementById('ws-layers').value.trim();
    const version = document.getElementById('ws-version').value;
    const crs     = document.getElementById('ws-crs').value;
    const rawName = document.getElementById('ws-name').value.trim();
    const useAs   = (document.getElementById('ws-use') || {}).value || 'basemap';
    if (!url) { toastMsg('Scrivi l’URL', 'error'); return; }

    const addBtn = document.getElementById('btn-ws-add');
    addBtn.disabled = true;
    const id   = 'custom_ws_' + (++wsCounter);
    const name = rawName || (type.toUpperCase().replace('-',' ') + ' ' + wsCounter);

    let isProtected = false;
    if (type === 'arcgis') {
      toastMsg('Verifica dell’accesso…', '');
      const info = await _fetchServiceInfo(url);
      isProtected = info.isProtected;
    }

    const minZoomEl = document.getElementById('ws-minzoom');
    const minZoom = (type === 'wfs' && minZoomEl) ? (parseInt(minZoomEl.value) || 15) : undefined;
    const filterAttr = type === 'wfs' ? (document.getElementById('ws-filter-attr').value.trim()) : '';
    const filterVals = type === 'wfs' ? (document.getElementById('ws-filter-vals').value.trim()) : '';
    if ((filterAttr && !filterVals) || (!filterAttr && filterVals))
      toastMsg('Filtro WFS: compila sia l’attributo sia i valori, oppure lascia vuoti entrambi', 'warn');
    const cfg = { id, type, url, name, layers, version, crs, protected: isProtected };
    if (minZoom !== undefined) cfg.minZoom = minZoom;
    /* WMS: adopt the min zoom derived from the layer's scale window (Get layers), so the layer
       stops requesting an empty image below its drawable range. This used to be applied to
       overlays only, on the reasoning that a basemap must never blank out — but the silent
       failure that reasoning produced is worse than the blank: outside its scale window the
       server answers with an empty or black frame and the user has nothing to go on. Gated,
       the layer says "Zooma per caricare …" instead. */
    if (type === 'wms') {
      const _wz = _wmsMinZoomByLayer[url + '|' + layers];
      if (_wz != null && isFinite(_wz)) cfg.minZoom = _wz;
    }
    if (filterAttr && filterVals) { cfg.filterAttr = filterAttr; cfg.filterVals = filterVals; }
    // Carry over caps-derived traits only if the URL still matches what was inspected
    if (type === 'wfs' && _wfsCapsByUrl[url] && _wfsCapsByUrl[url].jsonSupported === false) cfg.jsonSupported = false;

    /* ── Overlay: add on top of current basemap, show in Layers panel ── */
    if (useAs === 'overlay') {
      let layer;
      try { layer = _createLayer(cfg, null, true); }
      catch(e) { toastMsg('Errore: ' + e.message, 'error'); addBtn.disabled = false; return; }

      /* Pre-trust WMS hostname so SslPlugin bypasses cert errors silently
         (avoids one dialog per tile overwhelming the UI)                  */
      const _doAddOverlay = () => {
        toastMsg('Overlay WMS aggiunto: sposta o zooma per caricare l’immagine', 'success');
        if (typeof addLayerToList === 'function') {
          addLayerToList(layer, name, null, null, {
            isWfs: cfg.type === 'wfs',
            cfgId: cfg.id,          // so a drag of this service persists into customMapConfigs
            onStateChange: ({ opacity, visible }) => {
              cfg.opacity = opacity;
              cfg.visible = visible;
              if (typeof _autoSaveConfig === 'function') _autoSaveConfig();
            },
            onColorChange: color => {
              cfg.color = color;
              if (typeof _autoSaveConfig === 'function') _autoSaveConfig();
            },
            onHollowChange: hollow => {
              cfg.hollow = hollow;
              if (typeof _autoSaveConfig === 'function') _autoSaveConfig();
            },
            onFilterChange: ({ filterAttr, filterVals }) => {
              if (filterAttr) cfg.filterAttr = filterAttr; else delete cfg.filterAttr;
              if (filterVals) cfg.filterVals = filterVals; else delete cfg.filterVals;
              if (typeof _autoSaveConfig === 'function') _autoSaveConfig();
            },
            // Persist the removal: without this the ✕ dropped the layer from the map and
            // legend but left its cfg in customMapConfigs/localStorage, so it came back at
            // the bottom of the legend on the next launch (the restore path in tools.js has
            // this callback, the fresh-add path here was missing it).
            onDelete: () => {
              const idx = customMapConfigs.indexOf(cfg);
              if (idx !== -1) customMapConfigs.splice(idx, 1);
              if (typeof _autoSaveConfig === 'function') _autoSaveConfig();
            }
          });
        } else {
          // Fallback (addLayerToList not yet loaded): add directly
          layer.addTo(map);
        }
        // Persist overlay so it is restored on next launch
        cfg.useAs = 'overlay';
        customMapConfigs.push(cfg);
        if (typeof _autoSaveConfig === 'function') _autoSaveConfig();
        document.getElementById('ws-url').value    = '';
        document.getElementById('ws-name').value   = '';
        document.getElementById('ws-layers').value = '';
        form.style.display = 'none';
        toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Aggiungi mappa web';
        addBtn.disabled = false;
      };

      if (window.cordova && typeof cordova.exec === 'function') {
        try {
          const wmsHost = new URL(cfg.url).hostname;
          // Persist in SSL exceptions list (same as existing SslPlugin flow)
          const exceptions = typeof _getSslExceptions === 'function' ? _getSslExceptions() : [];
          if (!exceptions.includes(wmsHost)) {
            exceptions.push(wmsHost);
            try { localStorage.setItem('giscatasto_ssl_exceptions', JSON.stringify(exceptions)); } catch(_) {}
          }
          // Register with native SslPlugin — on completion add the layer
          cordova.exec(
            () => { setTimeout(_doAddOverlay, 200); },
            () => { _doAddOverlay(); },
            'SslPlugin', 'addTrustedHost', [wmsHost]
          );
        } catch(_) { _doAddOverlay(); }
      } else {
        _doAddOverlay();
      }
      return;
    }

    /* ── Basemap ── */
    /* A WMS basemap is probed first: if the service answers a real tile in Web Mercator it is
       wired as tiles, which is what makes it downloadable for offline use, and the user is told
       so. If it does not, it stays a single viewport image — perfectly usable on screen — and
       the user is told that too, in the same breath. The alternative was what happened before:
       the map worked, then never appeared among the downloadable sources, with no explanation
       anywhere. */
    if (type === 'wms' && !isProtected) {
      _probeWmsTiled(url, layers, cfg.version, cfg.minZoom, tiled => {
        if (tiled) {
          cfg.type = 'wms_tiles';
          cfg.wmsParams = { layers: layers, format: 'image/png', transparent: false,
                            bgcolor: '0xFFFFFF', version: cfg.version || '1.1.1' };
          cfg.maxZoom = cfg.maxZoom || 20;
        }
        try { BASEMAPS[id] = _createLayer(cfg, null); }
        catch(e) { toastMsg('Errore: ' + e.message, 'error'); addBtn.disabled = false; return; }
        _finishAddBasemap(cfg, id, name);
        toastMsg(tiled
          ? name + ' — scaricabile offline'
          : name + ' — solo online (niente Web Mercator)',
          tiled ? 'success' : 'warn');
      });
      return;
    }

    if (isProtected) {
      BASEMAPS[id] = { _needsCreds: true, _cfg: cfg };
    } else {
      try { BASEMAPS[id] = _createLayer(cfg, null); }
      catch(e) { toastMsg('Errore: ' + e.message, 'error'); addBtn.disabled = false; return; }
    }

    customMapConfigs.push(cfg);
    _finishAddBasemap(cfg, id, name);
    toastMsg('Mappa aggiunta: ' + name, 'success');
    addBtn.disabled = false;

    /* Shared tail: the probe path lands here asynchronously, the others straight away. */
    function _finishAddBasemap(c, cid, cname) {
      if (customMapConfigs.indexOf(c) === -1) customMapConfigs.push(c);
      _autoSaveConfig();
      const label = _addBasemapUI(c);
      label.querySelector('input').click();
      document.getElementById('ws-url').value    = '';
      document.getElementById('ws-name').value   = '';
      document.getElementById('ws-layers').value = '';
      form.style.display = 'none';
      toggleBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg> Aggiungi mappa web';
      addBtn.disabled = false;
    }
  });
})();