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
// How long a message stays "just gone", during which an identical one is not re-shown.
const _TOAST_REAPPEAR_MS = 2500;
const _TOAST_GONE = new Map();

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
      el._removeTid = setTimeout(() => {
        if (el.parentNode === host) host.removeChild(el);
        _TOAST_GONE.set(el.textContent, Date.now());   // see the re-appearance guard below
      }, 320);
    }, dur);
  };
  /* Purely about how it LOOKS: the same message coming back within a second of having faded out
     is a flicker, not information. The dedupe above only merges toasts that are on screen at the
     same moment, and the cooldown key is (target, type, first 40 chars) — so a text whose count
     changes ("2 layers" then "3 layers") mints a new key and gets straight through. This is
     narrower and blunter on purpose: EXACTLY the same text, within _TOAST_REAPPEAR_MS of its own
     disappearance, is dropped. It cannot hide anything new, because new information reads
     differently. Applies to errors too — an error blinking at the user is no more readable than
     a warning doing it. */
  const _goneAt = _TOAST_GONE.get(fullText);
  if (_goneAt && Date.now() - _goneAt < _TOAST_REAPPEAR_MS) return;
  // Dedup: identical visible toast → reset its timer, no stacking. A toast already fading out
  // is not a candidate: reviving it would make it jump back to full opacity mid-fade.
  const existing = Array.from(host.children).find(c => c.textContent === fullText && !c._leaving);
  if (existing) { existing.classList.add('show'); _schedule(existing); return; }
  // Rate-limit by (target, type, msg-prefix): similar-but-not-identical toasts (different
  // layer names, different counts) within cooldown are dropped silently. Errors bypass.
  if (type !== 'error') {
    /* On the map lane the numbers in a message are the part that CHANGES while everything else
       stays the same — "2 layers: no features…" then "3 layers: no features…" — so keying on the
       raw text mints a new key each time and every variant gets through. Reported from the field
       as duplicate toasts piling up during rotation, where the count of empty layers moves
       constantly. Collapsing digit runs makes those one key, which is what the user sees anyway.
       Only this lane: elsewhere the number IS the message ("imported 3 shapes"), and two
       different counts are two different pieces of news. */
    /* On the map lane, what VARIES between two otherwise identical notices is the layer name and
       the count — "Protected sites: no features…" then "WaterCourse: no features…" — so keying on
       the raw text lets every variant through, and does so most often under load, when replies
       arrive far enough apart to be reported one layer at a time. Both are collapsed here.
       Elsewhere the name and the number ARE the message ("imported 3 shapes") and are kept. */
    const cdText = target === 'map-quiet'
      ? fullText.replace(/"[^"]*"/g, '"#"').replace(/\d+/g, '#')
      : fullText;
    const cdKey = target + '\u0000' + type + '\u0000' + cdText.slice(0, 40);
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
      _TOAST_GONE.forEach((t, k) => { if (t < purgeBefore) _TOAST_GONE.delete(k); });
    }
  }
  /* FIFO cap on the map container. Evicting used to removeChild the victim OUTRIGHT — no
     dismissal, no fade — so a toast vanished mid-life at the instant the next one appeared in
     its place. That snap is what reads as a flash when several layers speak in a row, and it
     was measured before the collectors existed: 5 inserted, 3 torn out, 2 left standing.
     Now the victim is dismissed exactly the way it would have dismissed itself, through the
     .28s opacity/transform transition it already has, and a toast on its way out no longer
     counts against the cap so it cannot be evicted a second time.
     Errors are still preferred as survivors — they are the ones worth reading — but they are no
     longer exempt from the cap altogether: unbounded errors stacking on top of each other is
     the overlap itself, and since a burst of them now collapses to one toast upstream, the
     exemption bought clutter rather than safety. */
  if (target !== 'sidebar') {
    const live = Array.from(host.children).filter(c => !c._leaving);
    while (live.length >= _TOAST_MAP_CAP) {
      let idx = live.findIndex(c => !c.classList.contains('error'));
      if (idx === -1) idx = 0;
      const victim = live.splice(idx, 1)[0];
      if (victim._dismissTid) clearTimeout(victim._dismissTid);
      if (victim._removeTid) clearTimeout(victim._removeTid);
      victim._leaving = true;
      victim.classList.remove('show');
      victim._removeTid = setTimeout(() => {
        if (victim.parentNode === host) host.removeChild(victim);
        /* Record it here too, not only on natural expiry: the re-appearance guard reads this map,
           and a toast pushed out by the cap used to leave NO trace — so an identical message could
           come straight back. That is exactly the rotation case, where the cap is the busy path,
           which is why the guard looked like it "did not always work". */
        _TOAST_GONE.set(victim.textContent, Date.now());
      }, 320);
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

/* A one-button notice drawn by the PAGE, not by the system. Deliberately not alert()/confirm():
   both hold the main thread for as long as they are on screen, and that costs twice over here.
   Once because replies keep arriving while the thread is held and cannot be read, so the worst
   moment is not while the dialog is up but right after it is dismissed, when the backlog lands all
   at once. And once because a held thread is counted as a long task, which corrupts the very
   section of the report used to diagnose the slowness the dialog is reporting — three field
   sessions measured 233 s, 8 s and 5.7 s of "blocked" time that was the dialog itself.
   The cache-full prompt keeps confirm() on purpose: it asks a real question, fires at most once
   every five minutes and only above 90% of quota, and the user is stopping to decide anyway.
   ⚠ No backdrop-click and no Escape: the condition is a state that keeps costing until something
   is switched off, not a preference to be waved away. One button, and it has to be pressed. */
function showNoticeModal(title, body, onDismiss) {
  let modal = document.getElementById('notice-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'notice-modal';
    modal.className = 'modal-backdrop';
    modal.innerHTML =
      '<div class="modal-box">' +
        '<h3 id="notice-modal-title"></h3>' +
        '<p class="modal-desc" id="notice-modal-body" style="white-space:pre-line"></p>' +
        '<div class="modal-btns">' +
          '<button class="btn btn-primary" id="notice-modal-ok">Ho capito</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    // Attached once, on an element that is never destroyed — so there is nothing to remove later.
    document.getElementById('notice-modal-ok').addEventListener('click', () => {
      modal.style.display = 'none';
      const cb = modal._cb; modal._cb = null;
      if (cb) { try { cb(); } catch (_) {} }
    });
  }
  document.getElementById('notice-modal-title').textContent = title;
  document.getElementById('notice-modal-body').textContent = body;
  modal._cb = onDismiss;
  modal.style.display = 'flex';
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

/* ===== GEOMETRY INFO =====
   One source of truth for the geometric readout: the same numbers feed the in-app popups
   and the <description> + ExtendedData of every exported KML and GeoJSON, so a shape reads
   the same in the app as it does in an earth browser.
   Two outputs on purpose \u2014 the track export already worked this way: the rows are labelled
   and rounded for a human, the props are raw metres and degrees under stable English keys
   so a GIS can read them back as fields. */

/* Property keys written by geomProps(). Listed once so an export can strip them before
   recomputing \u2014 an edited shape must not inherit the numbers of the shape it used to be \u2014
   and so the attribute tables in the popups can hide them: the same values are shown,
   recomputed, in the geometry section right below. */
const GEOM_PROP_KEYS = ['geom_type', 'area_m2', 'perimeter_m', 'length_m', 'radius_m',
                        'vertices', 'parts', 'rings', 'lat', 'lon', 'mgrs', 'utm', 'crs',
                        'centroid_lat', 'centroid_lon'];

/* simplestyle-spec keys. tokml writes *every* property into ExtendedData, styling included,
   so a file that has been through an export carries these back in. Noise in a table. */
const STYLE_PROP_KEYS = ['stroke', 'stroke-opacity', 'stroke-width', 'fill', 'fill-opacity',
                         'marker-color', 'marker-size', 'marker-symbol'];

const GEOM_LABELS = {
  /* "Area geometrica", not "Area": the number is measured off the published geometry, and a
     reader comparing it with the surface on a visura has to see that in the label itself. */
  section: 'Geometria', type: 'Tipo', area: 'Area geometrica', perimeter: 'Perimetro', length: 'Lunghezza',
  radius: 'Raggio', vertices: 'Vertici', parts: 'Parti', rings: 'Anelli', centroid: 'Centroide',
  lat: 'Latitudine', lon: 'Longitudine', dms: 'Lat/Lon', mgrs: 'MGRS', utm: 'UTM', crs: 'CRS'
};
const GEOM_TYPE_LABELS = {
  Point: 'Punto', MultiPoint: 'Multi-punto', LineString: 'Linea', MultiLineString: 'Multi-linea',
  Polygon: 'Poligono', MultiPolygon: 'Multi-poligono', GeometryCollection: 'Collezione'
};
/* tokml fills in its defaults only when `options` is falsy, so a call passing
   { simplestyle: true } and nothing else leaves options.name and options.description
   undefined and quietly emits neither tag: the placemark reaches Google Earth unnamed, with
   an empty balloon, the name surviving only as an ExtendedData row. Every call site passes
   this object instead of a bare { simplestyle: true }. */
const TOKML_OPTS = { simplestyle: true, name: 'name', description: 'description' };

/* Marks the generated block inside <description> so an export \u2192 import \u2192 export round trip
   replaces it instead of stacking a second copy under the first. */
const GEOM_DESC_MARK = '<!--geom-->';
const GEOM_CRS_LABEL = 'WGS 84 (EPSG:4326)';

function fmtArea(m2) {
  if (!(m2 > 0)) return null;
  if (m2 < 10000) return m2.toFixed(1) + ' m\u00b2';
  if (m2 < 1e6)   return (m2/10000).toFixed(2) + ' ha';
  return (m2/1e6).toFixed(3) + ' km\u00b2';
}
function fmtLength(m) {
  if (!(m > 0)) return null;
  if (m < 1000) return m.toFixed(1) + ' m';
  return (m/1000).toFixed(3) + ' km';
}

/* ===== WGS 84 =====
   Two different spheres, for two different jobs, neither of them the equatorial radius.
   The AUTHALIC radius is the sphere with the same surface area as the ellipsoid: it is the
   only radius on which a spherical area formula is not systematically wrong. Leaflet.draw's
   geodesicArea used the equatorial radius, which inflated every area the app reported by
   (6378137/6371007.181)^2 - 1 = 0.224% \u2014 4.5 m\u00b2 on a 2000 m\u00b2 parcel, and unmissable the
   moment an exported file is opened next to Google Earth's own reading. */
const WGS84_A = 6378137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_AUTHALIC_R = 6371007.181;
const SPHERE_R = 6371000.0;            // Leaflet's own radius, kept for the fallback below

/* Vincenty's inverse formula on the ellipsoid. Leaflet's distanceTo is a haversine on a
   6371 km sphere, and its error is NOT a constant that a different radius could absorb:
   measured against the ellipsoid at 45\u00b0 it runs 0.060% long north-south and 0.279% short
   east-west, a 0.34-point swing with azimuth. Only the ellipsoid agrees with what an earth
   browser reports back to the user.
   Near-antipodal pairs do not converge; there the spherical value is returned instead,
   which cannot arise from a shape someone drew and beats returning NaN. */
function geodesicDistance(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLon = (lon2 - lon1) * rad;               // not named L: that is Leaflet
  const U1 = Math.atan((1 - WGS84_F) * Math.tan(lat1 * rad));
  const U2 = Math.atan((1 - WGS84_F) * Math.tan(lat2 * rad));
  const sU1 = Math.sin(U1), cU1 = Math.cos(U1);
  const sU2 = Math.sin(U2), cU2 = Math.cos(U2);
  let lam = dLon, lamPrev, iter = 0;
  let sinSig, cosSig, sig, cos2Alpha, cos2SigM;
  do {
    const sL = Math.sin(lam), cL = Math.cos(lam);
    const t1 = cU2 * sL, t2 = cU1 * sU2 - sU1 * cU2 * cL;
    sinSig = Math.sqrt(t1*t1 + t2*t2);
    if (sinSig === 0) return 0;                   // coincident points
    cosSig = sU1 * sU2 + cU1 * cU2 * cL;
    sig = Math.atan2(sinSig, cosSig);
    const sinAlpha = cU1 * cU2 * sL / sinSig;
    cos2Alpha = 1 - sinAlpha * sinAlpha;
    cos2SigM = cos2Alpha !== 0 ? cosSig - 2 * sU1 * sU2 / cos2Alpha : 0;  // 0 on the equator
    const C = WGS84_F / 16 * cos2Alpha * (4 + WGS84_F * (4 - 3 * cos2Alpha));
    lamPrev = lam;
    lam = dLon + (1 - C) * WGS84_F * sinAlpha *
          (sig + C * sinSig * (cos2SigM + C * cosSig * (-1 + 2 * cos2SigM * cos2SigM)));
  } while (Math.abs(lam - lamPrev) > 1e-12 && ++iter < 100);
  if (iter >= 100) return _haversineDistance(lat1, lon1, lat2, lon2);
  const uSq = cos2Alpha * (WGS84_A * WGS84_A - WGS84_B * WGS84_B) / (WGS84_B * WGS84_B);
  const A = 1 + uSq/16384 * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const B = uSq/1024 * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const dSig = B * sinSig * (cos2SigM + B/4 * (cosSig * (-1 + 2 * cos2SigM * cos2SigM) -
               B/6 * cos2SigM * (-3 + 4 * sinSig * sinSig) * (-3 + 4 * cos2SigM * cos2SigM)));
  return WGS84_B * A * (sig - dSig);
}

function _haversineDistance(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const sdLat = Math.sin((lat2 - lat1) * rad / 2);
  const sdLon = Math.sin((lon2 - lon1) * rad / 2);
  const x = sdLat*sdLat + Math.cos(lat1*rad) * Math.cos(lat2*rad) * sdLon*sdLon;
  return SPHERE_R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

/* Convenience for the callers that hold Leaflet objects rather than raw coordinates. */
function geodesicDistanceLL(a, b) { return geodesicDistance(a.lat, a.lng, b.lat, b.lng); }

/* Geodesic length of a coordinate array. GeoJSON rings arrive closed (last repeats first),
   so a polygon perimeter needs no special case here \u2014 which is precisely what the old
   calcLength() got wrong: it measured Leaflet's open ring and dropped the closing leg. */
function _coordsLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++)
    total += geodesicDistance(coords[i-1][1], coords[i-1][0], coords[i][1], coords[i][0]);
  return total;
}

/* Spherical excess on the authalic radius. Same formula Leaflet.draw ships, on the radius
   that makes it an equal-area one. Takes {lat,lng} so it can stand in for the original. */
function geodesicAreaLatLngs(latlngs) {
  const n = latlngs.length;
  if (n < 3) return 0;
  const d2r = Math.PI / 180;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const p1 = latlngs[i], p2 = latlngs[(i + 1) % n];
    area += ((p2.lng - p1.lng) * d2r) * (2 + Math.sin(p1.lat * d2r) + Math.sin(p2.lat * d2r));
  }
  return Math.abs(area * WGS84_AUTHALIC_R * WGS84_AUTHALIC_R / 2);
}

/* Leaflet.draw's live "area" tooltip while a polygon is being drawn calls geodesicArea
   directly. Left alone it would quote the old, inflated figure right up to the moment the
   popup opens with the corrected one. Overridden here rather than edited in the vendored
   file so the change is visible in our own source and a library refresh cannot revert it. */
if (typeof L !== 'undefined' && L.GeometryUtil) L.GeometryUtil.geodesicArea = geodesicAreaLatLngs;

function _ringArea(ring) {
  return geodesicAreaLatLngs(ring.map(c => ({ lat: c[1], lng: c[0] })));
}

/* Raw geodesic measures for a GeoJSON geometry, in metres. Multi* parts are summed and a
   polygon's holes are subtracted from the area \u2014 a parcel with a courtyard has to report
   the area the land registry reports, not the area of its outline. */
function geomMeasure(geom) {
  const out = { type: (geom && geom.type) || '', area: 0, perimeter: 0, length: 0,
                vertices: 0, parts: 0, rings: 0 };
  const polys = [], lines = [];
  (function walk(g) {
    if (!g) return;
    const c = g.coordinates;
    switch (g.type) {
      case 'GeometryCollection': (g.geometries || []).forEach(walk); break;
      case 'MultiPolygon':    (c || []).forEach(p => polys.push(p)); break;
      case 'Polygon':         polys.push(c || []); break;
      case 'MultiLineString': (c || []).forEach(l => lines.push(l)); break;
      case 'LineString':      lines.push(c || []); break;
      case 'MultiPoint':      (c || []).forEach(() => { out.parts++; out.vertices++; }); break;
      case 'Point':           out.parts++; out.vertices++; break;
    }
  })(geom);
  polys.forEach(rings => {
    out.parts++;
    rings.forEach((ring, i) => {
      out.rings++;
      out.vertices  += Math.max(0, ring.length - 1);   // closed ring: last repeats the first
      out.perimeter += _coordsLength(ring);
      out.area      += (i === 0 ? 1 : -1) * _ringArea(ring);
    });
  });
  lines.forEach(coords => {
    out.parts++;
    out.vertices += coords.length;
    out.length   += _coordsLength(coords);
  });
  if (out.area < 0) out.area = 0;
  return out;
}

function _firstCoord(geom) {
  let c = geom && geom.coordinates;
  while (Array.isArray(c) && Array.isArray(c[0])) c = c[0];
  return (Array.isArray(c) && isFinite(c[0]) && isFinite(c[1])) ? c : null;
}

/* Area centroid, turf being loaded already for the dissolve. No fallback on purpose: the
   centre of a bounding box is not a centroid, and labelling it as one would misstate a
   number the user is going to navigate to. Without turf the row is simply dropped. */
function _centroidCoord(feature) {
  try {
    if (typeof turf === 'undefined' || !turf.centerOfMass) return null;
    return _firstCoord(turf.centerOfMass(feature).geometry);
  } catch(_) { return null; }
}

/* GeoJSON for any Leaflet layer. A circle becomes the same 64-gon the export writes, so the
   area in the popup is the area of the geometry that actually leaves the app rather than a
   pi*r^2 no consumer of the file could reproduce; radius_m carries the exact value. */
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
    return { type:'Feature', geometry:{ type:'Polygon', coordinates:[pts] },
             properties:{ radius_m: +r.toFixed(2) } };
  }
  return layer.toGeoJSON();
}

