/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
/* =====================================================
   DRAW — marker icons, draw events, GPS track
===================================================== */

/* ===== MARKER ICONS ===== */
function _mki(paths) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24">${paths}</svg>`;
}
const MARKER_ICONS = [
  { e:'pos',    l:'Position',
    html: _mki('<circle cx="12" cy="12" r="9" fill="#4f8ef7" stroke="white" stroke-width="1.5"/><circle cx="12" cy="12" r="3.5" fill="white"/>') },
  { e:'hq',     l:'HQ / Command',
    html: _mki('<rect x="3" y="3" width="18" height="18" fill="#f5a623" stroke="white" stroke-width="1.5"/><text x="12" y="16.5" font-size="10" font-weight="900" fill="white" text-anchor="middle" font-family="Arial,sans-serif">C</text>') },
  { e:'med',    l:'Medical Aid',
    html: _mki('<rect x="2" y="2" width="20" height="20" rx="3" fill="white" stroke="#ef5350" stroke-width="1"/><rect x="9.5" y="4" width="5" height="16" fill="#ef5350"/><rect x="4" y="9.5" width="16" height="5" fill="#ef5350"/>') },
  { e:'rally',  l:'Rally Point',
    html: _mki('<polygon points="12,2 22,21 2,21" fill="#4caf7d" stroke="white" stroke-width="1.5"/><text x="12" y="19" font-size="9" font-weight="900" fill="white" text-anchor="middle" font-family="Arial,sans-serif">R</text>') },
  { e:'danger', l:'Danger Zone',
    html: _mki('<polygon points="12,2 22,21 2,21" fill="#f5a623" stroke="white" stroke-width="1.5"/><text x="12" y="19.5" font-size="13" font-weight="900" fill="white" text-anchor="middle" font-family="Arial,sans-serif">!</text>') },
  { e:'block',  l:'Obstacle / Block',
    html: _mki('<circle cx="12" cy="12" r="9" fill="#ef5350" stroke="white" stroke-width="1.5"/><line x1="7" y1="7" x2="17" y2="17" stroke="white" stroke-width="2.5" stroke-linecap="round"/><line x1="17" y1="7" x2="7" y2="17" stroke="white" stroke-width="2.5" stroke-linecap="round"/>') },
  { e:'cp',     l:'Checkpoint',
    html: _mki('<polygon points="12,2 22,12 12,22 2,12" fill="#ffd600" stroke="white" stroke-width="1.5"/><text x="12" y="16" font-size="7.5" font-weight="900" fill="#333" text-anchor="middle" font-family="Arial,sans-serif">CP</text>') },
  { e:'heli',   l:'Helipad',
    html: _mki('<rect x="3" y="3" width="18" height="18" rx="2" fill="#1565c0" stroke="white" stroke-width="1.5"/><text x="12" y="17" font-size="13" font-weight="900" fill="white" text-anchor="middle" font-family="Arial,sans-serif">H</text>') },
  { e:'fuel',   l:'Resupply',
    html: _mki('<circle cx="12" cy="12" r="9" fill="#2e7d52" stroke="white" stroke-width="1.5"/><text x="12" y="16.5" font-size="11" font-weight="900" fill="white" text-anchor="middle" font-family="Arial,sans-serif">F</text>') },
  { e:'target', l:'Target',
    html: _mki('<circle cx="12" cy="12" r="9" fill="none" stroke="#ef5350" stroke-width="2"/><circle cx="12" cy="12" r="4" fill="none" stroke="#ef5350" stroke-width="2"/><line x1="12" y1="2" x2="12" y2="7" stroke="#ef5350" stroke-width="2"/><line x1="12" y1="17" x2="12" y2="22" stroke="#ef5350" stroke-width="2"/><line x1="2" y1="12" x2="7" y2="12" stroke="#ef5350" stroke-width="2"/><line x1="17" y1="12" x2="22" y2="12" stroke="#ef5350" stroke-width="2"/>') },
  { e:'friend', l:'Friendly Force',
    html: _mki('<rect x="2" y="6" width="20" height="12" fill="#4f8ef7" stroke="white" stroke-width="1.5"/>') },
  { e:'enemy',  l:'Hostile Force',
    html: _mki('<polygon points="12,22 2,4 22,4" fill="#ef5350" stroke="white" stroke-width="1.5"/>') },
  { e:'fire',   l:'Fire',
    html: _mki('<path d="M12 2c0 0-6 6-6 11a6 6 0 0 0 12 0C18 8 12 2 12 2z" fill="#ef5350" stroke="white" stroke-width="0.5"/><path d="M12 8c0 0-3 3-3 5.5a3 3 0 0 0 6 0C15 11 12 8 12 8z" fill="#f5a623"/>') },
  { e:'flood',  l:'Flood',
    html: _mki('<rect x="2" y="2" width="20" height="20" rx="3" fill="#1565c0" stroke="white" stroke-width="1"/><path d="M2 13 Q5.5 9.5 9 13 Q12.5 16.5 16 13 Q18 11 22 13" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/><path d="M2 17.5 Q5.5 14 9 17.5 Q12.5 21 16 17.5 Q18 15.5 22 17.5" fill="none" stroke="white" stroke-width="2" stroke-linecap="round"/>') },
  { e:'evac',   l:'Evacuation',
    html: _mki('<rect x="2" y="2" width="20" height="20" rx="3" fill="#4caf7d" stroke="white" stroke-width="1"/><polygon points="12,4 19,13 15.5,13 15.5,20 8.5,20 8.5,13 5,13" fill="white"/>') },
  { e:'camp',   l:'Base Camp',
    html: _mki('<polygon points="12,3 22,19 2,19" fill="#2e7d52" stroke="white" stroke-width="1.5"/><rect x="9" y="14" width="6" height="5" fill="rgba(255,255,255,0.85)"/>') },
];

