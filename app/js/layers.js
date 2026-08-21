/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
/* =====================================================
   LAYERS — list management, file loading, KML enhance
===================================================== */

const loadedLayers = {};
/* The bytes the ⬇ button writes out, by layer id. Kept here rather than in the closure of
   addLayerToList because a KML can be edited after it was listed: with the closure copy, the
   export kept handing out the geometry from before the edit for the rest of the session,
   while the toast said the edit had been saved. _saveKmlEdit updates this entry. */
const _rawContentById = {};
let layerCounter = 0;

/* ===== RECURSIVE BOUNDS COLLECTOR (robust KML zoom) ===== */
function _collectBounds(layer) {
  const b = L.latLngBounds([]);
  if (layer instanceof L.Marker || layer instanceof L.CircleMarker) {
    b.extend(layer.getLatLng());
  } else if (typeof layer.getLatLngs === 'function') {
    try {
      const lls = layer.getLatLngs();
      const flat = (lls.length && Array.isArray(lls[0])) ? [].concat(...lls) : lls;
      flat.forEach(ll => { if (ll && ll.lat !== undefined) b.extend(ll); });
    } catch(e) {}
  } else if (typeof layer.getBounds === 'function') {
    try { const sb = layer.getBounds(); if (sb && sb.isValid()) b.extend(sb); } catch(e) {}
  }
  if (typeof layer.eachLayer === 'function') {
    layer.eachLayer(sub => { const sb = _collectBounds(sub); if (sb.isValid()) b.extend(sb); });
  }
  return b;
}

// Fill ratio aligned with draw.js user shapes (fillOpacity = opacity * 0.3)
const _NV_FILL_RATIO = 0.3;

function setLayerOpacity(layer, pct) {
  if (!layer) return;
  const o = pct / 100;
  // A raster layer (WMS image, XYZ tiles) has setOpacity but no setStyle, so only the
  // first branch fires; a vector layer also picks up stroke/fill opacity below.
  if (typeof layer.setOpacity === 'function') { try { layer.setOpacity(o); } catch(e) {} }
  if (typeof layer.setStyle === 'function') {
    const fo = layer._hollow ? 0 : o * _NV_FILL_RATIO;
    try { layer.setStyle({ opacity: o, fillOpacity: fo }); } catch(e) {}
  }
  if (layer._icon) layer._icon.style.opacity = o;
  if (typeof layer.eachLayer === 'function') layer.eachLayer(c => setLayerOpacity(c, pct));
}

// Sets the hollow flag recursively. Style is applied by the next
// setLayerOpacity call (which reads _hollow), so callers must invoke
// setLayerOpacity afterwards to materialize the change.
function _setLayerHollow(layer, hollow) {
  layer._hollow = hollow;
  if (typeof layer.eachLayer === 'function') layer.eachLayer(c => _setLayerHollow(c, hollow));
}

function setLayerColor(layer, color) {
  if (!layer) return;
  if (layer._isRaster) return; // color is baked into a raster WMS image server-side
  if (typeof layer.setStyle === 'function')  { try { layer.setStyle({ color, fillColor: color }); } catch(e) {} }
  if (typeof layer.setIcon === 'function') {
    layer.setIcon(L.divIcon({
      html: `<div style="width:12px;height:12px;border-radius:50%;background:${color};border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.5)"></div>`,
      className: '', iconSize: [12,12], iconAnchor: [6,6]
    }));
  }
  if (typeof layer.eachLayer === 'function') layer.eachLayer(c => setLayerColor(c, color));
}

/* ── Per-overlay stacking panes (file overlays: KML / GeoJSON / GPX) ──
   Each imported file overlay gets its own pane so the legend order can place it ABOVE or
   BELOW the cadastral WFS and have that survive a restart — WITHOUT touching the
   cadastre's fixed panes (wfs-particelle 402 / wfs-fogli 404) or its selection z-logic.
   Only vector paths are routed into the pane; markers stay in the native markerPane so
   pins remain on top. Reordering later just changes the pane's z-index (no re-render). */
function _ensureOverlayPane(name) {
  if (map.getPane(name)) return name;
  const p = map.createPane(name);
  const rotatePane = map.getPane('rotatePane');
  if (rotatePane) rotatePane.appendChild(p);
  return name;
}

function _assignOverlayPaneToPaths(layer, paneName) {
  const leaves = _flattenKMLLeafLayers(layer);
  const onMap = map.hasLayer(layer);
  let moved = false;
  leaves.forEach(l => { if (l instanceof L.Path) { l.options.pane = paneName; moved = true; } });
  // Re-add so children pick up the new pane in onAdd — only when currently shown; when
  // hidden the option is enough, it takes effect the next time the layer is added.
  if (moved && onMap) { try { map.removeLayer(layer); layer.addTo(map); } catch(_) {} }
}

/* One continuous z scale for every legend entry: the list position IS the stacking
   order, with no category barrier. Bottom of the list gets _Z_MIN, each entry above
   it +2. The band sits between the basemap (250) and the drawings (draw-poly 450,
   draw-line 460, markerPane 600), which stay out of the list and keep their fixed
   panes. So a raster CAN be dragged over a vector: nothing here forbids it.
   Capacity is (_Z_MAX - _Z_MIN) / 2 = 95 entries; beyond that the top ones clamp
   together and stop being orderable relative to each other. */
const _Z_MIN = 255;
const _Z_MAX = 445;
/* Leaflet's shared panes are never driven from the legend: writing a z-index into
   overlayPane or markerPane would move every layer that lives there, not just the
   entry being ordered. Only per-layer panes are safe to restack. */
const _SHARED_PANES = ['mapPane','tilePane','overlayPane','shadowPane','markerPane','tooltipPane','popupPane','rotatePane'];

function _applyOverlayZOrder() {
  if (typeof map === 'undefined' || !map) return;
  const list = document.getElementById('layer-list');
  if (!list) return;
  // Bottom-up: the last item in the DOM is the lowest layer on the map.
  [...list.querySelectorAll('.layer-item')].reverse().forEach((el, i) => {
    // Own stacking pane (file overlay / raster), else the layer's fixed pane (WFS
    // cadastre: wfs-particelle / wfs-fogli) so it takes its place in the same scale.
    const lyr  = loadedLayers[el.dataset.id];
    const pane = el.dataset.ovPane || (lyr && lyr.options && lyr.options.pane);
    if (!pane || _SHARED_PANES.indexOf(pane) !== -1) return;
    const paneEl = map.getPane(pane);
    if (!paneEl) return;
    paneEl.style.zIndex = Math.min(_Z_MAX, _Z_MIN + 2 * i);
  });
  if (typeof _reorderMapPanes === 'function') _reorderMapPanes(map);
}

/* Where a newly loaded layer enters the list. Ranks are only an INSERTION default —
   never a barrier: once placed, drag moves anything anywhere. Points are absent from
   the scale on purpose, because _assignOverlayPaneToPaths leaves markers in the native
   markerPane (600), so they already sit above every path without being ordered here. */
const _RANK_RASTER = 0, _RANK_POLYGON = 1, _RANK_LINE = 2;

function _layerRank(layer, isRaster) {
  if (isRaster) return _RANK_RASTER;
  let hasPolygon = false, hasLine = false;
  _flattenKMLLeafLayers(layer).forEach(l => {
    if (l instanceof L.Polygon)       hasPolygon = true;   // L.Polygon extends L.Polyline: test first
    else if (l instanceof L.Polyline) hasLine    = true;
  });
  if (hasPolygon) return _RANK_POLYGON;   // mixed polygon+line KML counts as polygon
  if (hasLine)    return _RANK_LINE;
  return _RANK_POLYGON;                   // markers-only, or a WFS with no features loaded yet
}

/* Re-imported file: drop it back above the first entry whose saved order is lower. */
function _insertByZOrder(list, item, zOrder) {
  const anchor = [...list.querySelectorAll('.layer-item')]
    .find(el => el.dataset.zOrder !== undefined && el.dataset.zOrder !== ''
                && parseInt(el.dataset.zOrder) < zOrder);
  if (anchor) list.insertBefore(item, anchor);
  else        list.appendChild(item);
}

/* Insert just above the topmost entry of the same rank; failing that, just above the
   topmost entry of a lower rank; failing that, at the bottom. Well defined even after
   drag has scattered the ranks, and it never displaces anything already placed. */
function _insertByRank(list, item, rank) {
  const items = [...list.querySelectorAll('.layer-item')];
  const sameRank = items.find(el => parseInt(el.dataset.rank) === rank);
  const anchor   = sameRank || items.find(el => parseInt(el.dataset.rank) < rank);
  if (anchor) list.insertBefore(item, anchor);
  else        list.appendChild(item);
}

