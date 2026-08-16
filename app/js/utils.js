/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
/* =====================================================
   UTILS — coordinate math, toast, file I/O
===================================================== */

/* ===== UTM =====
   Replaces the vendored utm.js + utmref.js (Johannes Rudolph), dropped because they
   carried no explicit licence — not something an app that ships an attributions screen
   can state precisely — and because their fromLatLng applied the Norway/Svalbard zone
   exceptions to the zone *label* while still projecting on the unadjusted central
   meridian, so those coordinates came out on the wrong meridian. This rides on proj4
   (MIT), already loaded for the WFS reader. The shape of the values is unchanged
   ({zone:'32T', x, y} as zero-padded strings), so no call site needed touching. */
const _UTM_BANDS = 'CDEFGHJKLMNPQRSTUVWXX';   // 8° bands from 80°S; I and O are skipped

function _utmBand(lat) {
  return (lat < -80 || lat > 84) ? '' : _UTM_BANDS.charAt(Math.floor((lat + 80) / 8));
}

/* Zone number including the two historical exceptions. Unlike the old library these also
   drive the projection below, which is the whole point of an exception. */
function _utmZone(lat, lon) {
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) return 32;          // southwest Norway
  if (lat >= 72 && lat < 84) {                                           // Svalbard
    if (lon >= 0  && lon < 9)  return 31;
    if (lon >= 9  && lon < 21) return 33;
    if (lon >= 21 && lon < 33) return 35;
    if (lon >= 33 && lon < 42) return 37;
  }
  return Math.floor((lon + 180) / 6) + 1;
}

const _utmDef = (zone, south) =>
  '+proj=utm +zone=' + zone + (south ? ' +south' : '') + ' +datum=WGS84 +units=m +no_defs';

const UTM = {
  /* {lat,lng} -> {zone:'32T', x:'0390000', y:'4990000'} (undefined outside the UTM band,
     as before: the readouts already treat a missing value as '--'). */
  fromLatLng(latlng) {
    const lat = parseFloat(latlng.lat), lon = parseFloat(latlng.lng);
    if (!isFinite(lat) || !isFinite(lon) || lat <= -80 || lat >= 84) return;
    const zone = _utmZone(lat, lon);
    const p = proj4('EPSG:4326', _utmDef(zone, lat < 0), [lon, lat]);
    return {
      zone: String(zone).padStart(2, '0') + _utmBand(lat),
      x: '0' + Math.round(p[0]),
      y: String(Math.round(p[1])).padStart(7, '0')
    };
  },

  /* {zone:'32T'|'32'|'5Q', x, y} -> {lat, lng}. A missing band is read as northern
     hemisphere, which is what the old implementation did with typed-in coordinates. */
  toLatLng(utm) {
    if (!utm || utm.zone === '' || utm.x === '' || utm.y === '') return;
    const m = String(utm.zone).trim().match(/^(\d{1,2})\s*([A-Za-z]?)$/);
    if (!m) return;
    const zone = parseInt(m[1], 10);
    const band = m[2].toUpperCase();
    const x = parseFloat(utm.x), y = parseFloat(utm.y);
    if (!zone || zone > 60 || !isFinite(x) || !isFinite(y)) return;
    const p = proj4(_utmDef(zone, !!band && band < 'N'), 'EPSG:4326', [x, y]);
    return { lat: p[1], lng: p[0] };
  }
};

function dd2dms(dd) {
  const d = Math.floor(Math.abs(dd));
  const m = Math.floor((Math.abs(dd) - d) * 60);
  const s = ((Math.abs(dd) - d) * 60 - m) * 60;
  return `${d}\u00b0${String(m).padStart(2,'0')}'${s.toFixed(2).padStart(5,'0')}"`;
}
function latToDMS(lat) { return dd2dms(lat) + (lat >= 0 ? 'N' : 'S'); }
function lonToDMS(lon) { return dd2dms(lon) + (lon >= 0 ? 'E' : 'W'); }

function coordToDM(lat, lon) {
  function fmt(deg, isLat) {
    const abs = Math.abs(deg);
    const d = Math.floor(abs);
    const m = (abs - d) * 60;
    const hem = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
    return `${d}\u00b0${m.toFixed(3)}'${hem}`;
  }
  return `${fmt(lat, true)} ${fmt(lon, false)}`;
}