function makeEmojiIcon(iconId) {
  const icon = MARKER_ICONS.find(i => i.e === iconId) || MARKER_ICONS[0];
  return L.divIcon({
    html: `<span style="display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,.8));line-height:1">${icon.html}</span>`,
    className: '', iconSize: [28,28], iconAnchor: [14,26], popupAnchor: [0,-28]
  });
}

/* ===== SCHEDULED SAVE (debounce for popup attribute changes) ===== */
let _saveTimer = null;
function _scheduleSave() {
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(_saveDraws, 500);
}

/* ===== DRAW POPUP BUILDER ===== */
function _openDrawPopup(layer, type) {
  const popup = document.createElement('div');
  popup.style.minWidth = '210px';

  const area = calcArea(layer);
  const len  = calcLength(layer);
  let infoHtml = '';
  if (area) infoHtml += `<div class="r-label">Area: <span class="r-val">${area}</span></div>`;
  if (len)  infoHtml += `<div class="r-label">Length: <span class="r-val">${len}</span></div>`;
  if (infoHtml) {
    const infoDiv = document.createElement('div');
    infoDiv.innerHTML = infoHtml;
    infoDiv.style.cssText = 'margin-bottom:6px;font-size:12px';
    popup.appendChild(infoDiv);
  }

  const nameInput = document.createElement('input');
  nameInput.type = 'text'; nameInput.className = 'draw-desc-input';
  nameInput.placeholder = 'Nome del segnaposto'; nameInput.style.marginBottom = '4px';
  nameInput.value = layer._geoName || '';
  nameInput.addEventListener('input', () => { layer._geoName = nameInput.value; _scheduleSave(); });
  popup.appendChild(nameInput);

  if (type === 'marker') {
    const pickerDiv = document.createElement('div');
    pickerDiv.className = 'icon-picker';
    let activeBtn = null;
    MARKER_ICONS.forEach(icon => {
      const btn = document.createElement('button');
      const isActive = icon.e === (layer._geoIcon || 'pos');
      btn.className = 'icon-btn' + (isActive ? ' selected' : '');
      btn.title = icon.l; btn.innerHTML = icon.html;
      if (isActive) activeBtn = btn;
      btn.addEventListener('click', ev => {
        ev.stopPropagation();
        if (activeBtn) activeBtn.classList.remove('selected');
        btn.classList.add('selected'); activeBtn = btn;
        layer._geoIcon = icon.e;
        layer.setIcon(makeEmojiIcon(icon.e));
        _saveDraws();
        setTimeout(() => layer.openPopup(), 30);
      });
      pickerDiv.appendChild(btn);
    });
    popup.appendChild(pickerDiv);
  }

  if (type !== 'marker') {
    const colorRow = document.createElement('div');
    colorRow.className = 'draw-color-row';
    const lbl = document.createElement('label'); lbl.textContent = 'Colore:';
    const colorInput = document.createElement('input');
    colorInput.type = 'color'; colorInput.value = layer._geoColor || '#4f8ef7';
    colorInput.addEventListener('input', () => {
      layer._geoColor = colorInput.value;
      const o = layer._geoOpacity !== undefined ? layer._geoOpacity : 1;
      if (typeof layer.setStyle === 'function')
        layer.setStyle({ color: colorInput.value, fillColor: colorInput.value, fillOpacity: o * 0.3 });
      _scheduleSave();
    });
    colorRow.appendChild(lbl); colorRow.appendChild(colorInput); popup.appendChild(colorRow);

    const opRow = document.createElement('div');
    opRow.className = 'draw-color-row';
    const opLbl = document.createElement('label'); opLbl.textContent = 'Opacità:';
    const opSlider = document.createElement('input');
    opSlider.type = 'range'; opSlider.min = 0; opSlider.max = 100;
    opSlider.value = Math.round((layer._geoOpacity !== undefined ? layer._geoOpacity : 1) * 100);
    opSlider.style.flex = '1';
    const opVal = document.createElement('span');
    opVal.style.cssText = 'font-size:10px;min-width:32px;text-align:right;color:var(--text-muted)';
    opVal.textContent = opSlider.value + '%';
    opSlider.addEventListener('input', () => {
      layer._geoOpacity = parseInt(opSlider.value) / 100;
      opVal.textContent = opSlider.value + '%';
      const o = layer._geoOpacity;
      const col = layer._geoColor || '#4f8ef7';
      if (typeof layer.setStyle === 'function')
        layer.setStyle({ opacity: o, fillOpacity: o * 0.3, color: col, fillColor: col });
      _scheduleSave();
    });
    opRow.appendChild(opLbl); opRow.appendChild(opSlider); opRow.appendChild(opVal);
    popup.appendChild(opRow);
  }

  const descInput = document.createElement('input');
  descInput.type = 'text'; descInput.className = 'draw-desc-input';
  descInput.placeholder = 'Descrizione (facoltativa)'; descInput.value = layer._geoDesc || '';
  descInput.addEventListener('input', () => { layer._geoDesc = descInput.value; _scheduleSave(); });
  popup.appendChild(descInput);

  const autoHint = document.createElement('p');
  autoHint.style.cssText = 'font-size:10px;color:var(--text-muted);margin:2px 0 6px;';
  autoHint.textContent = 'Nome e descrizione si salvano da soli.';
  popup.appendChild(autoHint);

  const filenameInput = document.createElement('input');
  filenameInput.type = 'text'; filenameInput.className = 'draw-desc-input';
  filenameInput.placeholder = 'Nome del file (senza .kml)';
  filenameInput.style.cssText = 'margin-top:2px;font-size:11px';
  popup.appendChild(filenameInput);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'draw-save-btn'; saveBtn.textContent = '\u2B07 Salva in KML';
  saveBtn.addEventListener('click', () => {
    const json = layerToGeoJSON(layer);
    json.properties = json.properties || {};
    json.properties.name        = nameInput.value.trim() || 'Placemark';
    json.properties.description = descInput.value;
    _applySimpleStyle(json.properties, layer);
    layer._geoName = json.properties.name;
    layer._geoDesc = json.properties.description;
    const kml  = tokml(json, { simplestyle: true });
    const safe = json.properties.name.replace(/[^\w\-]/g, '_');
    const baseName = (filenameInput.value.trim() || safe || 'shape').replace(/\.kml$/i, '');
    downloadFile(kml, baseName + '.kml', 'application/vnd.google-earth.kml+xml');
  });
  popup.appendChild(saveBtn);

  const delBtn = document.createElement('button');
  delBtn.className = 'draw-del-btn';
  delBtn.textContent = 'Elimina forma';
  delBtn.addEventListener('click', () => {
    if (confirm('Eliminare questa forma?')) {
      layer.closePopup();
      drawnItems.removeLayer(layer);
      _saveDraws();
      updateDrawStats();
      toastMsg('Forma eliminata', '');
    }
  });
  popup.appendChild(delBtn);

  layer.bindPopup(popup, { maxWidth: 280 });
  layer.openPopup();
}