/* After any legend reorder: re-stack the panes, then persist ONE order across both
   stores. Entries live in two places — file overlays in giscatasto_file_overlays, services
   in giscatasto_custom_maps (customMapConfigs) — so a single zOrder per entry is what makes
   an interleaved KML/raster/WFS order survive a restart. Bottom of the list is 0. */
function _afterReorder() {
  _applyOverlayZOrder();
  const items = [...document.querySelectorAll('#layer-list .layer-item')];
  const n = items.length;
  let cfgTouched = false;

  const zById = {};
  items.forEach((el, i) => {
    const z = n - 1 - i;                       // top of the list = highest zOrder
    el.dataset.zOrder = z;
    if (el.dataset.storeId) zById[el.dataset.storeId] = z;
    if (el.dataset.cfgId && typeof customMapConfigs !== 'undefined') {
      const c = customMapConfigs.find(e => e.id === el.dataset.cfgId);
      if (c) { c.zOrder = z; cfgTouched = true; }
    }
  });

  if (cfgTouched && typeof _autoSaveConfig === 'function') _autoSaveConfig();
  const orderedStoreIds = items.map(el => el.dataset.storeId).filter(Boolean);
  // One read + one write: the file store holds full file contents, so per-item updates
  // would re-serialise every overlay on every drag.
  if (orderedStoreIds.length) _reorderStore(orderedStoreIds, zById);
}

/* Legend reordering. HTML5 drag-and-drop is deliberately not used: Chromium never starts
   a drag from touch input, so `draggable` + dragstart/drop only ever worked with a mouse
   and was dead on the device — the reorder simply never happened. Pointer Events cover
   mouse, touch and pen through one path, so there is a single implementation.
   The grip is the only handle: the row also carries a checkbox, a colour swatch and an
   opacity slider, and starting a drag on those would fight with their own gestures. */
const _DRAG_EDGE = 28;   // px from the list edge where auto-scroll kicks in
const _DRAG_STEP = 10;   // px scrolled per pointermove inside that band

function _bindReorder(item, handle, id) {
  if (!handle) return;
  handle.addEventListener('pointerdown', e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;   // touch and pen always pass
    const list = document.getElementById('layer-list');
    if (!list) return;
    // Keeps the panel from scrolling (touch) or selecting text (mouse) mid-drag.
    e.preventDefault();
    // Capture keeps the gesture on the grip while the row slides out from under the
    // finger; the listeners still go on the document, because a capture that the browser
    // refuses (it throws when the pointer is no longer active) would otherwise leave the
    // drag receiving nothing at all.
    try { handle.setPointerCapture(e.pointerId); } catch(_) {}
    item.classList.add('dragging');
    const pid = e.pointerId;
    let changed = false;

    const onMove = ev => {
      if (ev.pointerId !== pid) return;
      const y  = ev.clientY;
      const lr = list.getBoundingClientRect();
      // The list is a fixed-height scroll box: without this the entries outside its
      // viewport are unreachable — the finger just runs out of list.
      if      (y < lr.top    + _DRAG_EDGE) list.scrollTop -= _DRAG_STEP;
      else if (y > lr.bottom - _DRAG_EDGE) list.scrollTop += _DRAG_STEP;
      // Insert before the first sibling whose midpoint is below the pointer; past every
      // midpoint the item belongs at the bottom.
      const target = [...list.querySelectorAll('.layer-item')].find(el => {
        if (el === item) return false;
        const r = el.getBoundingClientRect();
        return y < r.top + r.height / 2;
      });
      if (target) {
        if (target !== item.nextElementSibling) { list.insertBefore(item, target); changed = true; }
      } else if (list.lastElementChild !== item) {
        list.appendChild(item); changed = true;
      }
    };

    const onEnd = ev => {
      if (ev && ev.pointerId !== pid) return;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      item.classList.remove('dragging');
      // A tap or a jitter that moved nothing must not renumber and persist every entry.
      if (!changed) return;
      const l = loadedLayers[id];
      // A vector without its own pane lives in the shared overlayPane, which the legend
      // z-scale skips: it can only be restacked by the Leaflet call. Everything else is
      // handled by _afterReorder re-stacking the per-layer panes.
      if (l && !l._isRaster && !l.options?.pane) try { if (l.bringToFront) l.bringToFront(); } catch(_) {}
      _afterReorder();
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onEnd);
    document.addEventListener('pointercancel', onEnd);
  });
}

/* Startup replay. The three restore paths (file overlays, saved config, bundled config
   fetch) are independent and partly async, so instead of trying to sequence them each
   one just pokes this and the list is sorted once things settle. Entries that predate
   zOrder are ranked by _legacyOrder so an upgrade does not visibly shuffle the map. */
let _legendSortTimer = null;
function _scheduleLegendSort() {
  clearTimeout(_legendSortTimer);
  _legendSortTimer = setTimeout(_sortLegendByZOrder, 200);
}

/* Reproduces the pre-zOrder visual truth: file overlays flagged above the cadastre sat at
   447…, the cadastre/WFS at 402/404, the remaining file overlays at 399…, rasters at 260. */
function _legacyOrder(el) {
  if (el.dataset.legacyAbove === '1') return 4;
  if (el.dataset.isWfs === '1')       return 3;
  if (el.dataset.ovPane && el.dataset.rank !== String(_RANK_RASTER)) return 2;
  return 1;
}

function _sortLegendByZOrder() {
  const list = document.getElementById('layer-list');
  if (!list) return;
  const items = [...list.querySelectorAll('.layer-item')];
  if (items.length < 2) { _applyOverlayZOrder(); return; }

  const dom = new Map(items.map((el, i) => [el, i]));
  const hasZ = el => el.dataset.zOrder !== undefined && el.dataset.zOrder !== '';

  items.sort((a, b) => {
    // Both migrated: saved order decides, highest zOrder on top.
    if (hasZ(a) && hasZ(b)) return parseInt(b.dataset.zOrder) - parseInt(a.dataset.zOrder);
    // Neither: fall back to how the old fixed z-bands rendered them.
    if (!hasZ(a) && !hasZ(b)) {
      const d = _legacyOrder(b) - _legacyOrder(a);
      return d !== 0 ? d : dom.get(a) - dom.get(b);
    }
    return hasZ(a) ? -1 : 1;   // migrated entries sit above not-yet-migrated ones
  });

  items.forEach(el => list.appendChild(el));
  /* Apply the stacking, but do NOT renumber and do NOT persist. The restore paths finish
     at different moments — services at parse time, file overlays on a timer, the bundled
     config on an async fetch — so a renumber here would compress whatever subset happens
     to be present into 0..n-1 and destroy the saved numbering of everything still on its
     way. The two sets would then collide on equal values and the order would look random.
     Renumbering belongs to a real user action, when the list is complete by definition. */
  _applyOverlayZOrder();
}