/* Labelled rows for a popup, and for the <description> of an exported file. Two readers, two
   lengths: `compact` keeps only what someone acts on — the measurements, or the coordinates and
   the CRS that gives them meaning — while the export keeps the full record, the file being the
   archive a popup on a phone is not. */
function geomInfoRows(feature, opts) {
  const geom = feature && feature.geometry;
  if (!geom || !geom.type) return [];
  const compact = !!(opts && opts.compact);
  const m = geomMeasure(geom);
  const props = feature.properties || {};
  const isPoint = /Point$/.test(m.type);
  const rows = compact ? [] : [[GEOM_LABELS.type, GEOM_TYPE_LABELS[m.type] || m.type]];
  if (isPoint) {
    const c = _firstCoord(geom);
    if (c) {
      rows.push([GEOM_LABELS.lat, c[1].toFixed(6)]);
      rows.push([GEOM_LABELS.lon, c[0].toFixed(6)]);
      if (!compact) {
        rows.push([GEOM_LABELS.dms, latToDMS(c[1]) + ' ' + lonToDMS(c[0])]);
        const mg = mgrsForward(c[0], c[1]);
        if (mg && mg !== '--') rows.push([GEOM_LABELS.mgrs, mg]);
        const u = UTM.fromLatLng({ lat: c[1], lng: c[0] });
        if (u) rows.push([GEOM_LABELS.utm, u.zone + ' ' + u.x + ' ' + u.y]);
      }
    }
  } else {
    const a = fmtArea(m.area), p = fmtLength(m.perimeter), l = fmtLength(m.length);
    if (a) rows.push([GEOM_LABELS.area, a]);
    if (p) rows.push([GEOM_LABELS.perimeter, p]);
    if (l) rows.push([GEOM_LABELS.length, l]);
    const r = parseFloat(props.radius_m);
    if (isFinite(r) && r > 0) rows.push([GEOM_LABELS.radius, fmtLength(r)]);
    if (!compact) {
      if (m.vertices) rows.push([GEOM_LABELS.vertices, String(m.vertices)]);
      const cc = _centroidCoord(feature);
      if (cc) rows.push([GEOM_LABELS.centroid, cc[1].toFixed(6) + ', ' + cc[0].toFixed(6)]);
    }
  }
  if (!compact) {
    if (m.parts > 1)        rows.push([GEOM_LABELS.parts, String(m.parts)]);
    if (m.rings > m.parts)  rows.push([GEOM_LABELS.rings, String(m.rings)]);
  }
  /* A coordinate without its CRS is just a pair of numbers, so the compact popup keeps that row
     on points; next to a length in metres it read as boilerplate, and it goes. */
  if (!compact || (isPoint && rows.length)) rows.push([GEOM_LABELS.crs, GEOM_CRS_LABEL]);
  return rows;
}