/* ===== DRAW EVENTS ===== */
map.on(L.Draw.Event.CREATED, e => {
  const layer = e.layer, type = e.layerType;
  _assignDrawPane(layer);
  drawnItems.addLayer(layer);
  updateDrawStats(layer);
  layer._geoName = ''; layer._geoDesc = ''; layer._geoIcon = 'pos'; layer._geoColor = '#4f8ef7';
  layer._geoType = type; layer._geoOpacity = 1;
  if (type === 'marker') layer.setIcon(makeEmojiIcon('pos'));
  _openDrawPopup(layer, type);
  _saveDraws();
  toastMsg('Forma aggiunta e salvata', 'success');
});
map.on(L.Draw.Event.EDITED, e => { updateDrawStats(); _saveDraws(); toastMsg('Forme modificate e salvate', 'success'); });

function updateDrawStats(layer) {
  const count = drawnItems.getLayers().length;
  document.getElementById('stat-count').textContent = count;
  if (layer) {
    const a = calcArea(layer), l = calcLength(layer);
    document.getElementById('stat-area').textContent = a || '--';
    document.getElementById('stat-dist').textContent = l || '--';
  }
  _refreshDrawButtons();
}

/* Enable the "manage drawings" actions only when at least one shape exists.
   The buttons stay visible so the feature remains discoverable; they just go
   inert until they can do something. The per-action guards further down remain
   in place as a safety net for any mutation path that doesn't route through
   updateDrawStats (e.g. the Leaflet.Draw delete toolbar). */
function _refreshDrawButtons() {
  const has = drawnItems.getLayers().length > 0;
  ['btn-export-all-kml', 'btn-export-all-geojson', 'btn-clear-draw'].forEach(id => {
    const b = document.getElementById(id);
    if (!b) return;
    b.disabled = !has;
    b.title = has ? '' : 'Disegna prima una forma sulla mappa';
  });
}
_refreshDrawButtons();

/* Inject simplestyle-spec props from layer style so tokml({simplestyle:true})
   emits <LineStyle>/<PolyStyle>. Skips markers (no line/poly style applies). */