function addLayerToList(layer, name, rawContent, rawMime, opts) {
  opts = opts || {};
  const initOpacity = opts.opacity !== undefined ? opts.opacity : 80;
  const initVisible = opts.visible !== false;
  const initColor   = opts.color || '#4f8ef7';
  const initHollow  = opts.hollow || false;
  // Raster layers (WMS via OpenLayers, XYZ/WMTS/ArcGIS tiles) carry no client-side
  // style: colour and fill are baked into the image by the server. Only opacity
  // applies, so the colour and hollow controls are omitted rather than shown dead.
  const isRaster    = layer._isRaster === true || layer instanceof L.TileLayer;
  // Zoom-to needs a vector extent; Export needs the original file bytes. Raster WMS
  // overlays have neither, WFS overlays have no raw content — so those buttons are
  // omitted for layers that cannot use them (rather than shown and failing on tap).
  const hasRaw      = !!(rawContent && rawMime);
  const isFileOverlay = hasRaw && !isRaster;   // KML / GeoJSON / GPX
  if (initHollow) _setLayerHollow(layer, true);
  // setLayerOpacity below will apply the correct stroke+fill based on _hollow

  const id = 'layer_' + (++layerCounter);
  loadedLayers[id] = layer;
  if (hasRaw) _rawContentById[id] = rawContent;

  // Every entry gets its own stacking pane, so any entry can be ordered against any
  // other. Rasters must be routed BEFORE addTo: both L.TileLayer and _WMSImageLayer
  // read options.pane in onAdd, so setting it afterwards would not take effect.
  let ovPane = null;
  if (isRaster) {
    ovPane = _ensureOverlayPane('ov_' + id);
    layer.options.pane = ovPane;
    layer.options.paneZIndex = _Z_MIN;   // real value assigned by _applyOverlayZOrder below
  }

  layer.addTo(map);
  if (!initVisible) map.removeLayer(layer);

  if (isFileOverlay) {
    ovPane = _ensureOverlayPane('ov_' + id);
    _assignOverlayPaneToPaths(layer, ovPane);
  }

  const empty = document.querySelector('#layer-list .layer-empty');
  if (empty) empty.remove();

  const item = document.createElement('div');
  item.className = 'layer-item';
  item.dataset.id = id;
  if (opts.storeId) item.dataset.storeId = opts.storeId;
  if (opts.cfgId)   item.dataset.cfgId   = opts.cfgId;    // links a service entry to customMapConfigs
  if (ovPane) item.dataset.ovPane = ovPane;
  item.dataset.rank = _layerRank(layer, isRaster);
  if (opts.isWfs) item.dataset.isWfs = '1';
  if (opts.legacyAbove) item.dataset.legacyAbove = '1';   // pre-zOrder store, read once at migration
  if (opts.zOrder !== undefined && opts.zOrder !== null) item.dataset.zOrder = opts.zOrder;
  item.innerHTML = `
    <span class="layer-drag" title="Trascina per riordinare">\u22EE</span>
    <input type="checkbox" ${initVisible ? 'checked' : ''} title="Mostra/nascondi">
    <span class="layer-name" title="${name} (doppio tocco per rinominare)">${name}</span>
    ${isRaster ? '' : `<input type="color" class="layer-color" value="${initColor}" title="Colore del layer" list="app-colors">`}
    ${isRaster ? '' : `<button class="layer-hollow${initHollow ? ' active' : ''}" title="Vuoto (bucato) — senza riempimento">\u2205</button>`}
    ${isRaster ? '' : '<button class="layer-zoom" title="Zoom sul layer">\u29C6</button>'}
    ${opts.isWfs ? '<button class="layer-find" title="Trova le geometrie filtrate (ovunque, non solo nella vista)">\u2316</button>' : ''}
    ${opts.isWfs ? '<button class="layer-filter" title="Modifica il filtro WFS">\u25BD</button>' : ''}
    ${hasRaw ? '<button class="layer-exp"  title="Esporta il file">\u2B07</button>' : ''}
    ${opts.isKml ? '<button class="layer-edit" title="Modifica i vertici del KML">\u270F</button>' : ''}
    <button class="layer-del"  title="Rimuovi">\u2715</button>
    <div class="layer-opacity-row">
      <span>\u03B1</span>
      <input type="range" class="layer-opacity" min="0" max="100" value="${initOpacity}" title="Opacità">
      <span class="layer-opacity-val">${initOpacity}%</span>
    </div>`;
  const colorEl = item.querySelector('.layer-color');
  if (colorEl) colorEl.addEventListener('input', e => {
    setLayerColor(loadedLayers[id], e.target.value);
    if (opts.onColorChange) opts.onColorChange(e.target.value);
  });
  const hollowBtn = item.querySelector('.layer-hollow');
  if (hollowBtn) hollowBtn.addEventListener('click', () => {
    const l = loadedLayers[id];
    const nowHollow = !l._hollow;
    _setLayerHollow(l, nowHollow);
    setLayerOpacity(l, parseInt(item.querySelector('.layer-opacity').value));
    hollowBtn.classList.toggle('active', nowHollow);
    if (opts.onHollowChange) opts.onHollowChange(nowHollow);
  });

  item.querySelector('input[type=checkbox]').addEventListener('change', e => {
    const l = loadedLayers[id];
    e.target.checked ? map.addLayer(l) : map.removeLayer(l);
    if (opts.onStateChange) opts.onStateChange({ opacity: parseInt(opacitySlider.value), visible: e.target.checked });
  });
  const zoomBtn = item.querySelector('.layer-zoom');   // absent for raster WMS overlays
  if (zoomBtn) zoomBtn.addEventListener('click', () => {
    const l = loadedLayers[id];
    try {
      const b = _collectBounds(l);
      if (b && b.isValid()) map.fitBounds(b, { padding: [30,30], animate: true });
      else toastMsg('Estensione non disponibile', 'warn', undefined, 'sidebar');
    } catch(_) { toastMsg('Impossibile calcolare l’estensione', 'error', undefined, 'sidebar'); }
  });
  const opacitySlider = item.querySelector('.layer-opacity');
  const opacityLabel  = item.querySelector('.layer-opacity-val');
  opacitySlider.addEventListener('input', e => {
    const val = parseInt(e.target.value);
    opacityLabel.textContent = val + '%';
    setLayerOpacity(loadedLayers[id], val);
    if (opts.onStateChange) opts.onStateChange({ opacity: val, visible: item.querySelector('input[type=checkbox]').checked });
  });
  const expBtn = item.querySelector('.layer-exp');   // absent when there is no raw file content
  if (expBtn) expBtn.addEventListener('click', () => {
    const baseName = name.replace(/\.[^.]+$/, '');
    const ext = rawMime.includes('kml') ? '.kml' : rawMime.includes('json') ? '.geojson' : '.gpx';
    showPromptModal('Nome del file (senza estensione):', baseName, fname => {
      const stripRe = new RegExp('\\' + ext + '$', 'i');
      const stem = ((fname || baseName).trim() || baseName).replace(stripRe, '');
      // Current bytes, not the ones captured when the layer was listed — see _rawContentById.
      downloadFile(_rawContentById[id] !== undefined ? _rawContentById[id] : rawContent, stem + ext, rawMime);
    });
  });
  /* Removal is not the same gesture as hiding, and the ✕ sits next to the visibility
     toggle: the warning names the cheaper alternative rather than just asking twice. */
  item.querySelector('.layer-del').addEventListener('click', () => {
    showConfirmModal(
      'Sei sicuro? Considera di spegnere il livello senza rimuoverlo: se lo rimuovi dovrai ' +
      'aggiungerlo di nuovo a mano in futuro.',
      () => {
        const l = loadedLayers[id];
        map.removeLayer(l);
        delete loadedLayers[id];
        delete _rawContentById[id];
        // Drop this overlay's dedicated stacking pane so panes don't accumulate.
        if (item.dataset.ovPane) { const pe = map.getPane(item.dataset.ovPane); if (pe && pe.remove) pe.remove(); }
        item.remove();
        if (!Object.keys(loadedLayers).length) {
          document.getElementById('layer-list').innerHTML = '<p class="layer-empty">Nessun layer caricato</p>';
        }
        _applyOverlayZOrder();
        if (opts.onDelete) opts.onDelete();
      },
      { rememberKey: 'giscatasto_hide_layer_del_warn', okLabel: 'Rimuovi' }
    );
  });

  // Reordering: pointer-driven from the grip — see _bindReorder for why not HTML5 DnD.
  _bindReorder(item, item.querySelector('.layer-drag'), id);

  // Rename on double-tap/dblclick
  const nameEl = item.querySelector('.layer-name');
  nameEl.addEventListener('dblclick', () => {
    showPromptModal('Rinomina il layer:', nameEl.textContent, newName => {
      if (!newName || !newName.trim()) return;
      const n = newName.trim();
      nameEl.textContent = n; nameEl.title = n + ' (doppio tocco per rinominare)';
      if (opts.onRename) opts.onRename(n);
    });
  });

  // KML vertex edit button
  if (opts.isKml) {
    item.querySelector('.layer-edit').addEventListener('click', () => {
      _startKmlEdit(loadedLayers[id], id, opts.storeId || '');
    });
  }

  // WFS filter edit button
  if (opts.isWfs) {
    item.querySelector('.layer-filter').addEventListener('click', () => {
      const l = loadedLayers[id];
      const curAttr = (l && l.options) ? (l.options.filterAttr || '') : '';
      const curVals = (l && l.options) ? (l.options.filterVals || '') : '';
      showFilterEditModal(curAttr, curVals, (attr, vals) => {
        if (l && typeof l.setFilter === 'function') l.setFilter(attr, vals);
        if (opts.onFilterChange) opts.onFilterChange({ filterAttr: attr, filterVals: vals });
      });
    });
    // Find filtered features ignoring the current viewport: queries WFS with FILTER only (no BBOX),
    // then fitBounds on the result so the user can locate a parcel by its label/code from anywhere.
    item.querySelector('.layer-find').addEventListener('click', () => {
      const l = loadedLayers[id];
      if (!l || typeof l.findFilteredExtent !== 'function') return;
      if (!l.options.filterAttr || !l.options.filterVals) {
        toastMsg('Imposta prima un filtro per cercare le geometrie', 'warn', undefined, 'sidebar'); return;
      }
      const btn = item.querySelector('.layer-find');
      btn.disabled = true;
      const _origText = btn.textContent;
      btn.textContent = '\u2026';
      l.findFilteredExtent((bounds, err) => {
        btn.disabled = false; btn.textContent = _origText;
        if (bounds) {
          map.fitBounds(bounds, { padding: [40,40], animate: true, maxZoom: 19 });
          // After fitBounds, the bbox-bound refresh will pick up and render the matched features.
        } else {
          toastMsg('Trova: ' + (err || 'nessun risultato'), 'warn', undefined, 'sidebar');
        }
      });
    });
  }

  const _list = document.getElementById('layer-list');
  // keepOrder: a startup restore appends, then _sortLegendByZOrder puts the list right
  // once every restore path has finished. A known zOrder (re-imported file) goes straight
  // back to its place. Only a genuinely new layer is placed by rank.
  if (opts.keepOrder)              { _list.appendChild(item); _scheduleLegendSort(); }
  else if (item.dataset.zOrder)      _insertByZOrder(_list, item, parseInt(item.dataset.zOrder));
  else                               _insertByRank(_list, item, parseInt(item.dataset.rank));
  if (!opts.keepOrder) _afterReorder();
  else _applyOverlayZOrder();
  setLayerOpacity(loadedLayers[id], initOpacity);
  if (opts.color) setLayerColor(loadedLayers[id], opts.color);
  if (!layer._isRaster && !opts.noZoom) {
    try {
      const bounds = _collectBounds(layer);
      if (bounds && bounds.isValid()) map.fitBounds(bounds, { padding: [20,20] });
    } catch(e) {}
  }
  if (!opts.silent) toastMsg('Layer caricato: ' + name, 'success', undefined, 'sidebar');
}