function dms2dd(dmsStr) {
  const neg = /[SWsw]/.test(dmsStr);
  const parts = dmsStr.replace(/[\u00b0'"NnSsEeWw\s]+/g,' ').trim().split(/\s+/).map(Number);
  const d = parts[0] || 0, m = parts[1] || 0, s = parts[2] || 0;
  return (neg ? -1 : 1) * (d + m/60 + s/3600);
}

function parseMGRS(raw) {
  const s = raw.replace(/\s/g, '').toUpperCase();
  try {
    const pt = window.mgrs.toPoint(s);
    if (pt && !isNaN(pt[0]) && !isNaN(pt[1])) return { lat: pt[1], lon: pt[0] };
  } catch(e) {}
  /* mgrs.js (MIT) is the only reader now. The hand-rolled fallback that used to sit here
     decoded the 100 km square through utmref.js, the library with the unclear licence:
     it could only ever fire on a string mgrs.js had already rejected as invalid, so it
     bought nothing but the dependency. */
  return null;
}

function mgrsForward(lon, lat) {
  try {
    const s = window.mgrs.forward([lon, lat], 5);
    if (s && s.length > 5) return s;
  } catch(e) {}
  return '--';   // see parseMGRS: the utmref.js fallback bought nothing and is gone
}

function calcBearing(lat1, lon1, lat2, lon2) {
  const toRad = d => d * Math.PI / 180;
  const dLon = toRad(lon2 - lon1);
  const y = Math.sin(dLon) * Math.cos(toRad(lat2));
  const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
             Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

// Cooldown per (target, type, msg-prefix): a burst of similar toasts (multiple WFS layers
// updating on the same pan) collapses to one visible. Errors get the longest window.
const _TOAST_COOLDOWN_MS = { error: 12000, warn: 8000, success: 4000, '': 4000, info: 4000 };
const _TOAST_LAST = new Map();
// Cap on concurrent toasts per non-sidebar host: keeps the map viewport uncluttered when
// several layers speak at once. Errors are exempt (never dropped by cap).
const _TOAST_MAP_CAP = 2;

function toastMsg(msg, type='', dur, target='map') {
  if (dur === undefined) dur = type === 'error' ? 4000 : type === 'warn' ? 3500 : 2500;
  // 'sidebar' target: only show when the sidebar is open. Closed → drop silently (user isn't
  // looking at the sidebar, the toast is reactive to a sidebar interaction that didn't happen).
  let host;
  if (target === 'sidebar') {
    const sb = document.getElementById('sidebar');
    if (sb && sb.classList.contains('collapsed')) return;
    host = document.getElementById('toast-sidebar') || document.getElementById('toast');
  } else if (target === 'map-quiet') {
    // Inverse of 'sidebar': drop when sidebar is open. For layer-driven noise (pan/zoom
    // WFS status) that would overlap the map while the user is working in the sidebar.
    const sb = document.getElementById('sidebar');
    if (sb && !sb.classList.contains('collapsed')) return;
    host = document.getElementById('toast');
  } else {
    host = document.getElementById('toast');
  }
  if (!host) return;
  const _icons = { error: '✖ ', warn: '⚠ ', success: '✔ ', info: 'ℹ ' };
  const fullText = (_icons[type] || '') + msg;
  const _schedule = (el) => {
    if (el._dismissTid) clearTimeout(el._dismissTid);
    if (el._removeTid) clearTimeout(el._removeTid);
    el._dismissTid = setTimeout(() => {
      el.classList.remove('show');
      el._removeTid = setTimeout(() => { if (el.parentNode === host) host.removeChild(el); }, 320);
    }, dur);
  };
  // Dedup: identical visible toast → reset its timer, no stacking.
  const existing = Array.from(host.children).find(c => c.textContent === fullText);
  if (existing) { _schedule(existing); return; }
  // Rate-limit by (target, type, msg-prefix): similar-but-not-identical toasts (different
  // layer names, different counts) within cooldown are dropped silently. Errors bypass.
  if (type !== 'error') {
    const cdKey = target + '\u0000' + type + '\u0000' + fullText.slice(0, 40);
    const now = Date.now();
    const last = _TOAST_LAST.get(cdKey) || 0;
    const cd = _TOAST_COOLDOWN_MS[type] != null ? _TOAST_COOLDOWN_MS[type] : 4000;
    if (now - last < cd) return;
    _TOAST_LAST.set(cdKey, now);
    // Opportunistic purge: entries older than 4× the largest cooldown are unreachable and
    // safe to drop. Runs only when the map grows past a small threshold, so hot path stays O(1).
    if (_TOAST_LAST.size > 32) {
      const purgeBefore = now - 48000;
      _TOAST_LAST.forEach((t, k) => { if (t < purgeBefore) _TOAST_LAST.delete(k); });
    }
  }
  // FIFO cap on the map container: drop the oldest non-error toast when at capacity.
  if (target !== 'sidebar') {
    const nonError = Array.from(host.children).filter(c => !c.classList.contains('error'));
    while (nonError.length >= _TOAST_MAP_CAP) {
      const victim = nonError.shift();
      if (victim._dismissTid) clearTimeout(victim._dismissTid);
      if (victim._removeTid) clearTimeout(victim._removeTid);
      if (victim.parentNode === host) host.removeChild(victim);
    }
  }
  const item = document.createElement('div');
  item.className = 'toast-item ' + (type || '');
  item.textContent = fullText;
  host.appendChild(item);
  requestAnimationFrame(() => item.classList.add('show'));
  _schedule(item);
}

function _xmlEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function showPromptModal(message, defaultValue, onConfirm, hint) {
  let modal = document.getElementById('prompt-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'prompt-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML =
      '<div class="modal-box">' +
        '<p id="prompt-modal-msg" style="margin-bottom:12px;font-size:13px;line-height:1.5"></p>' +
        '<div class="field"><input type="text" id="prompt-modal-input" autocomplete="off" autocorrect="off" spellcheck="false"></div>' +
        '<p class="hint" id="prompt-modal-hint" style="margin:2px 0 10px;display:none"></p>' +
        '<div class="modal-btns">' +
          '<button class="btn btn-secondary" id="prompt-modal-cancel">Annulla</button>' +
          '<button class="btn btn-primary" id="prompt-modal-ok">OK</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    document.getElementById('prompt-modal-cancel').addEventListener('click', () => { modal.style.display = 'none'; });
    document.getElementById('prompt-modal-ok').addEventListener('click', () => {
      modal.style.display = 'none';
      if (modal._cb) modal._cb(document.getElementById('prompt-modal-input').value);
    });
    document.getElementById('prompt-modal-input').addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('prompt-modal-ok').click();
      if (e.key === 'Escape') { modal.style.display = 'none'; }
    });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
  }
  document.getElementById('prompt-modal-msg').textContent = message;
  const hintEl = document.getElementById('prompt-modal-hint');
  if (hintEl) {
    if (hint) { hintEl.textContent = hint; hintEl.style.display = 'block'; }
    else { hintEl.textContent = ''; hintEl.style.display = 'none'; }
  }
  const inp = document.getElementById('prompt-modal-input');
  inp.value = defaultValue || '';
  modal._cb = onConfirm;
  modal.style.display = 'flex';
  setTimeout(() => { inp.focus(); inp.select(); }, 80);
}

/* Confirmation modal with an optional "don't show this again" tick.
   The native confirm() cannot carry that tick, and the tick is the point: this dialog
   guards a click people make deliberately, so asking forever would only train them to
   dismiss it unread. When opts.rememberKey has been set the dialog is skipped entirely
   and onConfirm runs straight away — the caller stays a single call either way.
   opts: { rememberKey, rememberLabel, okLabel, cancelLabel, danger } */
function showConfirmModal(message, onConfirm, opts) {
  opts = opts || {};
  if (opts.rememberKey) {
    let silenced = false;
    try { silenced = localStorage.getItem(opts.rememberKey) === '1'; } catch (_) {}
    if (silenced) { if (onConfirm) onConfirm(); return; }
  }
  let modal = document.getElementById('confirm-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'confirm-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML =
      '<div class="modal-box">' +
        '<p id="confirm-modal-msg" style="margin-bottom:12px;font-size:13px;line-height:1.5"></p>' +
        '<label id="confirm-modal-remember-row" style="display:none;align-items:flex-start;gap:7px;margin:0 0 12px;font-size:12px;line-height:1.4;cursor:pointer">' +
          '<input type="checkbox" id="confirm-modal-remember" style="margin-top:2px;flex:none">' +
          '<span id="confirm-modal-remember-label"></span>' +
        '</label>' +
        '<div class="modal-btns">' +
          '<button class="btn btn-secondary" id="confirm-modal-cancel"></button>' +
          '<button class="btn" id="confirm-modal-ok"></button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    const _close = () => { modal.style.display = 'none'; };
    document.getElementById('confirm-modal-cancel').addEventListener('click', _close);
    document.getElementById('confirm-modal-ok').addEventListener('click', () => {
      _close();
      const chk = document.getElementById('confirm-modal-remember');
      /* Remembered only on confirm: ticking the box and then cancelling means "not this
         time, and stop asking", which would silence a dialog never actually accepted. */
      if (chk && chk.checked && modal._key) { try { localStorage.setItem(modal._key, '1'); } catch (_) {} }
      if (modal._cb) modal._cb();
    });
    modal.addEventListener('click', e => { if (e.target === modal) _close(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.style.display === 'flex') _close();
    });
  }
  document.getElementById('confirm-modal-msg').textContent = message;
  const okBtn = document.getElementById('confirm-modal-ok');
  okBtn.textContent = opts.okLabel || 'OK';
  okBtn.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
  document.getElementById('confirm-modal-cancel').textContent = opts.cancelLabel || 'Annulla';
  const row = document.getElementById('confirm-modal-remember-row');
  const chk = document.getElementById('confirm-modal-remember');
  chk.checked = false;
  if (opts.rememberKey) {
    document.getElementById('confirm-modal-remember-label').textContent =
      opts.rememberLabel || 'Non mostrare più questo messaggio';
    row.style.display = 'flex';
  } else {
    row.style.display = 'none';
  }
  modal._cb  = onConfirm;
  modal._key = opts.rememberKey || null;
  modal.style.display = 'flex';
}

/* Two-field modal for editing a WFS layer filter (attribute + values).
   Empty both = clear filter. Only one of the two filled = invalid, blocked. */
function showFilterEditModal(currentAttr, currentVals, onConfirm) {
  let modal = document.getElementById('filter-edit-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'filter-edit-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML =
      '<div class="modal-box">' +
        '<p style="margin-bottom:12px;font-size:13px;line-height:1.5">Modifica il filtro WFS</p>' +
        '<div class="field"><label>Attributo del filtro</label>' +
          '<input type="text" id="filter-edit-attr" placeholder="es. CODICE" autocomplete="off" autocorrect="off" spellcheck="false"></div>' +
        '<div class="field"><label>Valori del filtro</label>' +
          '<input type="text" id="filter-edit-vals" placeholder="es. MIL* oppure A001,B002" autocomplete="off" autocorrect="off" spellcheck="false">' +
          '<p class="hint" style="margin:3px 0 0">Puoi usare i caratteri jolly <code>*</code> e <code>?</code> (per esempio <code>MIL*</code>) oppure valori esatti separati da virgola. Lasciando vuoti entrambi i campi, il filtro viene tolto.</p></div>' +
        '<div class="modal-btns">' +
          '<button class="btn btn-secondary" id="filter-edit-cancel">Annulla</button>' +
          '<button class="btn btn-primary" id="filter-edit-ok">Salva</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    document.getElementById('filter-edit-cancel').addEventListener('click', () => { modal.style.display = 'none'; });
    document.getElementById('filter-edit-ok').addEventListener('click', () => {
      const a = document.getElementById('filter-edit-attr').value.trim();
      const v = document.getElementById('filter-edit-vals').value.trim();
      if ((a && !v) || (!a && v)) {
        toastMsg('Compila sia l’attributo sia i valori, oppure lascia vuoti entrambi', 'warn');
        return;
      }
      modal.style.display = 'none';
      if (modal._cb) modal._cb(a, v);
    });
    ['filter-edit-attr','filter-edit-vals'].forEach(elId => {
      document.getElementById(elId).addEventListener('keydown', e => {
        if (e.key === 'Enter') document.getElementById('filter-edit-ok').click();
        if (e.key === 'Escape') modal.style.display = 'none';
      });
    });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });
  }
  document.getElementById('filter-edit-attr').value = currentAttr || '';
  document.getElementById('filter-edit-vals').value = currentVals || '';
  modal._cb = onConfirm;
  modal.style.display = 'flex';
  setTimeout(() => { const a = document.getElementById('filter-edit-attr'); a.focus(); a.select(); }, 80);
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); toastMsg('Coordinate copiate', 'success'); }
  catch(_) { toastMsg('Copia non disponibile', 'error'); }
  document.body.removeChild(ta);
}