function _applySimpleStyle(props, layer) {
  if (!layer) return;
  const color = layer._geoColor || '#4f8ef7';
  // Markers: emit marker-color so Google Earth colours the pin (opacity is not
  // expressible in the simplestyle spec for points — only the colour transfers).
  if (layer instanceof L.Marker) { props['marker-color'] = color; return; }
  const op    = layer._geoOpacity !== undefined ? layer._geoOpacity : 1;
  props.stroke           = color;
  props['stroke-opacity'] = op;
  props['stroke-width']   = 2;
  // Polygons / Circles → also fill (LineString → tokml will emit only LineStyle)
  if (layer instanceof L.Polygon || layer instanceof L.Circle) {
    props.fill           = color;
    props['fill-opacity'] = op * 0.3;
  }
}

/* Same as above but for a raw GeoJSON feature with no Leaflet layer behind it (WFS
   selection, dissolve result): takes colour + opacity directly and injects simplestyle
   props, so those exports carry symbology into Google Earth instead of rendering as the
   default white/opaque. tokml({simplestyle:true}) then emits Poly/Line/IconStyle. */
function _styleFeatureForKml(f, color, opacity) {
  if (!f) return;
  f.properties = f.properties || {};
  const gt = (f.geometry && f.geometry.type) || '';
  if (/Point/.test(gt)) { f.properties['marker-color'] = color; return; }
  f.properties.stroke = color;
  f.properties['stroke-opacity'] = opacity;
  f.properties['stroke-width'] = 2;
  if (/Polygon/.test(gt)) { f.properties.fill = color; f.properties['fill-opacity'] = opacity * 0.3; }
}

function layerToGeoJSON(layer) {
  if (layer instanceof L.Circle) {
    const c = layer.getLatLng(), r = layer.getRadius(), n = 64, pts = [];
    for (let i=0; i<n; i++) {
      const angle = (i/n) * 2 * Math.PI;
      const dLat  = (r * Math.cos(angle)) / 111320;
      const dLon  = (r * Math.sin(angle)) / (111320 * Math.cos(c.lat * Math.PI/180));
      pts.push([c.lng+dLon, c.lat+dLat]);
    }
    pts.push(pts[0]);
    return { type:'Feature', geometry:{ type:'Polygon', coordinates:[pts] }, properties:{} };
  }
  return layer.toGeoJSON();
}

/* ===== EXPORT ALL ===== */
document.getElementById('btn-export-all-kml').addEventListener('click', () => {
  const layers = drawnItems.getLayers();
  if (!layers.length) { toastMsg('Nessuna forma da esportare', 'error', undefined, 'sidebar'); return; }
  showPromptModal('Nome del file (senza estensione):', 'drawings', fname => {
    const base = ((fname || 'drawings').trim() || 'drawings').replace(/\.kml$/i, '');
    const features = layers.map(l => {
      const f = layerToGeoJSON(l); f.properties = f.properties || {};
      if (l._geoName) f.properties.name = l._geoName;
      if (l._geoDesc) f.properties.description = l._geoDesc;
      _applySimpleStyle(f.properties, l);
      return f;
    });
    downloadFile(tokml({ type:'FeatureCollection', features }, { simplestyle: true }),
      base + '.kml', 'application/vnd.google-earth.kml+xml');
  });
});

document.getElementById('btn-export-all-geojson').addEventListener('click', () => {
  const layers = drawnItems.getLayers();
  if (!layers.length) { toastMsg('Nessuna forma da esportare', 'error', undefined, 'sidebar'); return; }
  showPromptModal('Nome del file (senza estensione):', 'drawings', fname => {
    fname = ((fname || 'drawings').trim() || 'drawings').replace(/\.geojson$/i, '').replace(/\.json$/i, '');
    const features = layers.map(l => {
      const f = layerToGeoJSON(l); f.properties = f.properties || {};
      if (l._geoName)  f.properties.name     = l._geoName;
      if (l._geoDesc)  f.properties.description = l._geoDesc;
      if (l._geoColor) f.properties.color    = l._geoColor;
      if (l._geoIcon)  f.properties.icon     = l._geoIcon;
      if (l._geoType)  f.properties.drawType = l._geoType;
      if (l._geoOpacity !== undefined) f.properties.opacity = l._geoOpacity;
      return f;
    });
    downloadFile(JSON.stringify({ type:'FeatureCollection', features }, null, 2), fname + '.geojson', 'application/json');
  });
});

/* ===== IMPORT GEOJSON ===== */
document.getElementById('btn-import-geojson').addEventListener('click', () => {
  document.getElementById('import-geojson-input').value = '';
  document.getElementById('import-geojson-input').click();
});