/* ===== KML ENHANCE ===== */
function enhanceKMLLayer(kmlLayer, propsArray, kmlDoc) {
  if (typeof kmlLayer.eachLayer !== 'function') return;
  if (propsArray && propsArray.length) {
    const leaves = _flattenKMLLeafLayers(kmlLayer);
    if (kmlDoc) {
      let leafIdx = 0;
      kmlDoc.querySelectorAll('Placemark').forEach((pm, pmIdx) => {
        const props = propsArray[pmIdx];
        const geomCount = pm.querySelectorAll('Point, LineString, Polygon').length || 1;
        for (let g = 0; g < geomCount && leafIdx < leaves.length; g++, leafIdx++)
          if (props) leaves[leafIdx]._kmlProps = props;
      });
    } else {
      leaves.forEach((l, i) => { if (propsArray[i]) l._kmlProps = propsArray[i]; });
    }
  }
  kmlLayer.eachLayer(sub => enhanceKMLSublayer(sub));
}

function enhanceKMLSublayer(layer) {
  if (typeof layer.eachLayer === 'function' && !(layer instanceof L.Marker)) {
    layer.eachLayer(sub => enhanceKMLSublayer(sub));
    return;
  }
  const isMarker = layer instanceof L.Marker;
  let existingHTML = '';
  if (layer.getPopup && layer.getPopup()) {
    const c = layer.getPopup().getContent();
    existingHTML = typeof c === 'string' ? c : (c && c.outerHTML) ? c.outerHTML : '';
    layer.unbindPopup();
  }

  const div = document.createElement('div');
  div.style.minWidth = '210px';

  const kmlProps = layer._kmlProps;
  /* Two kinds of key are hidden from the attribute table: the ones this app generated on a
     previous export (they are recomputed in the geometry section below, and a stale copy
     next to a fresh one is worse than no copy) and the simplestyle keys, which tokml drops
     into ExtendedData along with everything else and which mean nothing to the user. */
  const _hidden = GEOM_PROP_KEYS.concat(STYLE_PROP_KEYS);
  const _visible = kmlProps
    ? Object.entries(kmlProps).filter(([k]) => _hidden.indexOf(k) === -1)
    : [];
  if (_visible.length) {
    const propsDiv = document.createElement('div');
    propsDiv.style.cssText = 'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)';
    const rows = _visible
      .map(([k,v]) => {
        const val = k === 'description' ? stripGeomDescription(v) : (v ?? '');
        return `<tr><td style="opacity:.65;padding-right:8px;font-size:11px;font-family:monospace;white-space:nowrap">${k}</td><td style="font-size:11px;font-family:monospace">${val}</td></tr>`;
      })
      .join('');
    const tbl = document.createElement('table');
    tbl.style.cssText = 'width:100%;margin-bottom:2px';
    tbl.innerHTML = rows;
    propsDiv.appendChild(tbl);
    div.appendChild(propsDiv);
  } else if (existingHTML) {
    const info = document.createElement('div');
    info.innerHTML = stripGeomDescription(existingHTML);
    info.style.cssText = 'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border);font-size:12px';
    div.appendChild(info);
  }

  // Measurements of the geometry as loaded, computed here rather than trusted from the file.
  const geomSec = geomInfoSectionForLayer(layer);
  if (geomSec) {
    // The attribute block above already draws a rule; two adjacent lines look like a glitch.
    if (div.childNodes.length) { geomSec.style.borderTop = 'none'; geomSec.style.paddingTop = '0'; geomSec.style.marginTop = '0'; }
    div.appendChild(geomSec);
  }

  // Per-feature style controls were removed: color/weight/opacity for KML
  // layers are managed from the sidebar layer-item (single source of truth,
  // persisted to localStorage). Markers keep the icon picker because that's
  // a per-feature attribute, not a layer-wide one.
  if (isMarker) {
    const styleHdr = document.createElement('div');
    styleHdr.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px';
    styleHdr.textContent = 'Icona';
    div.appendChild(styleHdr);

    const pickerDiv = document.createElement('div');
    pickerDiv.className = 'icon-picker';
    let activeBtn = null;
    MARKER_ICONS.forEach(icon => {
      const btn = document.createElement('button');
      btn.className = 'icon-btn'; btn.title = icon.l; btn.innerHTML = icon.html;
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (activeBtn) activeBtn.classList.remove('selected');
        btn.classList.add('selected'); activeBtn = btn;
        layer._geoIcon = icon.e;
        if (typeof layer.setIcon === 'function') layer.setIcon(makeEmojiIcon(icon.e));
        setTimeout(() => layer.openPopup(), 30);
      });
      pickerDiv.appendChild(btn);
    });
    div.appendChild(pickerDiv);
  }

  // Prevent popup interactions from leaking to the map (nav pick mode, scroll-zoom)
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  layer.bindPopup(div, { maxWidth: 280 });
}

/* ===== FILE OVERLAY PERSISTENCE ===== */
const _OVL_KEY = 'giscatasto_file_overlays';

function _loadOverlayStore() {
  try { return JSON.parse(localStorage.getItem(_OVL_KEY)) || []; } catch(_) { return []; }
}
function _saveOverlayStore(list) {
  try { localStorage.setItem(_OVL_KEY, JSON.stringify(list)); return true; }
  catch(e) {
    /* This store now holds metadata only — the file contents live in IndexedDB — so a
       few hundred bytes per overlay. Hitting the localStorage quota here means the quota
       is exhausted by something else entirely, not by an imported file. Console only, no
       user-facing message. Read it with: adb logcat | grep -i chromium */
    console.warn('[giscatasto] overlay metadata not saved (' + e.name + '): '
                 + list.length + ' entries, ~' + Math.round(JSON.stringify(list).length / 1024)
                 + ' KB. Layer order and styles will not survive a restart.');
    return false;
  }
}
/* ===== FILE CONTENTS (IndexedDB) =====
   Only the metadata (id, name, order, style) lives in localStorage: it is small, and
   keeping it synchronous means the whole ordering and restore logic stays unchanged.
   The file contents — the part that used to blow the ~4 MB localStorage cap and make a
   large KML silently vanish on the next launch — live here instead, keyed by store id.
   Every call degrades to false/null rather than throwing, and the caller then falls back
   to the old inline-in-localStorage behaviour, so a browser without IndexedDB still
   works exactly as before. */
const _IDB_NAME = 'giscatasto-overlays', _IDB_STORE = 'files';
let _idbPromise = null;