function calcArea(layer) {
  if (typeof L.GeometryUtil === 'undefined') return null;
  const latlngs = layer.getLatLngs ? layer.getLatLngs() : null;
  if (!latlngs) return null;
  try {
    const flat = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
    const area = L.GeometryUtil.geodesicArea(flat);
    if (area < 10000) return area.toFixed(1) + ' m\u00b2';
    if (area < 1e6)   return (area/10000).toFixed(2) + ' ha';
    return (area/1e6).toFixed(3) + ' km\u00b2';
  } catch(e) { return null; }
}

function calcLength(layer) {
  const latlngs = layer.getLatLngs ? layer.getLatLngs() : null;
  if (!latlngs) return null;
  try {
    const pts = Array.isArray(latlngs[0]) ? latlngs[0] : latlngs;
    let total = 0;
    for (let i=1; i<pts.length; i++) total += pts[i-1].distanceTo(pts[i]);
    if (total < 1000) return total.toFixed(1) + ' m';
    return (total/1000).toFixed(3) + ' km';
  } catch(e) { return null; }
}

function showSavePathModal(path) {
  let modal = document.getElementById('save-path-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'save-path-modal';
    modal.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.7);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px';
    document.body.appendChild(modal);
  }
  modal.innerHTML = `
    <div style="background:var(--surface);border:1px solid var(--border);border-radius:var(--r);
                padding:20px;max-width:400px;width:100%;box-shadow:var(--shadow)">
      <div style="font-weight:700;margin-bottom:10px;color:var(--success);font-size:15px">File salvato</div>
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">Percorso:</div>
      <div style="background:var(--surface2);border:1px solid var(--border);border-radius:4px;
                  padding:10px;font-size:12px;word-break:break-all;color:var(--text);
                  font-family:monospace;margin-bottom:14px">${path}</div>
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:16px">
        Apri <b>Files</b> di Google (o un altro gestore di file)&nbsp;&rarr;<br>
        <span style="color:var(--accent)">Sfoglia &rarr; Android &rarr; data &rarr; com.geotool.giscatasto &rarr; files</span>
      </div>
      <button onclick="document.getElementById('save-path-modal').style.display='none'"
              style="background:var(--accent);color:#fff;border:none;border-radius:var(--r);
                     padding:10px 20px;width:100%;font-size:14px;cursor:pointer">OK</button>
    </div>`;
  modal.style.display = 'flex';
}