document.getElementById('import-geojson-input').addEventListener('change', function () {
  const file = this.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function (e) {
    let fc;
    try { fc = JSON.parse(e.target.result); } catch (_) { toastMsg('File JSON non valido', 'error', undefined, 'sidebar'); return; }
    if (!fc || !Array.isArray(fc.features)) { toastMsg('Non è una FeatureCollection GeoJSON valida', 'error', undefined, 'sidebar'); return; }
    let imported = 0;

    // Expand Multi* types into individual simple geometries
    const expanded = [];
    fc.features.forEach(f => {
      if (!f.geometry) return;
      const t = f.geometry.type;
      if (t === 'MultiPoint') {
        f.geometry.coordinates.forEach(c => expanded.push({ ...f, geometry: { type: 'Point', coordinates: c } }));
      } else if (t === 'MultiLineString') {
        f.geometry.coordinates.forEach(c => expanded.push({ ...f, geometry: { type: 'LineString', coordinates: c } }));
      } else if (t === 'MultiPolygon') {
        f.geometry.coordinates.forEach(c => expanded.push({ ...f, geometry: { type: 'Polygon', coordinates: c } }));
      } else {
        expanded.push(f);
      }
    });

    expanded.forEach(f => {
      if (!f.geometry) return;
      const p = f.properties || {};
      // support both auto-save format (_geoName) and export format (name/color/icon/drawType)
      const name    = p._geoName    || p.name        || '';
      const desc    = p._geoDesc    || p.description || '';
      const icon    = p._geoIcon    || p.icon        || 'pos';
      const color   = p._geoColor   || p.color       || '#4f8ef7';
      const opacity = p._geoOpacity !== undefined ? p._geoOpacity : 1;
      const type    = p._geoType    || p.drawType;
      let layer;
      if (f.geometry.type === 'Point') {
        const [lng, lat] = f.geometry.coordinates;
        layer = L.marker([lat, lng]);
        layer.setIcon(makeEmojiIcon(icon));
        layer._geoType = 'marker';
      } else if (f.geometry.type === 'LineString') {
        const lls = f.geometry.coordinates.map(c => [c[1], c[0]]);
        layer = L.polyline(lls, { color, opacity });
        layer._geoType = type || 'polyline';
      } else if (f.geometry.type === 'Polygon') {
        const rings = f.geometry.coordinates.map(ring => ring.map(c => [c[1], c[0]]));
        layer = L.polygon(rings, { color, fillColor: color, opacity, fillOpacity: opacity * 0.3 });
        layer._geoType = type || 'polygon';
      } else {
        return;
      }
      layer._geoName    = name;
      layer._geoDesc    = desc;
      layer._geoIcon    = icon;
      layer._geoColor   = color;
      layer._geoOpacity = opacity;
      layer.on('click', () => _openDrawPopup(layer, layer._geoType));
      _assignDrawPane(layer);
      drawnItems.addLayer(layer);
      imported++;
    });
    if (imported) {
      _saveDraws();
      updateDrawStats();
      toastMsg('Importate ' + imported + ' shape' + (imported > 1 ? 's' : ''), 'success', undefined, 'sidebar');
    } else {
      toastMsg('Nessuna forma compatibile trovata', 'error', undefined, 'sidebar');
    }
  };
  reader.readAsText(file);
});

document.getElementById('btn-clear-draw').addEventListener('click', () => {
  if (!drawnItems.getLayers().length) { toastMsg('Non c’è nessuna forma', '', undefined, 'sidebar'); return; }
  if (confirm('Sei sicuro? Tutti i disegni andranno persi.')) {
    drawnItems.clearLayers();
    _saveDraws();
    updateDrawStats();
    toastMsg('Disegni cancellati', '', undefined, 'sidebar');
  }
});

/* ===== GPS TRACK ===== */
let trackActive = false, trackPoints = [], trackDistance = 0, trackPolyline = null;

function updateTrack(ll, alt, ts) {
  if (trackPoints.length > 0) {
    const prev = trackPoints[trackPoints.length - 1];
    trackDistance += map.distance([prev.lat, prev.lng], [ll.lat, ll.lng]);

    // Bearing in statusbar
    const brg = calcBearing(prev.lat, prev.lng, ll.lat, ll.lng);
    const dirs = ['N','NE','E','SE','S','SW','W','NW'];
    const dir  = dirs[Math.round(brg/45) % 8];
    const brgItem = document.getElementById('sb-brg-item');
    const brgEl   = document.getElementById('sb-brg');
    if (brgItem && brgEl) {
      brgEl.textContent = Math.round(brg) + '\u00b0 ' + dir;
      brgItem.style.display = '';
    }
  }
  trackPoints.push({ lat: ll.lat, lng: ll.lng, alt, time: ts });

  const lls = trackPoints.map(p => [p.lat, p.lng]);
  if (trackPolyline) trackPolyline.setLatLngs(lls);
  else trackPolyline = L.polyline(lls, { color: '#e05252', weight: 3, opacity: 0.85 }).addTo(map);

  document.getElementById('track-pts').textContent  = trackPoints.length;
  const d = trackDistance;
  document.getElementById('track-dist').textContent = d >= 1000 ? (d/1000).toFixed(2) + ' km' : Math.round(d) + ' m';
}