function _idb() {
  if (_idbPromise) return _idbPromise;
  _idbPromise = new Promise(resolve => {
    try {
      if (typeof indexedDB === 'undefined') { resolve(null); return; }
      const req = indexedDB.open(_IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(_IDB_STORE)) db.createObjectStore(_IDB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => { console.warn('[giscatasto] IndexedDB unavailable, falling back to localStorage'); resolve(null); };
    } catch(_) { resolve(null); }
  });
  return _idbPromise;
}

function _idbRun(mode, fn) {
  return _idb().then(db => {
    if (!db) return null;
    return new Promise(resolve => {
      try {
        const tx = db.transaction(_IDB_STORE, mode);
        const st = tx.objectStore(_IDB_STORE);
        let result = null;
        const req = fn(st);
        if (req) req.onsuccess = () => { result = req.result; };
        tx.oncomplete = () => resolve(result === undefined ? null : result);
        tx.onerror    = () => resolve(null);
        tx.onabort    = () => resolve(null);
      } catch(_) { resolve(null); }
    });
  });
}

const _idbGet = id      => _idbRun('readonly',  st => st.get(id));
const _idbDel = id      => _idbRun('readwrite', st => st.delete(id));
const _idbKeys = ()     => _idbRun('readonly',  st => st.getAllKeys());
function _idbPut(id, content) {
  // put() resolves with the key on success, so a non-null result means it landed.
  return _idbRun('readwrite', st => st.put(content, id)).then(r => r !== null);
}

/* Write a file's content to IndexedDB, falling back to inline localStorage when that is
   not possible — which is exactly the pre-IndexedDB behaviour, cap included. */
function _writeOverlayContent(storeId, content) {
  return _idbPut(storeId, content).then(okIdb => {
    if (okIdb) return true;
    console.warn('[giscatasto] content not stored in IndexedDB, keeping it inline (4 MB cap applies)');
    /* Inline in localStorage is the last resort and it caps at ~4 MB. Losing that write
       used to be console-only: the layer was on the map, looked saved, and was simply
       gone after a restart. Say it out loud instead — the user can still export the file. */
    if (!_updateOverlay(storeId, { content })) {
      toastMsg('Layer troppo grande per essere salvato: non sarà ripristinato al riavvio',
               'error', 8000, 'sidebar');
    }
    return false;
  });
}

/* Read a file's content: inline when present (legacy entry or fallback), else IndexedDB. */
function _readOverlayContent(entry) {
  if (entry.content) return Promise.resolve(entry.content);
  return _idbGet(entry.id);
}

/* Stable identity for a loaded file, so re-importing the same file is recognised as the
   same overlay instead of a fresh one (which used to pile up duplicates in the store).
   djb2 over the content: collisions are irrelevant here because name+mime must match too. */
function _overlayKey(name, content, mime) {
  let h = 5381;
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  return name + '|' + mime + '|' + content.length + '|' + (h >>> 0).toString(36);
}

function _persistOverlay(storeId, name, content, mime, opacity, visible, color, hollow, key, zOrder) {
  const list = _loadOverlayStore().filter(e => e.id !== storeId);
  // No `content` here: it goes to IndexedDB below, so this store stays small.
  list.push({ id: storeId, name, mime, opacity, visible, color: color || null,
              hollow: hollow || false, key: key || null,
              zOrder: (zOrder === undefined || zOrder === null) ? null : zOrder });
  _saveOverlayStore(list);
  _writeOverlayContent(storeId, content);
}
function _removeOverlay(storeId) {
  _saveOverlayStore(_loadOverlayStore().filter(e => e.id !== storeId));
  _idbDel(storeId);   // drop the content too, or IndexedDB would grow forever
}
function _updateOverlay(storeId, updates) {
  const list = _loadOverlayStore();
  const e = list.find(e => e.id === storeId);
  if (!e) return false;
  Object.assign(e, updates);
  return _saveOverlayStore(list);
}
function _renameOverlay(storeId, newName) {
  const list = _loadOverlayStore();
  const e = list.find(e => e.id === storeId);
  if (e) { e.name = newName; _saveOverlayStore(list); }
}
function _reorderStore(orderedStoreIds, zById) {
  const list = _loadOverlayStore();
  const byId = {};
  list.forEach(e => { byId[e.id] = e; });
  const reordered = orderedStoreIds.filter(id => byId[id]).map(id => byId[id]);
  list.forEach(e => { if (!orderedStoreIds.includes(e.id)) reordered.push(e); });
  if (zById) reordered.forEach(e => { if (zById[e.id] !== undefined) e.zOrder = zById[e.id]; });
  _saveOverlayStore(reordered);
}

function _extractPlacemarkProps(kmlDoc) {
  const result = [];
  kmlDoc.querySelectorAll('Placemark').forEach(pm => {
    const props = {};
    const nmEl   = [...pm.children].find(c => c.tagName.toLowerCase() === 'name');
    const descEl = [...pm.children].find(c => c.tagName.toLowerCase() === 'description');
    if (nmEl   && nmEl.textContent.trim())   props.name        = nmEl.textContent.trim();
    if (descEl && descEl.textContent.trim()) props.description = descEl.textContent.trim();
    const extData = pm.querySelector('ExtendedData');
    if (extData) {
      extData.querySelectorAll('Data').forEach(d => {
        const k = d.getAttribute('name');
        const vEl = d.querySelector('value');
        if (k && vEl) props[k] = vEl.textContent.trim();
      });
    }
    result.push(props);
  });
  return result;
}

function _flattenKMLLeafLayers(group, result) {
  result = result || [];
  if (typeof group.eachLayer !== 'function') return result;
  group.eachLayer(l => {
    if (typeof l.eachLayer === 'function') _flattenKMLLeafLayers(l, result);
    else result.push(l);
  });
  return result;
}

/* Popup for a GeoJSON/GPX feature: every attribute the file carries, then the measurements.
   It used to fire only when the feature had a name or a description, which meant a plain
   GeoJSON — no such fields, and there is no reason for one to have them — opened no popup at
   all and looked inert. Attribute values are escaped: unlike the KML path, whose values come
   from ExtendedData this app wrote, these can be arbitrary strings from any file. */
function _bindFeaturePopup(feature, layer) {
  const div = document.createElement('div');
  div.style.minWidth = '210px';
  const props = feature && feature.properties;
  const hidden = GEOM_PROP_KEYS.concat(STYLE_PROP_KEYS);
  const visible = props
    ? Object.entries(props).filter(([k, v]) => hidden.indexOf(k) === -1 && v !== null && v !== '' && typeof v !== 'object')
    : [];
  if (visible.length) {
    const propsDiv = document.createElement('div');
    propsDiv.style.cssText = 'margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid var(--border)';
    const tbl = document.createElement('table');
    tbl.style.cssText = 'width:100%;font-size:11px;font-family:monospace';
    tbl.innerHTML = visible.map(([k, v]) => {
      const val = k === 'description' ? stripGeomDescription(v) : v;
      return `<tr><td style="opacity:.65;padding-right:8px;white-space:nowrap">${_xmlEsc(k)}</td><td>${_xmlEsc(val)}</td></tr>`;
    }).join('');
    propsDiv.appendChild(tbl);
    div.appendChild(propsDiv);
  }
  const geomSec = geomInfoSection(feature);
  if (geomSec) {
    if (div.childNodes.length) { geomSec.style.borderTop = 'none'; geomSec.style.paddingTop = '0'; geomSec.style.marginTop = '0'; }
    div.appendChild(geomSec);
  }
  if (!div.childNodes.length) return;
  L.DomEvent.disableClickPropagation(div);
  L.DomEvent.disableScrollPropagation(div);
  layer.bindPopup(div, { maxWidth: 280 });
}

/* ===== SHARED LAYER BUILDER ===== */
/* Parses content into a Leaflet layer and adds it to the list.
   listOpts: passed directly to addLayerToList (opacity, visible, onStateChange, onDelete, noZoom, silent). */
function _addContentLayer(content, name, mime, listOpts) {
  listOpts = listOpts || {};
  if (mime.includes('kml')) {
    const parser = new DOMParser();
    const kmlDoc = parser.parseFromString(content, 'text/xml');
    const parseErr = kmlDoc.querySelector('parsererror');
    if (parseErr) throw new Error('Invalid XML: ' + parseErr.textContent.substring(0, 80));
    const layer = new L.KML(kmlDoc);
    if ((layer.getLayers ? layer.getLayers().length : -1) === 0)
      toastMsg('KML caricato ma vuoto o senza geometrie: ' + name, '', undefined, 'sidebar');
    const propsArray = _extractPlacemarkProps(kmlDoc);
    enhanceKMLLayer(layer, propsArray, kmlDoc);
    addLayerToList(layer, name, content, mime, { ...listOpts, isKml: true });
  } else if (mime.includes('json')) {
    const geoData = JSON.parse(content);
    const layer = L.geoJSON(geoData, {
      style: { color: '#4f8ef7', weight: 2, fillOpacity: 0.3 },
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 6, color: '#4f8ef7' }),
      onEachFeature: (f, l) => _bindFeaturePopup(f, l)
    });
    addLayerToList(layer, name, content, mime, listOpts);
  } else if (mime.includes('gpx')) {
    const gpxDoc = new DOMParser().parseFromString(content, 'text/xml');
    const geoData = toGeoJSON.gpx(gpxDoc);
    const layer = L.geoJSON(geoData, {
      style: { color: '#f0a830', weight: 3 },
      pointToLayer: (f, ll) => L.circleMarker(ll, { radius: 5, color: '#f0a830' }),
      onEachFeature: (f, l) => _bindFeaturePopup(f, l)
    });
    addLayerToList(layer, name, content, mime, listOpts);
  } else {
    throw new Error('Unsupported MIME: ' + mime);
  }
}

/* ===== RESTORE SAVED OVERLAYS AT STARTUP ===== */
let _overlaysRestored = false;
function _restoreFileOverlays() {
  if (_overlaysRestored) return;
  _overlaysRestored = true;
  const list = _loadOverlayStore();
  if (!list.length) { _scheduleLegendSort(); return; }

  /* Every content is fetched BEFORE anything is added: IndexedDB reads resolve out of
     order, and adding as they land would scramble the append order that the legacy
     migration path relies on as a tiebreak. */
  Promise.all(list.map(_readOverlayContent)).then(contents => _replayOverlays(list, contents));
}