/* The machine-readable half: raw metres and degrees, English keys, so the values survive as
   fields in a GIS instead of only as balloon text. */
function geomProps(feature) {
  const geom = feature && feature.geometry;
  if (!geom || !geom.type) return {};
  const m = geomMeasure(geom);
  const props = feature.properties || {};
  const out = { geom_type: m.type, crs: 'EPSG:4326' };
  if (/Point$/.test(m.type)) {
    const c = _firstCoord(geom);
    if (c) {
      out.lon = +c[0].toFixed(8);
      out.lat = +c[1].toFixed(8);
      const mg = mgrsForward(c[0], c[1]);
      if (mg && mg !== '--') out.mgrs = mg;
      const u = UTM.fromLatLng({ lat: c[1], lng: c[0] });
      if (u) out.utm = u.zone + ' ' + u.x + ' ' + u.y;
    }
  } else {
    if (m.area > 0)      out.area_m2     = +m.area.toFixed(2);
    if (m.perimeter > 0) out.perimeter_m = +m.perimeter.toFixed(2);
    if (m.length > 0)    out.length_m    = +m.length.toFixed(2);
    const r = parseFloat(props.radius_m);
    if (isFinite(r) && r > 0) out.radius_m = +r.toFixed(2);
    if (m.vertices) out.vertices = m.vertices;
    const cc = _centroidCoord(feature);
    if (cc) { out.centroid_lon = +cc[0].toFixed(8); out.centroid_lat = +cc[1].toFixed(8); }
  }
  if (m.parts > 1)       out.parts = m.parts;
  if (m.rings > m.parts) out.rings = m.rings;
  return out;
}