function _writeToDir(blob, filename, dir, onFail) {
  window.resolveLocalFileSystemURL(dir,
    d => d.getFile(filename, { create: true, exclusive: false },
      fe => fe.createWriter(
        w => {
          w.onwriteend = () => {
            const disp = dir.replace('file://','').replace('/storage/emulated/0/','/sdcard/') + filename;
            if (dir === (window.cordova.file.externalDataDirectory || window.cordova.file.dataDirectory))
              showSavePathModal(disp);
            else
              toastMsg('Salvato: ' + disp, '');
          };
          w.onerror = () => onFail();
          w.write(blob);
        },
        () => onFail()
      ),
      () => onFail()
    ),
    () => onFail()
  );
}

function _doSaveFile(blob, filename) {
  if (!window.cordova || !window.cordova.file) { _downloadBrowser(blob, filename); return; }
  const dlDir      = window.cordova.file.externalRootDirectory
                       ? window.cordova.file.externalRootDirectory + 'Download/'
                       : null;
  const sandboxDir = window.cordova.file.externalDataDirectory || window.cordova.file.dataDirectory;
  if (dlDir) {
    _writeToDir(blob, filename, dlDir,
      () => _writeToDir(blob, filename, sandboxDir, () => toastMsg('Errore di salvataggio', 'error'))
    );
  } else {
    _writeToDir(blob, filename, sandboxDir, () => toastMsg('Errore di salvataggio', 'error'));
  }
}