function _replayOverlays(list, contents) {
  let restored = 0, migrated = 0;
  list.forEach((e, i) => {
    const content = contents[i];
    /* Content missing (IndexedDB unavailable this launch, or a stale entry): skip, but
       KEEP the metadata — deleting it would turn a transient read failure into real
       data loss. The entry gets another chance on the next launch. */
    if (!content) { console.warn('[giscatasto] no content for overlay:', e.name, '(' + e.id + ')'); return; }
    try {
      const storeId = e.id;
      _addContentLayer(content, e.name, e.mime, {
        storeId,
        opacity:        e.opacity,
        visible:        e.visible,
        color:          e.color || null,
        hollow:         e.hollow || false,
        keepOrder:      true,   // replay the saved order, don't re-apply rank placement
        zOrder:         e.zOrder,
        legacyAbove:    e.above === true,   // pre-zOrder store: used once to migrate
        noZoom:         true,
        silent:         true,
        onStateChange:  upd => _updateOverlay(storeId, upd),
        onColorChange:  color => _updateOverlay(storeId, { color }),
        onHollowChange: hollow => _updateOverlay(storeId, { hollow }),
        onRename:       newName => _renameOverlay(storeId, newName),
        onDelete:       () => _removeOverlay(storeId)
      });
      restored++;
      /* Legacy entry: the content was still inline in localStorage. Move it to
         IndexedDB and strip it from the metadata ONLY once the write has confirmed,
         so a failed migration never loses the file. */
      if (e.content) {
        migrated++;
        _idbPut(e.id, e.content).then(okIdb => { if (okIdb) _updateOverlay(e.id, { content: null }); });
      }
    } catch(err) {
      _removeOverlay(e.id);   // unparseable file: genuinely unusable, drop it
    }
  });
  if (migrated) console.info('[giscatasto] migrated ' + migrated + ' overlay(s) from localStorage to IndexedDB');
  if (restored) toastMsg(restored === 1 ? '1 overlay ripristinato' : restored + ' overlay ripristinati', 'success', undefined, 'sidebar');
  _scheduleLegendSort();
  _idbPruneOrphans(list);
}

/* Contents whose metadata is gone (store cleared, entry removed while offline) would sit
   in IndexedDB forever. Only runs when the metadata list is non-empty: an empty list is
   indistinguishable from a failed read, and pruning on that would wipe everything. */
function _idbPruneOrphans(list) {
  if (!list.length) return;
  _idbKeys().then(keys => {
    if (!keys || !keys.length) return;
    /* The set of known ids is re-read HERE, not captured before the await: metadata is
       written synchronously ahead of its content, so a file imported while this lookup
       was in flight is already in the store — but it would be absent from a snapshot
       taken earlier, and pruning would then delete the content of a file the user just
       loaded. Re-reading closes that window. */
    const known = new Set(_loadOverlayStore().map(e => e.id));
    if (!known.size) return;
    const orphans = keys.filter(k => !known.has(k));
    orphans.forEach(_idbDel);
    if (orphans.length) console.info('[giscatasto] pruned ' + orphans.length + ' orphaned overlay content(s)');
  });
}
document.addEventListener('deviceready', _restoreFileOverlays, { once: true });
setTimeout(_restoreFileOverlays, 350);

/* ===== FILE LOADER ===== */
const uploadArea = document.getElementById('upload-area');
const fileInput  = document.getElementById('file-input');

uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', e => { e.preventDefault(); uploadArea.classList.add('drag-over'); });
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('drag-over'));
uploadArea.addEventListener('drop', e => {
  e.preventDefault();
  uploadArea.classList.remove('drag-over');
  [...e.dataTransfer.files].forEach(loadFile);
});
fileInput.addEventListener('change', e => {
  [...e.target.files].forEach(loadFile);
  fileInput.value = '';
});

function _loadAndPersist(content, name, mime) {
  /* Re-importing a file the app already knows is a REFRESH, not a second copy: it keeps
     its identity and the position the user dragged it to, instead of piling up duplicates
     and jumping back to the top of its rank. If a copy is currently on the map it is
     dropped first, so the reload replaces it in place. */
  const key   = _overlayKey(name, content, mime);
  const known = _loadOverlayStore().find(e => e.key === key);
  const live  = known && document.querySelector(`#layer-list .layer-item[data-store-id="${known.id}"]`);
  let zOrder  = known ? known.zOrder : null;

  if (live) {
    if (live.dataset.zOrder !== undefined && live.dataset.zOrder !== '') zOrder = parseInt(live.dataset.zOrder);
    const liveId = live.dataset.id;
    if (loadedLayers[liveId]) { try { map.removeLayer(loadedLayers[liveId]); } catch(_) {} delete loadedLayers[liveId]; }
    if (live.dataset.ovPane) { const pe = map.getPane(live.dataset.ovPane); if (pe && pe.remove) pe.remove(); }
    live.remove();
  }

  const storeId = known ? known.id
                        : 'ovl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  _persistOverlay(storeId, name, content, mime, 80, true, null, false, key, zOrder);
  _addContentLayer(content, name, mime, {
    storeId,
    zOrder,   // when reclaimed, this places it back where it was instead of by rank
    onStateChange:  upd => _updateOverlay(storeId, upd),
    onColorChange:  color => _updateOverlay(storeId, { color }),
    onHollowChange: hollow => _updateOverlay(storeId, { hollow }),
    onRename:       newName => _renameOverlay(storeId, newName),
    onDelete:       () => _removeOverlay(storeId)
  });
}

function loadFile(file) {
  const name = file.name;
  const ext = name.split('.').pop().toLowerCase();

  if (ext === 'kmz') {
    file.arrayBuffer().then(buf => {
      return JSZip.loadAsync(buf).then(zip => {
        const kmlFiles = zip.file(/\.kml$/i);
        if (!kmlFiles.length) { toastMsg('Nessun KML dentro il KMZ: ' + name, 'error', undefined, 'sidebar'); return; }
        const mainKml = kmlFiles.find(f => f.name.toLowerCase() === 'doc.kml') || kmlFiles[0];
        return mainKml.async('string').then(content => {
          _loadAndPersist(content, name.replace(/\.kmz$/i, '.kml'), 'application/vnd.google-earth.kml+xml');
        });
      });
    }).catch(err => toastMsg('Errore KMZ: ' + (err.message || name), 'error', undefined, 'sidebar'));
    return;
  }

  const mimeMap = {
    kml: 'application/vnd.google-earth.kml+xml',
    geojson: 'application/json', json: 'application/json',
    gpx: 'application/gpx+xml'
  };
  const mime = mimeMap[ext];
  if (!mime) { toastMsg('Formato non supportato: ' + ext, 'error', undefined, 'sidebar'); return; }

  const reader = new FileReader();
  reader.onerror = () => toastMsg('Errore di lettura del file: ' + name, 'error', undefined, 'sidebar');
  reader.onload = ev => {
    const content = ev.target.result;
    if (!content || content.length === 0) { toastMsg('File vuoto: ' + name, 'error', undefined, 'sidebar'); return; }
    try {
      _loadAndPersist(content, name, mime);
    } catch(err) {
      toastMsg('Errore: ' + (err.message || name), 'error', undefined, 'sidebar');
      console.error('loadFile error:', err);
    }
  };
  reader.readAsText(file, 'UTF-8');
}

/* ===== KML VERTEX EDITOR ===== */
let _kmlEditActive = null;

function _startKmlEdit(origLayer, layerId, storeId) {
  if (_kmlEditActive) { toastMsg('Chiudi prima la modifica del KML in corso', 'warn', undefined, 'sidebar'); return; }

  const leaves = _flattenKMLLeafLayers(origLayer);
  if (!leaves.length) { toastMsg('Nessuna geometria modificabile', 'error', undefined, 'sidebar'); return; }

  const tempGroup = L.featureGroup();
  leaves.forEach(l => {
    let clone;
    try {
      if (l instanceof L.Polygon) {
        clone = L.polygon(l.getLatLngs(), { ...l.options });
      } else if (l instanceof L.Polyline) {
        clone = L.polyline(l.getLatLngs(), { ...l.options });
      } else if (l instanceof L.Marker) {
        clone = L.marker(l.getLatLng());
      }
      if (clone) { clone._kmlProps = l._kmlProps; tempGroup.addLayer(clone); }
    } catch(_) {}
  });

  if (!tempGroup.getLayers().length) { toastMsg('Nessuna forma modificabile', 'error', undefined, 'sidebar'); return; }

  try { map.removeLayer(origLayer); } catch(_) {}
  tempGroup.addTo(map);

  const handler = new L.EditToolbar.Edit(map, { featureGroup: tempGroup });
  handler.enable();
  _patchVertexDelete(tempGroup);

  const item = document.querySelector(`[data-id="${layerId}"]`);
  const layerName = item ? item.querySelector('.layer-name').textContent : 'layer';
  _kmlEditActive = { handler, tempGroup, layerId, storeId, origLayer, layerName };

  const bar = document.getElementById('kml-edit-bar');
  if (bar) {
    bar.classList.remove('hidden');
    document.getElementById('kml-edit-label').textContent = 'Modifica: ' + layerName;
  }
}