/* The readable block for <description>. tokml entity-escapes what it is given, and both the
   KML spec and Google Earth treat an escaped description as HTML, so these <br/> come out
   as line breaks in the balloon instead of as visible tags. */
function geomDescriptionHtml(feature) {
  const rows = geomInfoRows(feature);
  if (!rows.length) return '';
  /* One <p> per field, not <br/>. Google Earth on Android does not render the description in
     a web view: it converts the HTML it recognises into native elements and discards the
     rest. Verified on a six-variant probe — escaped <br/>, CDATA <br/> and plain newlines all
     arrive as one run-on line, a <table> becomes a collapsed "TABLE SECTION", and only
     block-level <p> comes out as separate lines. Escaping is irrelevant to that choice, so
     tokml's default encoding is left alone. */
  return GEOM_DESC_MARK + rows.map(([k,v]) => '<p>' + k + ': ' + v + '</p>').join('');
}

/* Drop a previously generated block, leaving only what the user typed. */
function stripGeomDescription(desc) {
  const s = String(desc == null ? '' : desc);
  const i = s.indexOf(GEOM_DESC_MARK);
  const own = (i < 0 ? s : s.slice(0, i)).replace(/(?:\s|<br\s*\/?>)+$/i, '');
  // Undo the <p> wrapper stampGeomInfo adds, or a re-export would nest one inside the other.
  const m = own.match(/^<p>([\s\S]*)<\/p>$/i);
  return m ? m[1] : own;
}