function downloadFile(content, filename, mime) {
  const blob = new Blob([content], { type: mime });
  if (window.SaveToDownloads) {
    window.SaveToDownloads.save(
      filename, content, mime,
      () => toastMsg('Salvato in Download: ' + filename, 'success'),
      err  => {
        console.warn('SaveToDownloads error:', err);
        toastMsg('Salvataggio in Download non riuscito (' + (err || 'unknown') + ') — saving locally', 'warn');
        _doSaveFile(blob, filename);
      }
    );
    return;
  }
  _doSaveFile(blob, filename);
}

function _downloadBrowser(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toastMsg('Salvato: ' + filename, 'success');
}


/* ===== DIAGNOSTIC REPORT (Help > Save diagnostic report) =====
   A plain-text snapshot meant to be read by a human, not parsed. Everything in
   it comes from sources that are already tracked or free to query: no cache
   enumeration, which on a large cache would freeze the UI for seconds —
   precisely on the device where the report is most needed. */

/* Never let one unresponsive source hang the whole report. A wedged Cache
   Storage is precisely the state the report is wanted in, so a missing section
   has to degrade to a note rather than to a button stuck on "Collecting…". */
function _withTimeout(promise, ms, onTimeout) {
  return Promise.race([
    Promise.resolve(promise).catch(() => onTimeout),
    new Promise(res => setTimeout(() => res(onTimeout), ms))
  ]);
}

function _fmtBytes(b) {
  if (b == null) return 'n/a';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return v.toFixed(v >= 10 || i === 0 ? 0 : 2) + ' ' + u[i];
}