function exportGPX() {
  if (!trackPoints.length) { toastMsg('La traccia non ha punti', 'error', undefined, 'sidebar'); return; }
  const pts = trackPoints.map(p =>
    `    <trkpt lat="${p.lat}" lon="${p.lng}">` +
    (p.alt != null ? `<ele>${p.alt.toFixed(1)}</ele>` : '') +
    `<time>${new Date(p.time).toISOString()}</time></trkpt>`
  ).join('\n');
  showPromptModal('Nome del file:', 'track', fname => {
    const base = (((fname || 'track').trim() || 'track')).replace(/\.gpx$/i, '');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="GISCatasto" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${_xmlEsc(base)}</name><trkseg>\n${pts}\n  </trkseg></trk>\n</gpx>`;
    downloadFile(gpx, base + '.gpx', 'application/gpx+xml');
  }, 'The .gpx file is saved to your device Downloads folder.');
}

document.getElementById('btn-track-toggle').addEventListener('click', () => {
  const btn = document.getElementById('btn-track-toggle');
  if (!trackActive && !gpsActive) { toastMsg('Attiva prima il GPS', 'error', undefined, 'sidebar'); return; }
  trackActive = !trackActive;
  if (trackActive) {
    btn.innerHTML = '<span class="track-rec-dot"></span>Ferma traccia';
    btn.style.background = 'var(--danger)';
    document.getElementById('track-stats').style.display = 'block';
    document.getElementById('btn-track-export').style.display     = 'none';
    document.getElementById('btn-track-export-kml').style.display  = 'none';
    document.getElementById('btn-track-clear').style.display       = 'none';
    toastMsg('Registrazione della traccia avviata', 'success', undefined, 'sidebar');
  } else {
    btn.innerHTML = '\u25B6 Avvia traccia'; btn.style.background = '';
    // Hide bearing statusbar item — it stays frozen on last value otherwise
    const _brgItem = document.getElementById('sb-brg-item');
    if (_brgItem) _brgItem.style.display = 'none';
    if (trackPoints.length) {
      document.getElementById('btn-track-export').style.display     = 'block';
      document.getElementById('btn-track-export-kml').style.display  = 'block';
      document.getElementById('btn-track-clear').style.display       = 'block';
      const hasAlt = trackPoints.length >= 2 && trackPoints.some(p => p.alt != null);
      document.getElementById('btn-track-profile').style.display = hasAlt ? 'block' : 'none';
    }
    toastMsg('Traccia interrotta \u2014 ' + trackPoints.length + ' points', 'success', undefined, 'sidebar');
    // Offer to save the recorded polyline as an editable shape (cancel = keep existing track preview)
    if (trackPoints.length >= 2) {
      // Snapshot points now — if the user re-starts recording while the prompt
      // is open, we save the just-stopped session, not a moving target.
      const _snap = trackPoints.slice();
      showPromptModal('Salvare la traccia come disegno? Scrivi un nome (annulla per saltare):', '', name => {
        const nm = (name || '').trim();
        if (!nm) return;
        const lls = _snap.map(p => [p.lat, p.lng]);
        const color = '#e05252';
        const layer = L.polyline(lls, { color, weight: 3, opacity: 0.85 });
        layer._geoName    = nm;
        layer._geoDesc    = '';
        layer._geoIcon    = 'pos';
        layer._geoColor   = color;
        layer._geoOpacity = 0.85;
        layer._geoType    = 'polyline';
        layer.on('click', () => _openDrawPopup(layer, layer._geoType));
        _assignDrawPane(layer);
        drawnItems.addLayer(layer);
        _saveDraws();
        updateDrawStats(layer);
        // Only clear the live recording buffer if the user has NOT restarted
        // recording while the prompt was open — otherwise we would wipe
        // points belonging to a new session.
        if (!trackActive) {
          if (trackPolyline) { try { map.removeLayer(trackPolyline); } catch(_) {} trackPolyline = null; }
          trackPoints = []; trackDistance = 0;
          document.getElementById('track-pts').textContent  = '0';
          document.getElementById('track-dist').textContent = '0 m';
          document.getElementById('track-stats').style.display       = 'none';
          document.getElementById('btn-track-export').style.display     = 'none';
          document.getElementById('btn-track-export-kml').style.display  = 'none';
          document.getElementById('btn-track-profile').style.display    = 'none';
          document.getElementById('btn-track-clear').style.display      = 'none';
        }
        toastMsg('Traccia salvata come forma: ' + nm, 'success', undefined, 'sidebar');
      });
    }
  }
});

function exportKML() {
  if (!trackPoints.length) { toastMsg('La traccia non ha punti', 'error', undefined, 'sidebar'); return; }
  const coords = trackPoints.map(p =>
    p.lng.toFixed(6) + ',' + p.lat.toFixed(6) + (p.alt != null ? ',' + p.alt.toFixed(1) : ',0')
  ).join(' ');
  showPromptModal('Nome del file:', 'track', fname => {
    const base = (((fname || 'track').trim() || 'track')).replace(/\.kml$/i, '');
    const nm = _xmlEsc(base);
    const kml = `<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2">\n  <Document>\n    <name>${nm}</name>\n    <Placemark>\n      <name>${nm}</name>\n      <LineString>\n        <tessellate>1</tessellate>\n        <altitudeMode>clampToGround</altitudeMode>\n        <coordinates>${coords}</coordinates>\n      </LineString>\n    </Placemark>\n  </Document>\n</kml>`;
    downloadFile(kml, base + '.kml', 'application/vnd.google-earth.kml+xml');
  }, 'The .kml file is saved to your device Downloads folder.');
}