function _patchVertexDelete(tempGroup) {
  tempGroup.eachLayer(l => _attachVertexDelete(l, tempGroup));
}

// Real vertex bigger than mid; sizes chosen so half-sums fit a typical
// edge — when a segment is so short that the mid would overlap a red,
// the mid is hidden (see _checkMidVisibility).
const _NV_VX_REAL_SIZE = L.Browser.touch ? 24 : 12;
const _NV_VX_MID_SIZE  = L.Browser.touch ? 16 : 10;
const _NV_VX_REAL_ICON = new L.DivIcon({
  iconSize: [_NV_VX_REAL_SIZE, _NV_VX_REAL_SIZE],
  className: 'leaflet-div-icon leaflet-editing-icon nv-vx-real' +
             (L.Browser.touch ? ' leaflet-touch-icon' : '')
});
const _NV_VX_MID_ICON = new L.DivIcon({
  iconSize: [_NV_VX_MID_SIZE, _NV_VX_MID_SIZE],
  className: 'leaflet-div-icon leaflet-editing-icon nv-vx-mid' +
             (L.Browser.touch ? ' leaflet-touch-icon' : '')
});
// Min screen distance from mid center to either real-vertex center. Below
// this the mid bounding-box would overlap a red, so we hide it.
const _NV_VX_MIN_GAP = (_NV_VX_REAL_SIZE + _NV_VX_MID_SIZE) / 2;

function _styleRealVertex(m) {
  if (!m) return;
  m.options.zIndexOffset = 1000;
  try { m.setIcon(_NV_VX_REAL_ICON); } catch(_) {}
  if (typeof m.update === 'function') m.update();
}

function _checkMidVisibility(mid, m1, m2) {
  if (!mid || !mid._icon) return;
  const map = mid._map;
  if (!map) return;
  try {
    const p1 = map.latLngToLayerPoint(m1.getLatLng());
    const p2 = map.latLngToLayerPoint(m2.getLatLng());
    const pm = map.latLngToLayerPoint(mid.getLatLng());
    const tooClose = pm.distanceTo(p1) < _NV_VX_MIN_GAP || pm.distanceTo(p2) < _NV_VX_MIN_GAP;
    mid._icon.style.visibility = tooClose ? 'hidden' : '';
    mid._icon.style.pointerEvents = tooClose ? 'none' : '';
  } catch(_) {}
}

function _attachVertexDelete(layer, tempGroup) {
  if (!layer.editing) return;
  // L.Edit.Poly holds one PolyVerticesEdit handler per ring (outer + holes
  // for polygons, single for polylines). Real vertex markers live on each
  // _verticesHandlers[i]._markers as a flat array.
  const vhs = layer.editing._verticesHandlers;
  if (!vhs || !vhs.length) return;
  const isPolygon = layer instanceof L.Polygon;

  vhs.forEach((vh, ringIdx) => {
    const markers = vh._markers;
    if (!markers) return;
    markers.forEach((m, mi) => {
      _styleRealVertex(m);
      if (m._vdel) return;
      m._vdel = true;
      m.on('dblclick', e => {
        L.DomEvent.stop(e);
        const lls = layer.getLatLngs();
        // For polygons getLatLngs() returns nested rings; for polylines flat
        // (or nested for multi-polylines). Pick the ring matching ringIdx.
        const ring = Array.isArray(lls[0]) ? (lls[ringIdx] || lls[0]) : lls;
        const minLen = isPolygon ? 3 : 2;
        if (ring.length <= minLen) {
          toastMsg(isPolygon ? 'Poligono: minimo 3 vertici' : 'Linea: minimo 2 vertici', 'warn');
          return;
        }
        ring.splice(mi, 1);
        layer.setLatLngs(lls);
        layer.edited = true;
        layer.editing.disable();
        layer.editing.enable();
        _attachVertexDelete(layer, tempGroup);
      });
    });
  });
}

/* Patch middle-vertex markers (cuspidi per aggiungere) so they look
   visually distinct from real vertices and stay below them in z-order. */
(function _patchMidVertexStyle() {
  if (!L.Edit || !L.Edit.PolyVerticesEdit || L.Edit.PolyVerticesEdit.__nvMidPatched) return;
  const proto = L.Edit.PolyVerticesEdit.prototype;
  const orig = proto._createMiddleMarker;
  proto._createMiddleMarker = function (m1, m2) {
    const out = orig.call(this, m1, m2);
    const mid = m1._middleRight;
    if (mid) {
      mid.options.zIndexOffset = 0;
      try { mid.setIcon(_NV_VX_MID_ICON); } catch(_) {}
      if (typeof mid.update === 'function') mid.update();
      const map = this._poly && this._poly._map;
      const check = () => _checkMidVisibility(mid, m1, m2);
      if (mid._icon) check(); else mid.once('add', check);
      if (map) {
        map.on('zoomend', check);
        mid.once('remove', () => map.off('zoomend', check));
      }
      mid.once('dragstart touchmove', () => {
        if (map) map.off('zoomend', check);
        if (mid._icon) {
          mid._icon.style.visibility = '';
          mid._icon.style.pointerEvents = '';
        }
        try { mid.setIcon(_NV_VX_REAL_ICON); } catch(_) {}
        mid.options.zIndexOffset = 1000;
        if (typeof mid.update === 'function') mid.update();
      });
    }
    return out;
  };
  L.Edit.PolyVerticesEdit.__nvMidPatched = true;
})();

function _saveKmlEdit() {
  if (!_kmlEditActive) return;
  const { handler, tempGroup, layerId, storeId, origLayer } = _kmlEditActive;

  handler.save();
  handler.disable();

  const features = [];
  tempGroup.eachLayer(l => {
    try {
      const gj = l.toGeoJSON ? l.toGeoJSON() : null;
      if (!gj) return;
      gj.properties = gj.properties || {};
      if (l._kmlProps) Object.assign(gj.properties, l._kmlProps);
      /* Stamped after the merge, not before: _kmlProps carries the measurements of the shape
         as it was loaded, and the whole point of this pass is that the shape just changed. */
      stampGeomInfo(gj);
      features.push(gj);
    } catch(_) {}
  });

  try { map.removeLayer(tempGroup); } catch(_) {}
  const bar = document.getElementById('kml-edit-bar');
  if (bar) bar.classList.add('hidden');
  _kmlEditActive = null;

  if (!features.length) {
    try { origLayer.addTo(map); } catch(_) {}
    loadedLayers[layerId] = origLayer;
    toastMsg('Nessuna geometria: modifica annullata', 'warn', undefined, 'sidebar');
    return;
  }

  const newKmlContent = tokml({ type: 'FeatureCollection', features });
  try {
    const kmlDoc = new DOMParser().parseFromString(newKmlContent, 'text/xml');
    const newLayer = new L.KML(kmlDoc);
    enhanceKMLLayer(newLayer, _extractPlacemarkProps(kmlDoc), kmlDoc);
    newLayer.addTo(map);
    loadedLayers[layerId] = newLayer;
    /* The ⬇ button reads from here, so the edited geometry has to land before the user can
       press it — otherwise the export writes the shape as it was before the edit. */
    _rawContentById[layerId] = newKmlContent;
    const _editItem = document.querySelector(`[data-id="${layerId}"]`);
    if (_editItem) {
      const _cp = _editItem.querySelector('.layer-color');
      if (_cp) setLayerColor(newLayer, _cp.value);
      const _op = _editItem.querySelector('.layer-opacity');
      if (_op) setLayerOpacity(newLayer, parseInt(_op.value));
    }
    if (storeId) {
      /* Edited geometry goes back to the content store (IndexedDB, or inline on fallback).
         The write is async now, so confirm only once it has actually landed: announcing
         "saved" before the write completes would claim durability the edit does not yet
         have. The old synchronous path could not report a failed write at all. */
      _writeOverlayContent(storeId, newKmlContent)
        .then(() => toastMsg('KML salvato', 'success', undefined, 'sidebar'))
        .catch(() => toastMsg('KML modificato, ma non salvato in memoria', 'warn', undefined, 'sidebar'));
    } else {
      toastMsg('KML salvato', 'success', undefined, 'sidebar');
    }
  } catch(err) {
    try { origLayer.addTo(map); } catch(_) {}
    loadedLayers[layerId] = origLayer;
    toastMsg('Errore di salvataggio: ' + (err.message || ''), 'error', undefined, 'sidebar');
  }
}