async function buildDiagReport() {
  const L = [];
  const sec = t => { L.push('', '─── ' + t + ' ' + '─'.repeat(Math.max(0, 56 - t.length)), ''); };
  const kv  = (k, v) => L.push('  ' + String(k).padEnd(22) + (v === undefined || v === null ? 'n/a' : v));

  L.push('GISCATASTO — DIAGNOSTIC REPORT');
  L.push(new Date().toString());

  /* ---- build / environment ---- */
  sec('App');
  const verEl = document.getElementById('about-version');
  kv('Version', verEl ? verEl.textContent.trim() : 'unknown');
  kv('Cordova', window.cordova ? 'yes' : 'no (browser)');
  kv('Native HTTP plugin', (window.cordova && cordova.plugin && cordova.plugin.http) ? 'yes' : 'no');
  kv('Service worker', (navigator.serviceWorker && navigator.serviceWorker.controller) ? 'active' : 'not controlling');
  kv('Screen', window.innerWidth + ' x ' + window.innerHeight + ' @' + (window.devicePixelRatio || 1) + 'x');

  /* Display geometry. The safe-area insets decide how much vertical room the chrome takes, and
     they cannot be observed from outside the device: without them any diagnosis of "the app does
     not fill the screen" is guesswork. Measured, not assumed. */
  const _mkProbe = css => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;left:-9999px;top:0;visibility:hidden;' + css;
    document.body.appendChild(el);
    return el;
  };
  try {
    const p = _mkProbe('padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px)' +
                       ' env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)');
    const cs = getComputedStyle(p);
    kv('Safe area t/r/b/l', [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft]
        .map(v => Math.round(parseFloat(v) || 0)).join(' / ') + ' px');
    p.remove();
    const v = _mkProbe('height:100vh');
    kv('100vh vs innerHeight', Math.round(v.getBoundingClientRect().height) + ' / ' + window.innerHeight);
    v.remove();
    const h = id => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().height) : 'n/a'; };
    kv('app/topbar/status/map', [h('app'), h('topbar'), h('statusbar'), h('map')].join(' / '));
    kv('Orientation', window.innerWidth > window.innerHeight ? 'landscape' : 'portrait');
    /* Whether the insets above are being applied or zeroed (see nvEdgeToEdge in geoapp.html).
       Without this the report showed insets that the layout was deliberately ignoring. */
    kv('Edge-to-edge', document.documentElement.classList.contains('no-edge-to-edge')
        ? 'no — insets zeroed' : 'yes — insets applied');
  } catch (_) { kv('Display geometry', 'unavailable'); }
  kv('Online', navigator.onLine ? 'yes' : 'no');
  kv('User agent', navigator.userAgent);

  /* ---- storage: the numbers behind the "cache is slowing down" prompt ---- */
  sec('Storage');
  let est = null;
  try { est = await _withTimeout(navigator.storage.estimate(), 3000, null); } catch (_) {}
  if (est) {
    kv('Used', _fmtBytes(est.usage));
    kv('Quota', _fmtBytes(est.quota));
    kv('Used / quota', est.quota ? (100 * est.usage / est.quota).toFixed(1) + ' %' : 'n/a');
  } else {
    kv('Estimate', 'unavailable on this device');
  }

  // Lookup latency — the measurement the slow-cache prompt is based on. Sampled
  // a few times because a single reading is noisy; the median is what matters.
  /* Go through the app's own slow-check rather than probing independently: it
     discards the cold first sample, takes a median, and — the part that matters —
     maintains the stored baseline. A report that measured on its own left the
     baseline untouched, so it could print a stale "best ever" that no longer had
     anything to do with the current reading. */
  let probeTxt = 'unavailable';
  if (typeof window._nvCacheSlowCheck === 'function') {
    const done = await _withTimeout(window._nvCacheSlowCheck().then(() => true), 6000, 'timeout');
    if (done === 'timeout') {
      kv('Cache lookup', 'stalled — no answer within 6 s');
      L.push('  NOTE: cache storage is not responding. That is itself the finding:',
             '        tile lookups are what the map waits on.');
      probeTxt = 'reported';
    } else {
      const median = window._nvLastProbeMs;
      const base = parseFloat(localStorage.getItem(window._nvCacheProbeBaseKey || 'nv_cache_probe_base'));
      if (median != null) {
        probeTxt = median.toFixed(1) + ' ms';
        kv('Cache lookup (med3)', probeTxt);
        kv('Best ever on device', isFinite(base) ? base.toFixed(1) + ' ms' : 'not recorded yet');
        if (isFinite(base) && base > 0) kv('Slowdown vs best', (median / base).toFixed(1) + ' x');
      }
    }
  }
  if (probeTxt === 'unavailable') kv('Cache lookup', probeTxt);

  /* ---- offline basemaps: from tracked counts, never enumerated ---- */
  sec('Offline maps');
  let names = [];
  try {
    const keys = await _withTimeout(caches.keys(), 3000, null);
    if (keys) names = keys.filter(n => n.startsWith(window._nvOfflinePrefix || 'giscatasto-offline-'));
    else L.push('  NOTE: cache list did not respond within 3 s.');
  } catch (_) {}
  const cfgs = (typeof customMapConfigs !== 'undefined' ? customMapConfigs : []).filter(c => c && c.offline);
  kv('Saved maps', cfgs.length);
  kv('Dedicated caches', names.length);
  if (cfgs.length !== names.length) {
    L.push('  NOTE: counts differ — maps without their own cache are in the old',
           '        storage format and their tiles sit in the browsing cache.');
  }
  let totalTiles = 0;
  cfgs.forEach(c => {
    const hasCache = names.indexOf((window._nvOfflinePrefix || 'giscatasto-offline-') + c.id) !== -1;
    totalTiles += (c.tiles || 0);
    L.push('  · ' + (c.name || c.id) + ' — ' + (c.tiles || 0).toLocaleString() + ' tiles, ' +
           (hasCache ? 'own cache' : 'NO own cache (legacy)'));
  });
  kv('Tracked tiles total', totalTiles.toLocaleString() + '  (~' + _fmtBytes(totalTiles * 15 * 1024) + ' est.)');

  /* ---- what is actually on the map right now ---- */
  sec('Map');
  try {
    const c = map.getCenter();
    kv('Centre', c.lat.toFixed(5) + ', ' + c.lng.toFixed(5));
    kv('Zoom', map.getZoom());
    kv('Bearing', (typeof map.getBearing === 'function' ? map.getBearing() + '°' : 'n/a'));
  } catch (_) { kv('Map', 'not initialised'); }

  // Name each layer by its attribution — that is what the app already sets to the
  // layer's own name. Long ones are provider credits (basemaps): truncate rather
  // than drop them, or the basemap in use never appears in the report at all.
  const layers = [];
  try {
    map.eachLayer(l => {
      const o = l.options || {};
      if (!o.attribution || typeof o.attribution !== 'string') return;
      // Parse through the DOM so entities (&copy;, &amp;) come out as characters:
      // a regex strips the tags but would leave "&copy;" sitting in the report.
      const _tmp = document.createElement('div');
      _tmp.innerHTML = o.attribution;
      const clean = (_tmp.textContent || '').replace(/\s+/g, ' ').trim();
      if (!clean) return;
      layers.push((clean.length > 70 ? clean.slice(0, 70) + '…' : clean) +
                  (o.crsCode ? ' [' + o.crsCode + ']' : '') +
                  (o.opacity !== undefined && o.opacity !== 1 ? ' (opacity ' + o.opacity + ')' : ''));
    });
  } catch (_) {}
  kv('Active layers', layers.length);
  layers.forEach(n => L.push('  · ' + n));

  if (typeof _wfsRegistry !== 'undefined' && _wfsRegistry.length) {
    kv('WFS layers', _wfsRegistry.length);
    _wfsRegistry.forEach(e => L.push('  · ' + e.name + ' (' + e.typeName + ', min zoom ' + e.minZoom + ')'));
  }

  /* ---- the part that explains failures nobody saw happen ---- */
  sec('Recent events (newest last)');
  const lines = (typeof nvLogLines === 'function') ? nvLogLines() : [];
  if (!lines.length) {
    L.push('  Nothing recorded this session.');
  } else {
    const since = (typeof nvLogSince === 'function') ? new Date(nvLogSince()) : null;
    L.push('  Session started ' + (since ? since.toLocaleTimeString() : '?') +
           ' — times below are minutes:seconds since then.');
    L.push('');
    lines.forEach(l => L.push('  ' + l));
  }

  L.push('', '─'.repeat(62), 'End of report.');
  return L.join('\n');
}

