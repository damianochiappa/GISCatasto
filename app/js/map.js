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
  google_maps: L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>', maxZoom: 20
  }),
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
function _loadToast(msg, type, dur, target) {
  if (Date.now() - _bootAt < _BOOT_QUIET_MS) return;
  toastMsg(msg, type, dur, target);
}

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

function _makeNavArrowIcon(heading) {
  const rot = (heading != null && isFinite(heading)) ? heading : 0;
  return L.divIcon({
    html: `<div style="width:32px;height:32px;transform:rotate(${rot}deg);transform-origin:center;` +
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

function _makeAirplaneIcon(heading) {
  const rot = (heading != null && isFinite(heading)) ? heading : 0;
  return L.divIcon({
    html: `<div style="width:34px;height:34px;transform:rotate(${rot}deg);transform-origin:center;` +
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
  // Marker icons are screen-fixed (leaflet-rotate rotateWithView:false), while the map
  // is rotated track-up via setBearing(-_smoothBearing). Add the current map bearing so the
  // arrow points along travel instead of double-counting the heading.
  const _icon = () => _kind === 'plane' ? _makeAirplaneIcon(pos.coords.heading)
                                        : _makeNavArrowIcon(_smoothBearing + map.getBearing());
  const _popupWasOpen = !!(gpsMarker && gpsMarker.isPopupOpen && gpsMarker.isPopupOpen());
  if (gpsMarker && _gpsMarkerKind === _kind) {
    gpsMarker.setLatLng(ll);
    if (_kind !== 'dot') gpsMarker.setIcon(_icon());
  } else {
    if (gpsMarker) map.removeLayer(gpsMarker);
    gpsMarker = (_kind === 'dot')
      ? L.circleMarker(ll, { radius: 8, color: '#4f8ef7', fillColor: '#fff', fillOpacity: 1, weight: 3 })
      : L.marker(ll, { icon: _icon(), zIndexOffset: 1000 });
    gpsMarker.addTo(map).bindPopup(gpsDiv, { maxWidth: 260 });
    _gpsMarkerKind = _kind;
  }
  /* The readout is refreshed only while the balloon is shut. Swapping the content of an open
     popup would replace the "Copy coordinates" button under the user's finger and re-run the
     auto-pan on every fix, so what stays on screen is the reading that was tapped for. */
  if (!_popupWasOpen && gpsMarker.getPopup()) gpsMarker.setPopupContent(gpsDiv);



  if (!gpsFirstFix) { gpsFirstFix = true; map.setView(ll, Math.max(map.getZoom(), 15)); }
  else if (typeof navIsActive === 'function' && navIsActive() && window._navFollowing) { map.panTo(ll, { animate: true, duration: 0.3 }); }

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
        map.setBearing(-_smoothBearing);
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
    if (_gpsViewCone) map.removeLayer(_gpsViewCone);
    _gpsViewCone = L.polygon(_sectorPts, {
      color: '#4f8ef7', weight: 1, opacity: 0.7,
      fillColor: '#4f8ef7', fillOpacity: 0.18
    }).addTo(map);
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

map.on('moveend zoomend rotate', () => {
  _saveView();
  document.getElementById('zoom-level').textContent = map.getZoom();
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

  const _fpCol = document.getElementById('flight-collapse');
  if (_fpCol) _fpCol.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    _fpCol.textContent = panel.classList.contains('collapsed') ? '+' : '\u2212';
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
    map.on('moveend zoomend resize', this._schedule, this);
    this._schedule();
  },

  onRemove(map) {
    clearTimeout(this._timer);
    map.off('moveend zoomend resize', this._schedule, this);
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
    const bounds = map.getBounds();
    const size   = map.getSize();
    if (!size.x || !size.y) return;
    // Below the layer's scale window there is nothing to draw — the server would answer with an
    // empty image. Skip the request (and drop any stale frame) and nudge the user to zoom in,
    // mirroring the WFS minZoom behaviour. Only set for overlays, so a basemap is never blanked.
    if (this.options.minZoom != null && map.getZoom() < this.options.minZoom) {
      this._reqId++;   // invalidate any in-flight response so it can't paint a below-scale frame
      this._removeOverlay();
      const now = Date.now();
      if (!this._lastZoomWarn || now - this._lastZoomWarn > 5000) {
        const who = this.options.attribution ? '"' + this.options.attribution + '"' : 'WMS layer';
        _loadToast('Zooma per caricare ' + who, 'warn', undefined, 'map-quiet');
        this._lastZoomWarn = now;
      }
      return;
    }
    const reqId = ++this._reqId;
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
      let swapped = false;
      const _dropPrev = () => {
        if (swapped) return;
        swapped = true;
        if (prev) try { map.removeLayer(prev); } catch(_) {}
        _revokeObj(prevUrl);
      };
      next.on('load',  _dropPrev);
      next.on('error', _dropPrev);      // a broken frame must not strand the old one
      setTimeout(_dropPrev, 3000);      // safety net: never hold two frames indefinitely
      next.addTo(map);
      this._overlay    = next;
      this._overlayUrl = imgUrl;
    };
    // Surface a broken service once per failure period (not on every pan) so the user sees
    // why nothing is drawn instead of a silent blank. Latch clears on the next good frame.
    const _notifyErr = detail => {
      if (reqId !== this._reqId || this._errShown) return;
      this._errShown = true;
      const who = this.options.attribution ? '"' + this.options.attribution + '"' : 'layer';
      _loadToast('WMS ' + who + ' — ' + detail, 'error');
      // Also record it: the toast is gone in seconds, the diagnostic report is
      // what survives long enough to be looked at afterwards.
      console.warn('[giscatasto] WMS ' + who + ' failed:', detail, '|', this._wmsUrl);
    };

    if (window.cordova && cordova.plugin && cordova.plugin.http) {
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
        err => { _notifyErr('richiesta non riuscita' + (err && err.status ? ' (HTTP ' + err.status + ')' : '')); }
      );
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

function _wfsLayerAdded(wfsLayer) {
  _wfsCount++;
  _wfsRegistry.push({ typeName: wfsLayer.options.typeName, name: wfsLayer.options.attribution, minZoom: wfsLayer.options.minZoom || 14, layer: wfsLayer });
  _selUpdateBadge();
}
function _wfsLayerRemoved(wfsLayer) {
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
    map.on('moveend zoomend', this._schedule, this);
    this._schedule();
    _wfsLayerAdded(this);
  },

  onRemove(map) {
    clearTimeout(this._timer);
    this._reqId = (this._reqId || 0) + 1;  // invalidate any in-flight render so late responses don't re-add features
    map.off('moveend zoomend', this._schedule, this);
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

  /* Human name for toasts, so a message says WHICH overlay it refers to (there can be
     several WFS at once: Catasto Particelle, Fogli, user-added). Falls back when unnamed. */
  _name() { return this.options.attribution ? '"' + this.options.attribution + '"' : 'WFS layer'; },

  _update() {
    const map = this._map;
    if (!map) return;
    if (map.getZoom() < this.options.minZoom) {
      if (this._geo) { try { map.removeLayer(this._geo); } catch(_) {} this._geo = null; }
      const now = Date.now();
      if (!this._lastZoomWarn || now - this._lastZoomWarn > 5000) {
        _loadToast('Zooma per caricare ' + this._name(), 'warn', undefined, 'map-quiet');
        this._lastZoomWarn = now;
      }
      return;
    }
    const b = map.getBounds();
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
      if (reqId !== this._reqId) return;
      // Client-side filter pass for servers that don't support FILTER (Agenzia Entrate cadastral WFS).
      // Applied before the empty-check so the toast distinguishes "no features at all" vs "filtered out".
      if (_clientFilter && _isCadFilter && geojson.features) {
        geojson = { ...geojson, features: geojson.features.filter(f => _clientFilter(f.properties)) };
      }
      if (!geojson.features || geojson.features.length === 0) {
        const _hasFilter = this.options.filterAttr && this.options.filterVals;
        // This fires on every empty viewport refresh — i.e. every pan/zoom over an area
        // with no matching features — which is spammy. Throttle to once per 8 s per layer
        // and honour the startup grace window (via _loadToast).
        const _now = Date.now();
        if (!this._lastEmptyWarn || _now - this._lastEmptyWarn > 8000) {
          _loadToast(_hasFilter
            ? this._name() + ': nessuna geometria corrisponde al filtro — controlla nome attributo e valori'
            : this._name() + ': nessuna geometria nella vista corrente', 'warn', undefined, 'map-quiet');
          this._lastEmptyWarn = _now;
        }
        try { this.fire('wfsupdate', { count: 0 }); } catch(_) {}
        return;
      }
      const prev = this._geo;
      this._selectedLayer = null;
      const self = this;
      const _hlStyle = _SEL_STYLE;
      try {
        const _wfsPane = self.options.pane || null;
        this._geo = L.geoJSON(geojson, {
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
        }).addTo(map);
        // Remove old layer; clear stale screen refs for layers that left the viewport
        if (prev) {
          try {
            prev.eachLayer(l => {
              const k = [..._selLayers.entries()].find(([,v]) => v === l)?.[0];
              if (k) _selLayers.delete(k);
            });
          } catch(_) {}
          try { map.removeLayer(prev); } catch(_) {}
        }
        _selUpdateBadge();
        try { this.fire('wfsupdate', { count: geojson.features.length }); } catch(_) {}
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

    const _parse = text => {
      if (reqId !== this._reqId) return;
      // Try JSON first (GeoServer, QGIS Server, etc.)
      try { _render(JSON.parse(text)); return; } catch(_) {}
      // GML fallback: OL parser first (standard GML), then manual DOM parser (MapServer / non-standard NS)
      const swapAxes = geoUrn || (ver >= 2.0 && geoEpsg); // WFS 2.0 geographic CRS returns lat,lon
      if (window.ol && ol.format) {
        try {
          const feats = new ol.format.WFS().readFeatures(text, { featureProjection: 'EPSG:4326' });
          if (feats && feats.length) {
            _render(JSON.parse(new ol.format.GeoJSON().writeFeatures(feats, { featureProjection: 'EPSG:4326' }))); return;
          }
        } catch(_) {}
        try {
          const feats = ol.format.GML32 ? new ol.format.GML32().readFeatures(text, { featureProjection: 'EPSG:4326' }) : [];
          if (feats && feats.length) {
            _render(JSON.parse(new ol.format.GeoJSON().writeFeatures(feats, { featureProjection: 'EPSG:4326' }))); return;
          }
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
        _loadToast(this._name() + ': il server ha risposto <' + _root.localName + '>' + (_exc ? ': ' + _exc.textContent.substring(0,60) : '') + _hint, 'error');
      } catch(_) { _loadToast(this._name() + ': risposta non valida', 'error'); }
    };

    if (window.cordova && cordova.plugin && cordova.plugin.http) {
      cordova.plugin.http.sendRequest(url, { method:'get', responseType:'arraybuffer' },
        res => _parse(_decodeXmlBuffer(res.data)),
        () => { if (reqId === this._reqId) _loadToast(this._name() + ': richiesta non riuscita', 'error'); }
      );
    } else {
      fetch(url).then(r => r.arrayBuffer()).then(buf => _parse(_decodeXmlBuffer(buf)))
        .catch(() => { if (reqId === this._reqId) _loadToast(this._name() + ': richiesta non riuscita', 'error'); });
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