function _cancelKmlEdit() {
  if (!_kmlEditActive) return;
  const { handler, tempGroup, origLayer, layerId } = _kmlEditActive;
  try { handler.revertLayers(); handler.disable(); } catch(_) {}
  try { map.removeLayer(tempGroup); } catch(_) {}
  try { origLayer.addTo(map); } catch(_) {}
  loadedLayers[layerId] = origLayer;
  const bar = document.getElementById('kml-edit-bar');
  if (bar) bar.classList.add('hidden');
  _kmlEditActive = null;
  toastMsg('Modifica annullata', '', undefined, 'sidebar');
}

/* ===== DISSOLVE WIZARD ===== */
/* Douglas-Peucker tolerance applied to the union, in degrees. Zero on purpose: the
   cadastral vertices come from the source geometry and must survive the dissolve
   untouched — any non-zero value moves the boundary of the result. The simplify call
   is kept because at 0 it still drops duplicate and exactly collinear vertices. */
const _DISSOLVE_TOLERANCE = 0;

function _dissolveUpdateBtn() {
  const ok = document.getElementById('dissolve-ok');
  if (!ok) return;
  const any = !!document.querySelector('#dissolve-picker-list input[type=checkbox]:checked');
  ok.disabled = !any;
  ok.className = any ? 'btn btn-success' : 'btn btn-secondary';
}

function _startDissolve() {
  if (typeof turf === 'undefined') {
    toastMsg('Turf.js non caricato: metti turf.min.js nella cartella dell’app', 'error', undefined, 'sidebar'); return;
  }
  if (_kmlEditActive) { toastMsg('Chiudi prima la modifica del KML', 'warn', undefined, 'sidebar'); return; }

  const kmlEntries = Object.entries(loadedLayers).filter(([, l]) =>
    l && !l._isRaster && _flattenKMLLeafLayers(l).some(ll => ll instanceof L.Polygon)
  );
  if (!kmlEntries.length) { toastMsg('Nessun layer KML con poligoni caricato', 'warn', undefined, 'sidebar'); return; }

  const list = document.getElementById('dissolve-picker-list');
  const picker = document.getElementById('dissolve-picker');
  if (!list || !picker) return;

  list.innerHTML = kmlEntries.map(([id]) => {
    const nameEl = document.querySelector(`[data-id="${id}"] .layer-name`);
    const name = (nameEl ? nameEl.textContent : id).replace(/</g, '&lt;');
    return `<label style="display:flex;align-items:center;gap:8px;padding:4px 0;cursor:pointer">` +
           `<input type="checkbox" data-dissolve-id="${id}" style="width:16px;height:16px">` +
           `<span style="font-size:13px">${name}</span></label>`;
  }).join('');

  list.querySelectorAll('input[type=checkbox]').forEach(cb =>
    cb.addEventListener('change', _dissolveUpdateBtn)
  );

  picker.classList.remove('hidden');
  const wrap = document.getElementById('dissolve-progress-wrap');
  if (wrap) wrap.classList.add('hidden');
  _dissolveUpdateBtn();
}

function _cancelDissolve() {
  const picker = document.getElementById('dissolve-picker');
  if (picker) picker.classList.add('hidden');
}

function _proceedDissolve() {
  const checked = document.querySelectorAll('#dissolve-picker-list input[type=checkbox]:checked');
  if (!checked.length) return;

  const features = [];
  checked.forEach(cb => {
    const layer = loadedLayers[cb.dataset.dissolveId];
    if (!layer) return;
    _flattenKMLLeafLayers(layer).forEach(l => {
      if (!(l instanceof L.Polygon)) return;
      try { const gj = l.toGeoJSON(); if (gj) features.push(gj); } catch(_) {}
    });
  });
  if (!features.length) { toastMsg('Nessun poligono nei layer scelti', 'error', undefined, 'sidebar'); return; }

  const ok = document.getElementById('dissolve-ok');
  const wrap = document.getElementById('dissolve-progress-wrap');
  const fill = document.getElementById('dissolve-progress-fill');
  const txt  = document.getElementById('dissolve-progress-text');
  if (ok) ok.disabled = true;
  if (wrap) wrap.classList.remove('hidden');
  if (fill) fill.style.width = '10%';
  if (txt)  txt.textContent = 'Fusione di ' + features.length + ' features…';

  // Defer heavy work so the progress bar renders first
  setTimeout(() => {
    let result;
    try {
      if (fill) fill.style.width = '40%';
      result = turf.union(turf.featureCollection(features));
    } catch(_) {
      try {
        result = features[0];
        for (let i = 1; i < features.length; i++) {
          result = turf.union(result, features[i]);
          if (fill) fill.style.width = (40 + Math.round(40 * i / features.length)) + '%';
        }
      } catch(err) {
        if (wrap) wrap.classList.add('hidden');
        if (ok) { ok.disabled = false; ok.className = 'btn btn-success'; }
        toastMsg('Errore nella dissolvenza: ' + (err.message || ''), 'error', undefined, 'sidebar'); return;
      }
    }

    if (!result || !result.geometry) {
      if (wrap) wrap.classList.add('hidden');
      if (ok) { ok.disabled = false; ok.className = 'btn btn-success'; }
      toastMsg('Dissolvenza non riuscita', 'error', undefined, 'sidebar'); return;
    }

    if (fill) fill.style.width = '80%';
    if (txt)  txt.textContent = 'Semplificazione…';

    setTimeout(() => {
      try { result = turf.simplify(result, { tolerance: _DISSOLVE_TOLERANCE, highQuality: true }); } catch(_) {}
      if (!result || !result.geometry) {
        if (wrap) wrap.classList.add('hidden');
        if (ok) { ok.disabled = false; ok.className = 'btn btn-success'; }
        toastMsg('Dissolvenza non riuscita nemmeno dopo la semplificazione', 'error', undefined, 'sidebar'); return;
      }
      try {
        const coords = result.geometry.coordinates;
        if (result.geometry.type === 'Polygon' && coords.length > 1) {
          result = turf.polygon([coords[0]], result.properties);
        } else if (result.geometry.type === 'MultiPolygon') {
          result = turf.multiPolygon(coords.map(rings => [rings[0]]), result.properties);
        }
      } catch(_) {}

      if (fill) fill.style.width = '100%';
      if (txt)  txt.textContent = 'Fatto';

      setTimeout(() => {
        _cancelDissolve();
        const modal = document.getElementById('dissolve-modal');
        if (modal) {
          document.getElementById('dissolve-name-input').value = '';
          document.getElementById('dissolve-desc-input').value = '';
          modal.classList.remove('hidden');
          document.getElementById('dissolve-modal-ok').onclick = () => {
            const rawName = (document.getElementById('dissolve-name-input').value || '').trim() || 'Dissolved';
            const name = rawName.replace(/\.kml$/i, '');
            const desc = (document.getElementById('dissolve-desc-input').value || '').trim();
            modal.classList.add('hidden');
            result.properties = { name, description: desc };
            if (typeof _styleFeatureForKml === 'function') _styleFeatureForKml(result, '#4f8ef7', 1);
            // The merged area is the point of a dissolve, so it ships with the file.
            stampGeomInfo(result);
            const kmlContent = tokml({ type: 'FeatureCollection', features: [result] }, TOKML_OPTS);
            _loadAndPersist(kmlContent, name + '.kml', 'application/vnd.google-earth.kml+xml');
            downloadFile(kmlContent, name + '.kml', 'application/vnd.google-earth.kml+xml');
            toastMsg('Layer caricato: ' + name, 'success', undefined, 'sidebar');
          };
          document.getElementById('dissolve-modal-cancel').onclick = () => {
            modal.classList.add('hidden');
          };
        }
      }, 400);
    }, 30);
  }, 30);
}

/* ===== DOM LISTENERS (layers panel) ===== */
document.addEventListener('DOMContentLoaded', () => {
  const kmlSave   = document.getElementById('kml-edit-save');
  const kmlCancel = document.getElementById('kml-edit-cancel');
  if (kmlSave)   kmlSave.addEventListener('click', _saveKmlEdit);
  if (kmlCancel) kmlCancel.addEventListener('click', _cancelKmlEdit);

  const dissolveBtn    = document.getElementById('btn-dissolve');
  const dissolveOk     = document.getElementById('dissolve-ok');
  const dissolveCancel = document.getElementById('dissolve-cancel');
  if (dissolveBtn)    dissolveBtn.addEventListener('click', _startDissolve);
  if (dissolveOk)     dissolveOk.addEventListener('click', _proceedDissolve);
  if (dissolveCancel) dissolveCancel.addEventListener('click', _cancelDissolve);
  // Close picker if Draw panel is closed
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.panel !== 'draw') _cancelDissolve();
    });
  });
});