async function saveDiagReport() {
  try {
    toastMsg('Raccolta della diagnostica…', '', 2000);
    const txt = await buildDiagReport();
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    downloadFile(txt, 'giscatasto-diagnostic-' + ts + '.txt', 'text/plain');
  } catch (e) {
    toastMsg('Impossibile creare il report: ' + (e && e.message ? e.message : e), 'error');
  }
}


/* ===== SHARED: identifying User-Agent =====
   Both the Nominatim and the OSRM usage policies require a User-Agent that identifies the
   application, and OSRM warns that borrowing another app's gets you blocked. A WebView
   fetch() can only send Chrome's — the browser forbids overriding that header — so every
   call to those two services goes through the native HTTP plugin instead.
   No contact URL yet: the repository name is still undecided, and a URL that 404s is worse
   than none. Add it here once it exists. */
function nvAppUserAgent() {
  const v = document.getElementById('about-version');
  return 'GISCatasto/' + ((v && v.textContent.trim()) || '0') + ' (Android; cadastral field GIS)';
}

/* Geocoding, one request per explicit user action. See _attachAddressSearch below. */
function nvGeocode(query, onOk, onErr) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=5&q=' +
              encodeURIComponent(query);
  if (window.cordova && cordova.plugin && cordova.plugin.http) {
    cordova.plugin.http.sendRequest(
      url,
      { method: 'get', headers: { 'User-Agent': nvAppUserAgent(), 'Accept-Language': 'it' } },
      r => { try { onOk(JSON.parse(r.data)); } catch (e) { onErr(e); } },
      e => onErr(e)
    );
  } else {
    // Desktop/browser only: the User-Agent header cannot be set here, so this path is not
    // policy-compliant and exists for testing. On the device the plugin is always present.
    fetch(url, { headers: { 'Accept-Language': 'it' } })
      .then(r => r.json()).then(onOk).catch(onErr);
  }
}