/* Stamp the readout onto a feature on its way out: raw values as properties (ExtendedData
   in KML, plain fields in GeoJSON) and the readable block appended to the description.
   Everything is recomputed here, never inherited from a previous pass. */
function stampGeomInfo(feature, opts) {
  if (!feature || !feature.geometry) return feature;
  opts = opts || {};
  const props = feature.properties = feature.properties || {};
  const radius = props.radius_m;                       // survives the strip below
  GEOM_PROP_KEYS.forEach(k => { delete props[k]; });
  if (radius !== undefined) props.radius_m = radius;
  Object.assign(props, geomProps(feature));
  if (opts.description !== false) {
    const own   = stripGeomDescription(props.description);
    const block = geomDescriptionHtml(feature);
    if (block)    props.description = own ? '<p>' + own + '</p>' + block : block;
    else if (own) props.description = own;
  }
  return feature;
}

/* The same geometry section in every popup \u2014 drawn shape, imported KML/GeoJSON/GPX, WFS
   feature \u2014 so a measurement is presented one way across the whole app. Every value here is
   generated from numbers we computed, so the innerHTML carries nothing from the file. */
function geomInfoSection(feature) {
  /* Compact by default. A geometry degenerate enough to leave the compact set empty — a
     collection holding only points, a one-vertex line, coordinates that are not numbers —
     falls back to the full rows: _bindFeaturePopup drops a popup with no children, so an
     empty section here would mean tapping the feature does nothing at all. */
  let rows = geomInfoRows(feature, { compact: true });
  if (!rows.length) rows = geomInfoRows(feature);
  if (!rows.length) return null;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'margin:6px 0;padding-top:6px;border-top:1px solid var(--border)';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px';
  hdr.textContent = GEOM_LABELS.section;
  wrap.appendChild(hdr);
  const tbl = document.createElement('table');
  tbl.style.cssText = 'width:100%;font-size:11px;font-family:monospace';
  tbl.innerHTML = rows.map(([k,v]) =>
    `<tr><td style="opacity:.65;padding-right:8px;white-space:nowrap">${k}</td><td>${v}</td></tr>`).join('');
  wrap.appendChild(tbl);
  return wrap;
}