document.getElementById('btn-track-export').addEventListener('click', exportGPX);
document.getElementById('btn-track-export-kml').addEventListener('click', exportKML);

document.getElementById('btn-track-clear').addEventListener('click', () => {
  if (!confirm('Cancellare la traccia?')) return;
  trackPoints = []; trackDistance = 0;
  if (trackPolyline) { map.removeLayer(trackPolyline); trackPolyline = null; }
  document.getElementById('track-pts').textContent  = '0';
  document.getElementById('track-dist').textContent = '0 m';
  document.getElementById('track-stats').style.display       = 'none';
  document.getElementById('btn-track-export').style.display     = 'none';
  document.getElementById('btn-track-export-kml').style.display  = 'none';
  document.getElementById('btn-track-profile').style.display    = 'none';
  document.getElementById('btn-track-clear').style.display      = 'none';
  const brgItem = document.getElementById('sb-brg-item');
  if (brgItem) brgItem.style.display = 'none';
  toastMsg('Traccia cancellata', '', undefined, 'sidebar');
});

/* ===== AUTO-SAVE / AUTO-LOAD DRAWINGS ===== */

function _serializeLayer(l, order) {
  const geojson = layerToGeoJSON(l);
  geojson.properties = geojson.properties || {};
  geojson.properties._geoName    = l._geoName    || '';
  geojson.properties._geoDesc    = l._geoDesc    || '';
  geojson.properties._geoIcon    = l._geoIcon    || 'pos';
  geojson.properties._geoColor   = l._geoColor   || '#4f8ef7';
  geojson.properties._geoType    = l._geoType    || 'polygon';
  geojson.properties._geoOpacity = l._geoOpacity !== undefined ? l._geoOpacity : 1;
  if (order !== undefined) geojson.properties._geoOrder = order;
  return geojson;
}

function _saveDraws() {
  const layers = drawnItems.getLayers();
  const fc = { type: 'FeatureCollection', features: layers.map((l, i) => _serializeLayer(l, i)) };
  try { localStorage.setItem('giscatasto_draws', JSON.stringify(fc)); }
  catch (err) {
    console.error('saveDraws failed:', err);
    toastMsg('Salvataggio dei disegni non riuscito: ' + (err.message || 'errore di archiviazione'), 'error', undefined, 'sidebar');
  }
}

function _loadDraws() {
  try {
    const s = localStorage.getItem('giscatasto_draws');
    if (!s) return;
    const fc = JSON.parse(s);
    if (!fc || !fc.features) return;
    // Sort by saved order if present
    const sorted = fc.features.slice().sort((a, b) => {
      const oa = (a.properties && a.properties._geoOrder !== undefined) ? a.properties._geoOrder : 0;
      const ob = (b.properties && b.properties._geoOrder !== undefined) ? b.properties._geoOrder : 0;
      return oa - ob;
    });
    sorted.forEach(f => {
      if (!f.geometry) return;
      const p = f.properties || {};
      const color   = p._geoColor   || '#4f8ef7';
      const opacity = p._geoOpacity !== undefined ? p._geoOpacity : 1;
      let layer;
      if (f.geometry.type === 'Point') {
        const [lng, lat] = f.geometry.coordinates;
        layer = L.marker([lat, lng]);
        layer.setIcon(makeEmojiIcon(p._geoIcon || 'pos'));
        layer._geoType = 'marker';
      } else if (f.geometry.type === 'LineString') {
        const lls = f.geometry.coordinates.map(c => [c[1], c[0]]);
        layer = L.polyline(lls, { color, opacity });
        layer._geoType = 'polyline';
      } else if (f.geometry.type === 'Polygon') {
        const rings = f.geometry.coordinates.map(ring => ring.map(c => [c[1], c[0]]));
        layer = L.polygon(rings, { color, fillColor: color, opacity, fillOpacity: opacity * 0.3 });
        layer._geoType = 'polygon';
      } else {
        return;
      }
      layer._geoName    = p._geoName    || '';
      layer._geoDesc    = p._geoDesc    || '';
      layer._geoIcon    = p._geoIcon    || 'pos';
      layer._geoColor   = color;
      layer._geoOpacity = opacity;
      layer.on('click', () => _openDrawPopup(layer, layer._geoType));
      _assignDrawPane(layer);
      drawnItems.addLayer(layer);
    });
    updateDrawStats();
    if (fc.features.length) toastMsg('Disegni ripristinati (' + fc.features.length + ')', 'success', undefined, 'sidebar');
  } catch (err) {
    console.error('loadDraws failed:', err);
    toastMsg('Ripristino dei disegni non riuscito: ' + (err.message || 'dati corrotti'), 'error', undefined, 'sidebar');
  }
}