/* ===== ADDRESS SEARCH =====
   Runs on Enter, never while typing. Nominatim's usage policy rules out autocomplete
   outright, and the previous keystroke-debounced version was exactly that: one request per
   pause in typing, from every installed copy of the app. The results list is unchanged —
   what changed is that the user asks for it. */
function _attachAddressSearch(input, onPick, opts) {
  opts = opts || {};
  let _busy = false, _dropdown = null, _items = [], _activeIdx = -1;

  function _close() {
    if (_dropdown) { _dropdown.remove(); _dropdown = null; }
    _items = []; _activeIdx = -1;
  }

  function _show(results) {
    _close();
    if (!results.length) return;
    _dropdown = document.createElement('div');
    _dropdown.className = 'autocomplete-dropdown';
    _items = results;
    results.forEach((r, i) => {
      const item = document.createElement('div');
      item.className = 'autocomplete-item';
      item.textContent = r.display_name;
      item.addEventListener('mousedown', e => {
        e.preventDefault();
        input.value = r.display_name.split(',')[0];
        onPick(+r.lat, +r.lon, r.display_name.split(',')[0]);
        _close();
      });
      _dropdown.appendChild(item);
    });
    input.closest('[style*="position"]') ? input.closest('[style*="position"]').appendChild(_dropdown)
      : (input.parentElement.style.position = 'relative', input.parentElement.appendChild(_dropdown));
  }

  function _setActive(idx) {
    if (!_dropdown) return;
    const els = _dropdown.querySelectorAll('.autocomplete-item');
    els.forEach(el => el.classList.remove('ac-active'));
    _activeIdx = Math.max(-1, Math.min(idx, _items.length - 1));
    if (_activeIdx >= 0) els[_activeIdx].classList.add('ac-active');
  }

  // Typing only dismisses a stale result list; it never queries.
  input.addEventListener('input', _close);

  function _run() {
    const val = input.value.trim();
    if (val.length < 3) { _close(); return; }
    if (opts.onlyIfText && !/[a-zA-Z]/.test(val)) { _close(); return; }
    if (_busy) return;
    _busy = true;
    if (typeof toastMsg === 'function') toastMsg('Ricerca in corso…', '', 1500);
    nvGeocode(val, results => {
      _busy = false;
      if (!results || !results.length) {
        _close();
        if (typeof toastMsg === 'function') toastMsg('Nessun risultato per "' + val + '"', 'warn');
        return;
      }
      _show(results);
    }, () => {
      _busy = false; _close();
      if (typeof toastMsg === 'function') toastMsg('Ricerca non riuscita — controlla la connessione', 'error');
    });
  }
  input._nvSearch = _run;   // so a search button can trigger the same path

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      // With a list open Enter always picks the highlighted row.
      if (_dropdown && _activeIdx >= 0) {
        e.preventDefault();
        const r = _items[_activeIdx];
        input.value = r.display_name.split(',')[0];
        onPick(+r.lat, +r.lon, r.display_name.split(',')[0]);
        _close();
      } else if (opts.searchOnEnter !== false) {
        e.preventDefault();
        _run();
      }
      // searchOnEnter:false — the field's own Enter handler owns the key (goto parses
      // coordinates first and calls _nvSearch itself when the text is an address), so
      // this must not preventDefault or both would fire.
      return;
    }
    if (!_dropdown) return;
    if (e.key === 'ArrowDown')     { e.preventDefault(); _setActive(_activeIdx + 1); }
    else if (e.key === 'ArrowUp')  { e.preventDefault(); _setActive(_activeIdx - 1); }
    else if (e.key === 'Escape')   _close();
  });

  document.addEventListener('click', e => {
    if (!_dropdown) return;
    if (!input.contains(e.target) && !_dropdown.contains(e.target)) _close();
  });
}