/* Convenience for a Leaflet layer, used by the popups that have no GeoJSON at hand. */
function geomInfoSectionForLayer(layer) {
  try { return geomInfoSection(layerToGeoJSON(layer)); } catch(_) { return null; }
}

function calcArea(layer) {
  try { return fmtArea(geomMeasure(layerToGeoJSON(layer).geometry).area); }
  catch(e) { return null; }
}

function calcLength(layer) {
  try {
    const m = geomMeasure(layerToGeoJSON(layer).geometry);
    return fmtLength(m.length || m.perimeter);
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

  /* ---- responsiveness: the numbers a future "the app is slowing down" notice would use ---- */
  /* Two independent instruments on purpose. The frame probe times what the user feels while the
     map renders; the long-task observer sees blocks nobody gestured for. If they ever disagree,
     that disagreement is itself the finding — which is why neither is dropped for being
     redundant. Both are reported next to WHAT caused them, so "rotation is to blame" stays a
     claim this file can contradict.
     ⚠ This replaced a rotation-only probe. That one could only ever accuse rotation, because it
     was the only thing it sampled — and the field data went on to show a pure pan costs MORE than
     a pure turn. An instrument that can only implicate one suspect is not evidence.
     In its own try: a failure here must not make the Map section above print "not initialised"
     about a map that is running perfectly well. */
  sec('Performance');
  try {
    const f = window._nvLastFrame;
    if (f) {
      const fBase = parseFloat(localStorage.getItem(window._nvFrameProbeBaseKey || 'nv_frame_base'));
      kv('Frame time (med)', f.ms.toFixed(1) + ' ms  (' + f.cause + ', ' + f.frames + ' frames)');
      kv('Best ever on device', isFinite(fBase) ? fBase.toFixed(1) + ' ms' : 'not recorded yet');
      kv('Slowdown vs best', f.ratio.toFixed(1) + ' x');
      kv('Vector paths', f.paths >= 0 ? f.paths : 'not counted');
      /* Markers sit next to paths because the bearing freeze does not reach them: leaflet-rotate
         subscribes every Marker to the rotate event, so they update on every degree while the
         paths stay frozen. If a turn costs more than a pan over the same view, this is the first
         number to look at. */
      kv('Markers', f.markers >= 0 ? f.markers : 'not counted');
      /* The report is saved minutes after the trouble, by which time the last window is usually
         the menu opening. The worst one is the reason the user is sending the file at all. */
      const w = window._nvWorstFrame;
      if (w && w !== f) {
        kv('Worst this session', w.ms.toFixed(1) + ' ms  (' + w.cause + ', ' +
                                 w.ratio.toFixed(1) + ' x, ' + w.paths + ' paths)');
      }
    } else {
      kv('Frame time', 'no map interaction yet this session');
    }
  } catch (_) { kv('Frame time', 'unavailable'); }
  /* The WFS refresh cycle — the wait between a gesture and a complete map, and the number the
     "too many layers" notice is thresholded on. Reported next to the frame times because the two
     answer different questions: the frame probe says whether drawing is smooth, this says how long
     the map stays incomplete, and a session can be bad at one and fine at the other. */
  try {
    const c = window._nvLastWfsCycle, cw = window._nvWorstWfsCycle;
    const openSince = window._nvWfsCycleOpen;
    /* A cycle still running when the report is taken gets its own line. Without it the report read
       "no WFS refresh yet this session" on a map that had been fetching for three and a half
       minutes — true to the letter and the opposite of useful, because a cycle that never closes
       is never measured. An open cycle is the single most telling line on a jammed session. */
    if (openSince) {
      kv('WFS cycle in progress', ((Date.now() - openSince) / 1000).toFixed(1) + ' s and still open');
    }
    /* ⚠ The reading share is the line that says WHERE the wait went, and it is here because
       reading it off the total was guesswork: a 63.7 s cycle carrying 346 features was taken for a
       slow app until the arithmetic showed the parse could only have been a few hundred
       milliseconds of it. Printed as a share because the absolute number means nothing without the
       wall time beside it — 0.3 s is fine inside 1 s and an idle app inside 45.
       ⚠ "reading", never "CPU": the span includes the yields between build chunks and the paint in
       them, so it exceeds blocked main-thread time and was seen to (40.9 s against 22.4 s of long
       tasks in one session). It measures the app working, not the thread being held. */
    /* A stalled span is named separately and never rolled into the share: it is the one part of a
       cycle whose cost has no explanation, and averaging it away is how it stayed invisible. */
    const share = x => (x && x.ms > 0 && typeof x.readMs === 'number')
      ? ', ' + (x.readMs / 1000).toFixed(1) + ' s reading = ' + Math.round(100 * x.readMs / x.ms) + '%'
        + (x.stalledMs ? ', ' + (x.stalledMs / 1000).toFixed(1) + ' s STALLED' : '')
      : '';
    if (c) {
      kv('WFS refresh cycle', (c.ms / 1000).toFixed(1) + ' s  (' + c.layers + ' layers, ' +
                              c.features.toLocaleString() + ' features' + share(c) + ')');
      if (cw && cw !== c) {
        kv('Worst cycle', (cw.ms / 1000).toFixed(1) + ' s  (' + cw.layers + ' layers, ' +
                          cw.features.toLocaleString() + ' features' + share(cw) + ')');
      }
    } else {
      kv('WFS refresh cycle', openSince ? 'none completed this session'
                                        : 'no WFS refresh yet this session');
    }
  } catch (_) { kv('WFS refresh cycle', 'unavailable'); }
  try {
    const lt = window._nvLongTasks;
    if (!lt) {
      /* Stated, not silently omitted: a missing row would be read as "no long tasks", which is
         the opposite of what an unavailable API means. */
      kv('Long tasks', 'PerformanceObserver longtask not available in this WebView');
    } else if (!lt.count) {
      kv('Long tasks', 'none over 50 ms since launch');
    } else {
      kv('Long tasks', lt.count + '  (worst ' + lt.worstMs.toFixed(0) + ' ms, ' +
                       (lt.totalMs / 1000).toFixed(1) + ' s blocked in total)');
    }
  } catch (_) { kv('Long tasks', 'unavailable'); }

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