/* ===== ELEVATION PROFILE ===== */
function _showElevProfile() {
  const pts = trackPoints.filter(p => p.alt != null);
  if (pts.length < 2) { toastMsg('La traccia non contiene quote', 'error', undefined, 'sidebar'); return; }

  // Cumulative distance for each point
  let dist = 0;
  const data = pts.map((p, i) => {
    if (i > 0) {
      const prev = pts[i - 1];
      dist += map.distance([prev.lat, prev.lng], [p.lat, p.lng]);
    }
    return { d: dist, alt: p.alt };
  });

  const minAlt  = Math.min(...data.map(p => p.alt));
  const maxAlt  = Math.max(...data.map(p => p.alt));
  const maxDist = data[data.length - 1].d;
  const altRange = maxAlt - minAlt || 1;

  const W = 440, H = 180;
  const PAD = { top: 14, right: 12, bottom: 30, left: 46 };
  const cW = W - PAD.left - PAD.right;
  const cH = H - PAD.top - PAD.bottom;

  const xS = d => PAD.left + (d / maxDist) * cW;
  const yS = a => PAD.top + cH - ((a - minAlt) / altRange) * cH;

  const polyPts  = data.map(p => xS(p.d).toFixed(1) + ',' + yS(p.alt).toFixed(1)).join(' ');
  const areaPts  = xS(0).toFixed(1) + ',' + (PAD.top + cH) + ' ' + polyPts + ' ' +
                   xS(maxDist).toFixed(1) + ',' + (PAD.top + cH);

  const yTicks = [minAlt, (minAlt + maxAlt) / 2, maxAlt];
  const yLabels = yTicks.map(a =>
    `<text x="${PAD.left - 5}" y="${yS(a).toFixed(1)}" text-anchor="end" dominant-baseline="middle">${Math.round(a)}</text>`
  ).join('');

  const distKm   = maxDist / 1000;
  const xFracs   = [0, 0.25, 0.5, 0.75, 1];
  const xLabels  = xFracs.map(f => {
    const d = f * maxDist;
    const lbl = distKm < 1 ? Math.round(d) + 'm' : (d / 1000).toFixed(1) + 'k';
    return `<text x="${xS(d).toFixed(1)}" y="${PAD.top + cH + 16}" text-anchor="middle">${lbl}</text>`;
  }).join('');

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" style="max-width:100%;display:block;overflow:visible">` +
    `<style>text{font-size:9px;fill:var(--text-muted,#8892a4);font-family:monospace}</style>` +
    `<polygon points="${areaPts}" fill="rgba(79,142,247,0.15)" stroke="none"/>` +
    `<polyline points="${polyPts}" fill="none" stroke="#4f8ef7" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<line x1="${PAD.left}" y1="${PAD.top}" x2="${PAD.left}" y2="${PAD.top + cH}" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` +
    `<line x1="${PAD.left}" y1="${PAD.top + cH}" x2="${PAD.left + cW}" y2="${PAD.top + cH}" stroke="rgba(255,255,255,.12)" stroke-width="1"/>` +
    yLabels + xLabels +
    `</svg>`;

  const wrap = document.getElementById('elev-chart-wrap');
  if (!wrap) return;
  wrap.innerHTML = svg;
  const info = document.createElement('p');
  info.style.cssText = 'font-size:11px;color:var(--text-muted);margin:4px 0 0;text-align:center';
  const dStr = distKm < 1 ? Math.round(maxDist) + ' m' : distKm.toFixed(2) + ' km';
  info.textContent = `Min: ${Math.round(minAlt)} m  ·  Max: ${Math.round(maxAlt)} m  ·  Δ ${Math.round(maxAlt - minAlt)} m  ·  ${dStr}`;
  wrap.appendChild(info);

  document.getElementById('modal-elev').style.display = 'flex';
}

document.getElementById('btn-track-profile').addEventListener('click', _showElevProfile);
document.getElementById('elev-close').addEventListener('click', () => {
  document.getElementById('modal-elev').style.display = 'none';
});

/* Hook into Cordova pause and browser unload */
document.addEventListener('pause',      _saveDraws, false);
window.addEventListener('beforeunload', _saveDraws);

/* Load at startup — guard against double-call */
let _drawsLoaded = false;
function _initLoadDraws() {
  if (_drawsLoaded) return;
  _drawsLoaded = true;
  _loadDraws();
}
document.addEventListener('deviceready', _initLoadDraws, { once: true });
setTimeout(_initLoadDraws, 300); // fallback: browser or deviceready already fired
