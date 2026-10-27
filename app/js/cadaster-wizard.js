/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* Italian Cadaster Filter wizard (panel-cadaster).
   - Cascade Region/Province/Comune from PCN minambiente WFS (UA.UNITAAMMINISTRATIVE.*).
   - Sheet (foglio) dropdown from Agenzia Entrate INSPIRE WFS (CP:CadastralZoning), bbox=comune.
   - Apply parcel filter to CP:CadastralParcel layer via _WFSLayer.setFilter.
   - All fetches are direct HTTP (not via _WFSLayer) so they bypass the layer's minZoom 14 guard.
   - ISO-8859-1 decoding for PCN responses; EPSG:6706 coords treated as lat/lon for fitBounds
     (RDN2008 vs WGS84 differs by sub-meter — irrelevant at the zoom levels involved). */
(function nvCadasterWizard() {
  'use strict';

  // HTTP (not HTTPS): the PCN endpoint 301-redirects HTTPS to HTTP, and the native HTTP plugin
  // refuses the downgrade. Mixed-content is allowed in config.xml; the native plugin bypasses
  // the WebView's blocker anyway. Agenzia Entrate (CADASTER_WFS) serves HTTPS directly.
  const ADMIN_WFS = 'http://wms.pcn.minambiente.it/ogc?map=/ms_ogc/wfs/LimitiAmministrativi_2020.map';
  const CADASTER_WFS = 'https://wfs.cartografia.agenziaentrate.gov.it/inspire/wfs/owfs01.php';
  const TIMEOUT_MS = 30000;
  const PARCEL_TYPENAME = 'CP:CadastralParcel';
  const ZONING_TYPENAME = 'CP:CadastralZoning';

  // Session-scoped caches (cleared on reload, never persisted).
  const _regionsCache = { value: null };
  const _provincesByRegion = {};
  const _comuniByProvince = {};
  const _sheetsByComune = {};

  // Generation counter — increments on every applyCadasterFilter / resetCadasterFilter so
  // stale async callbacks (polls, moveend handlers) from a previous Go can detect they were
  // superseded and abort.
  let _wizardGen = 0;
  // Keys selected by this wizard, tracked separately from the global _selKeys (which can also
  // hold user-clicked selections). Cleared on next Go / Reset, never on manual deselect.
  const _wizardSelKeys = new Set();

  const $ = id => document.getElementById(id);

  function setStatus(msg, isError) {
    const el = $('cad-status');
    if (!el) return;
    el.textContent = msg || '';
    el.classList.toggle('cad-status-err', !!isError);
    // Re-trigger the one-time attention pulse on each error, even when the
    // element was already in the error state — same emphasis language as the
    // error/warn toasts: a brief glow pulse, not a continuous blink.
    el.classList.remove('cad-status-pulse');
    if (isError) { void el.offsetWidth; el.classList.add('cad-status-pulse'); }
  }

  // On a successful locate the map has zoomed to the result. If the sidebar is
  // currently covering the whole screen (phone overlay), collapse it so the
  // parcels are actually visible and confirm on the map; otherwise keep the
  // inline status (on wider screens the map is already visible beside the panel).
  function revealResult(msg) {
    const sb = document.getElementById('sidebar');
    const coversScreen = sb && !sb.classList.contains('collapsed') &&
      sb.getBoundingClientRect().width >= window.innerWidth * 0.92;
    if (coversScreen) {
      sb.classList.add('collapsed');
      if (typeof updateMenuState === 'function') updateMenuState();
      if (typeof toastMsg === 'function') toastMsg(msg, 'success');
    } else {
      setStatus(msg, false);
    }
  }

  // Uses the same native HTTP path as _WFSLayer (cordova-plugin-advanced-http) so it bypasses
  // WebView CORS/mixed-content/redirect restrictions that plain fetch() hits on hosts like
  // wms.pcn.minambiente.it (which redirects HTTPS->HTTP). Falls back to fetch() outside Cordova.
  // Decoding goes through _decodeXmlBuffer (global from map.js) for consistent encoding handling.
  function fetchXml(url) {
    if (navigator.onLine === false) return Promise.reject(new Error('offline'));
    return new Promise((resolve, reject) => {
      const onBuf = buf => {
        try {
          const text = (typeof _decodeXmlBuffer === 'function')
            ? _decodeXmlBuffer(buf)
            : new TextDecoder().decode(buf);
          resolve(new DOMParser().parseFromString(text, 'application/xml'));
        } catch (e) { reject(e); }
      };
      if (window.cordova && cordova.plugin && cordova.plugin.http) {
        cordova.plugin.http.sendRequest(url,
          { method: 'get', responseType: 'arraybuffer', timeout: TIMEOUT_MS / 1000 },
          res => onBuf(res.data),
          err => {
            // Report the host and the native message, not just the numeric status. The plugin
            // maps SSL failures to -2 (SSL_EXCEPTION in its error-codes.js), and a bare "-2" in a
            // toast cannot distinguish an untrusted certificate chain — which fails every time —
            // from a transient handshake failure, which does not. The distinction decides whether
            // the fix is a trust anchor or a retry.
            const host = (String(url).match(/^https?:\/\/([^/]+)/) || [, url])[1];
            const code = err && err.status;
            const kind = code === -2 ? 'TLS' : code === -1 ? 'network' : 'status ' + code;
            const detail = (err && err.error) || '';
            reject(new Error('http ' + kind + ' @ ' + host + (detail ? ': ' + detail : '')));
          }
        );
      } else {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
        fetch(url, { signal: ctrl.signal })
          .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
          .then(onBuf)
          .catch(reject)
          .finally(() => clearTimeout(tid));
      }
    });
  }

  // Extract bbox [s,w,n,e] from a GML feature by scanning coordinate text nodes.
  // latFirst=true for WFS 1.1 EPSG:4326 (urn) and WFS 2.0 with geographic EPSG codes.
  function bboxFromFeature(featEl, latFirst) {
    let s = Infinity, w = Infinity, n = -Infinity, e = -Infinity;
    const push = (lat, lon) => {
      if (!isFinite(lat) || !isFinite(lon)) return;
      if (lat < s) s = lat; if (lat > n) n = lat;
      if (lon < w) w = lon; if (lon > e) e = lon;
    };
    const collect = tag => {
      let nodes = featEl.getElementsByTagNameNS('http://www.opengis.net/gml', tag);
      if (!nodes.length) nodes = featEl.getElementsByTagNameNS('http://www.opengis.net/gml/3.2', tag);
      if (!nodes.length) nodes = featEl.getElementsByTagName('gml:' + tag);
      return nodes;
    };
    const posLists = collect('posList');
    for (let i = 0; i < posLists.length; i++) {
      const nums = posLists[i].textContent.trim().split(/\s+/).map(parseFloat);
      for (let j = 0; j + 1 < nums.length; j += 2) {
        if (latFirst) push(nums[j], nums[j + 1]); else push(nums[j + 1], nums[j]);
      }
    }
    const coords = collect('coordinates');
    for (let i = 0; i < coords.length; i++) {
      const pairs = coords[i].textContent.trim().split(/\s+/);
      for (const p of pairs) {
        const xy = p.split(',').map(parseFloat);
        if (xy.length >= 2) push(xy[1], xy[0]); // GML coordinates element is always x,y (lon,lat)
      }
    }
    const poses = collect('pos');
    for (let i = 0; i < poses.length; i++) {
      const nums = poses[i].textContent.trim().split(/\s+/).map(parseFloat);
      if (nums.length >= 2) {
        if (latFirst) push(nums[0], nums[1]); else push(nums[1], nums[0]);
      }
    }
    if (s === Infinity) return null;
    return [s, w, n, e];
  }

  function textOf(parent, localName) {
    if (!parent) return '';
    const direct = parent.getElementsByTagName(localName);
    if (direct.length) return (direct[0].textContent || '').trim();
    const all = parent.getElementsByTagNameNS('*', localName);
    return all.length ? (all[0].textContent || '').trim() : '';
  }

  // "8", or "8 – sez. A" in a comune split into cadastral sections.
  function sheetText(sh) {
    if (!sh) return '';
    return (sh.label || '') + (sh.section ? ' \u2013 sez. ' + sh.section : '');
  }

  // OGC Filter Encoding 1.1 — PropertyIsEqualTo, URL-encoded. PCN MapServer supports this
  // server-side on cod_reg/cod_prov/pro_com (validated 2026-06-30). Avoids downloading the
  // full national dataset and filtering client-side.
  function filterEq(prop, val) {
    return encodeURIComponent(
      '<Filter xmlns="http://www.opengis.net/ogc"><PropertyIsEqualTo>' +
      '<PropertyName>' + prop + '</PropertyName><Literal>' + val + '</Literal>' +
      '</PropertyIsEqualTo></Filter>'
    );
  }

  /* ===== Admin WFS (PCN minambiente) ===== */

  /* Trento and Bolzano run their own provincial land registry (sistema tavolare), so the
     Agenzia delle Entrate services this wizard queries hold no data for them. They are the
     only two provinces of ISTAT region 4, so dropping the whole region drops exactly them:
     offering it would produce an empty comune list and look like a broken service.
     Filtered on the code, not the name — den_reg spelling varies between PCN datasets. */
  const _EXCLUDED_REGION_CODES = { '4': 1 };   // Trentino-Alto Adige

  async function loadRegions() {
    if (_regionsCache.value) return _regionsCache.value;
    setStatus('Caricamento regioni\u2026');
    const url = ADMIN_WFS + '&service=WFS&version=1.1.0&request=GetFeature' +
      '&typeName=UA.UNITAAMMINISTRATIVE.REGIONI&propertyName=cod_reg,den_reg';
    const doc = await fetchXml(url);
    const feats = doc.getElementsByTagNameNS('*', 'UA.UNITAAMMINISTRATIVE.REGIONI');
    const seen = {};
    const out = [];
    for (let i = 0; i < feats.length; i++) {
      const name = textOf(feats[i], 'den_reg');
      const code = textOf(feats[i], 'cod_reg');
      if (!name || !code || seen[code] || _EXCLUDED_REGION_CODES[code]) continue;
      seen[code] = 1;
      out.push({ name, code });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    _regionsCache.value = out;
    setStatus('');
    return out;
  }

  async function loadProvinces(regionCode) {
    if (_provincesByRegion[regionCode]) return _provincesByRegion[regionCode];
    setStatus('Caricamento province\u2026');
    const url = ADMIN_WFS + '&service=WFS&version=1.1.0&request=GetFeature' +
      '&typeName=UA.UNITAAMMINISTRATIVE.PROVINCE' +
      '&propertyName=cod_prov,den_prov,cod_uts,den_uts,cod_reg' +
      '&filter=' + filterEq('cod_reg', regionCode);
    const doc = await fetchXml(url);
    const feats = doc.getElementsByTagNameNS('*', 'UA.UNITAAMMINISTRATIVE.PROVINCE');
    const seen = {};
    const out = [];
    for (let i = 0; i < feats.length; i++) {
      // Città metropolitane: PCN sets den_prov='-' (literal hyphen placeholder) and the real
      // name lives in den_uts. Treat '-' as empty so we fall through to den_uts.
      const denProv = textOf(feats[i], 'den_prov');
      const denUts  = textOf(feats[i], 'den_uts');
      const name = (denProv && denProv !== '-') ? denProv : denUts;
      const code = textOf(feats[i], 'cod_prov') || textOf(feats[i], 'cod_uts');
      if (!name || !code || seen[code]) continue;
      seen[code] = 1;
      out.push({ name, code });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    _provincesByRegion[regionCode] = out;
    setStatus('');
    return out;
  }

  async function loadComuni(provinceCode) {
    if (_comuniByProvince[provinceCode]) return _comuniByProvince[provinceCode];
    setStatus('Caricamento comuni\u2026');
    // No geometry here — bbox fetched on-demand at pick via loadComuneBbox.
    const url = ADMIN_WFS + '&service=WFS&version=1.1.0&request=GetFeature' +
      '&typeName=UA.UNITAAMMINISTRATIVE.COMUNI' +
      '&propertyName=comune,pro_com,sigla,cod_prov,cod_uts,cod_reg' +
      '&filter=' + filterEq('cod_prov', provinceCode);
    const doc = await fetchXml(url);
    const feats = doc.getElementsByTagNameNS('*', 'UA.UNITAAMMINISTRATIVE.COMUNI');
    const seen = {};
    const out = [];
    for (let i = 0; i < feats.length; i++) {
      const name = textOf(feats[i], 'comune');
      const code = textOf(feats[i], 'pro_com');
      if (!name || !code || seen[code]) continue;
      seen[code] = 1;
      out.push({ name, code });
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    _comuniByProvince[provinceCode] = out;
    setStatus('');
    return out;
  }

  // Single-feature query that includes geometry, used at pick time to derive bbox for the
  // sheet query. Mutates and returns the comune.bbox so callers can chain.
  async function loadComuneBbox(comune) {
    if (comune.bbox) return comune.bbox;
    setStatus('Caricamento estensione di ' + comune.name + '\u2026');
    const url = ADMIN_WFS + '&service=WFS&version=1.1.0&request=GetFeature' +
      '&typeName=UA.UNITAAMMINISTRATIVE.COMUNI' +
      '&filter=' + filterEq('pro_com', comune.code);
    const doc = await fetchXml(url);
    const feats = doc.getElementsByTagNameNS('*', 'UA.UNITAAMMINISTRATIVE.COMUNI');
    let combined = null;
    for (let i = 0; i < feats.length; i++) {
      const bb = bboxFromFeature(feats[i], true);
      if (!bb) continue;
      if (!combined) combined = bb.slice();
      else {
        combined[0] = Math.min(combined[0], bb[0]);
        combined[1] = Math.min(combined[1], bb[1]);
        combined[2] = Math.max(combined[2], bb[2]);
        combined[3] = Math.max(combined[3], bb[3]);
      }
    }
    if (!combined) throw new Error('no geometry for comune ' + comune.code);
    comune.bbox = combined;
    setStatus('');
    return combined;
  }

  /* ===== Cadaster WFS (Agenzia Entrate) ===== */

  // AE answers some bbox requests with an OGC exception report ("InvalidFormat") and HTTP 200
  // instead of features. Read as a document it holds no features, so it used to pass for an
  // empty tile and the fogli in it vanished from the list without a word. The same area split in
  // four is answered, so a refused tile is split and asked again, up to TILE_SPLIT_DEPTH times
  // (16 pieces). Whatever is still refused after that is counted as a hole for the caller.
  const TILE_SPLIT_DEPTH = 2;

  function isRefusal(doc) {
    const root = doc && doc.documentElement;
    if (!root) return true;
    const name = root.localName;
    return name === 'ServiceExceptionReport' || name === 'ExceptionReport' ||
           doc.getElementsByTagName('parsererror').length > 0;
  }

  const REFUSAL_RETRIES = 2;

  function isInvalidFormat(doc) {
    const root = doc && doc.documentElement;
    if (!root || root.localName !== 'ServiceExceptionReport') return false;
    const exc = root.getElementsByTagName('ServiceException')[0];
    return !!exc && exc.getAttribute('code') === 'InvalidFormat';
  }

  function tileUrl(typeName, tile) {
    const [s, w, n, e] = tile;
    const bboxParam =
      s.toFixed(6) + ',' + w.toFixed(6) + ',' + n.toFixed(6) + ',' + e.toFixed(6) +
      ',urn:ogc:def:crs:EPSG::6706';
    return CADASTER_WFS +
      '?service=WFS&version=2.0.0&request=GetFeature' +
      '&typeNames=' + encodeURIComponent(typeName) +
      '&srsName=' + encodeURIComponent('urn:ogc:def:crs:EPSG::6706') +
      '&bbox=' + encodeURIComponent(bboxParam) +
      '&count=20000';
  }

  // Resolves to { feats, holes }. Transport errors reject, as before; only refusals are split.
  // The pieces are fetched one after another, so a split never raises the caller's concurrency.
  async function fetchTileFeatures(typeName, tagName, tile, depth) {
    let doc = await fetchXml(tileUrl(typeName, tile));
    // The InvalidFormat refusal follows the URL string, not the area (see _WFS_REFUSAL_RETRIES in
    // map.js), so the same tile asked with one extra parameter is normally answered. Cheaper than a
    // split, which costs four requests; the split stays as the fallback for anything else.
    for (let t = 1; t <= REFUSAL_RETRIES && isInvalidFormat(doc); t++) {
      doc = await fetchXml(tileUrl(typeName, tile) + '&_r=' + t);
    }
    if (!isRefusal(doc)) {
      return { feats: Array.from(doc.getElementsByTagNameNS('*', tagName)), holes: 0 };
    }
    if (window.console) console.warn('[cadaster] tile refused', tile.map(v => v.toFixed(4)).join(','),
                                     'depth', depth);
    if (depth >= TILE_SPLIT_DEPTH) return { feats: [], holes: 1 };
    const [s, w, n, e] = tile;
    const ms = (s + n) / 2, mw = (w + e) / 2;
    const out = { feats: [], holes: 0 };
    for (const q of [[s, w, ms, mw], [s, mw, ms, e], [ms, w, n, mw], [ms, mw, n, e]]) {
      const r = await fetchTileFeatures(typeName, tagName, q, depth + 1);
      for (const f of r.feats) out.feats.push(f);
      out.holes += r.holes;
    }
    return out;
  }

  // Agenzia Entrate INSPIRE WFS silently returns 0 features when the bbox exceeds ~50 km²
  // (the same reason the production Catasto layer uses minZoom 14: viewport tiles stay small).
  // We tile the comune bbox at ~0.063° lat / cos-adjusted lon (~7 km ⇒ ~49 km², under threshold
  // with margin) and merge per-label across tiles.
  async function loadSheets(comune) {
    if (_sheetsByComune[comune.code]) return _sheetsByComune[comune.code];
    const [cs, cw, cn, ce] = comune.bbox;
    const LAT_STEP = 0.063; // ~7 km at Italian latitudes
    const midLat = (cs + cn) / 2;
    const lonStep = LAT_STEP / Math.max(0.1, Math.cos(midLat * Math.PI / 180));
    const tiles = [];
    for (let s = cs; s < cn; s += LAT_STEP) {
      const n = Math.min(s + LAT_STEP, cn);
      for (let w = cw; w < ce; w += lonStep) {
        const e = Math.min(w + lonStep, ce);
        tiles.push([s, w, n, e]);
      }
    }
    const rawZones = [];
    const total = tiles.length;
    setStatus('Caricamento fogli di ' + comune.name + ' (0/' + total + ')\u2026');
    // Concurrent workers pull from a shared index. JS single-threaded merges into seen/dedup are
    // atomic between awaits, so no locking is needed. First tile error aborts the batch.
    const CONCURRENCY = 4;
    let nextIdx = 0;
    let done = 0;
    let firstErr = null;
    let holes = 0;
    const runWorker = async () => {
      while (true) {
        if (firstErr) return;
        const idx = nextIdx++;
        if (idx >= tiles.length) return;
        const [s, w, n, e] = tiles[idx];
        let tileCount = 0;
        try {
          const r = await fetchTileFeatures(ZONING_TYPENAME, 'CadastralZoning', tiles[idx], 0);
          holes += r.holes;
          const feats = r.feats;
          tileCount = feats.length;
          for (let i = 0; i < feats.length; i++) {
            const label = textOf(feats[i], 'label') || textOf(feats[i], 'LABEL');
            // ref = NATIONALCADASTRALZONINGREFERENCE (e.g. L229_004900). Parcels carry it as
            // the prefix of NATIONALCADASTRALREFERENCE, so we use it to build a sheet-scoped,
            // collision-free parcel filter.
            const ref = textOf(feats[i], 'NATIONALCADASTRALZONINGREFERENCE') ||
                        textOf(feats[i], 'nationalCadastralZoningReference');
            // ADMINISTRATIVEUNIT = comune Belfiore code. Used post-loop to drop neighbouring
            // comuni that bleed into this comune's rectangular bbox and reuse foglio numbers.
            const au = textOf(feats[i], 'ADMINISTRATIVEUNIT') ||
                       textOf(feats[i], 'administrativeUnit');
            const bbox = bboxFromFeature(feats[i], true);
            if (!label || !bbox) continue;
            rawZones.push({ label, ref: ref || '', au: au || '', bbox });
          }
        } catch (err) {
          if (window.console) console.warn('cadaster sheet tile fetch failed', s, w, n, e, err);
          if (!firstErr) firstErr = err;
          return;
        }
        // Diagnostic: silent zero-return would appear here as tileCount=0 with populated neighbours.
        if (window.console) console.log('[cadaster] tile', s.toFixed(4), w.toFixed(4), '\u2192', tileCount);
        done++;
        setStatus('Caricamento fogli di ' + comune.name + ' (' + done + '/' + total + ')\u2026');
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, () => runWorker())
    );
    if (firstErr) throw firstErr;

    // Scope sheets to the target comune. The comune bbox is rectangular, so tiles bleed into
    // adjacent comuni that reuse the same foglio numbers (e.g. two neighbours both have "8"),
    // and the endpoint has no server-side attribute filter (bbox-only, verified). Filter
    // client-side by ADMINISTRATIVEUNIT: the target comune fills its own bbox so it owns the
    // most distinct fogli, while neighbours appear only in edge slivers. Fall back to no
    // scoping if the attribute is absent (older server variants) to avoid an empty list.
    const byAU = {};
    for (const z of rawZones) {
      if (!z.au) continue;
      (byAU[z.au] || (byAU[z.au] = new Set())).add(z.ref || z.label);
    }
    let targetAU = null;
    const auCodes = Object.keys(byAU);
    if (auCodes.length) {
      const cLat = (cs + cn) / 2, cLon = (cw + ce) / 2;
      const coversCentroid = au => rawZones.some(z => z.au === au &&
        z.bbox[0] <= cLat && cLat <= z.bbox[2] && z.bbox[1] <= cLon && cLon <= z.bbox[3]);
      auCodes.sort((a, b) => {
        const d = byAU[b].size - byAU[a].size;            // most distinct fogli wins
        if (d) return d;
        const ca = coversCentroid(a), cb = coversCentroid(b);
        if (ca !== cb) return (cb ? 1 : 0) - (ca ? 1 : 0); // tie-break: zone over comune centre
        return a.localeCompare(b);                         // deterministic final tie-break
      });
      targetAU = auCodes[0];
    }

    // One entry per sheet REFERENCE, not per label. A comune split into cadastral sections
    // numbers its fogli once per section — Groscavallo (E199) has a foglio 8 in each of A, B
    // and C (E199A000800, E199B000800, E199C000800) — and grouping by label merged them into one
    // entry with the union bbox and the ref of whichever arrived first, so the parcel search
    // looked in one section only. The 5th character of the ref is the section, '_' for none.
    // Without a ref (older server variants) the label is the key, as before.
    const seen = {};
    const dedup = [];
    for (const z of rawZones) {
      if (targetAU && z.au !== targetAU) continue;         // drop neighbouring comuni
      const key = z.ref || z.label;
      if (seen[key]) {
        const ex = seen[key];
        ex.bbox[0] = Math.min(ex.bbox[0], z.bbox[0]);
        ex.bbox[1] = Math.min(ex.bbox[1], z.bbox[1]);
        ex.bbox[2] = Math.max(ex.bbox[2], z.bbox[2]);
        ex.bbox[3] = Math.max(ex.bbox[3], z.bbox[3]);
      } else {
        const sec = z.ref.length > 4 && z.ref[4] !== '_' ? z.ref[4] : '';
        seen[key] = { label: z.label, section: sec, ref: z.ref || '', bbox: z.bbox.slice() };
        dedup.push(seen[key]);
      }
    }
    dedup.sort((a, b) => {
      const na = parseInt(a.label, 10), nb = parseInt(b.label, 10);
      if (isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
      return a.label.localeCompare(b.label) || a.section.localeCompare(b.section);
    });
    // A list with holes is shown but not cached, so picking the comune again asks again.
    if (holes) dedup.incomplete = holes;
    else _sheetsByComune[comune.code] = dedup;
    setStatus('');
    return dedup;
  }

  // Tile-based parcel lookup. AE silent-zeros GetFeature when the bbox trips an internal
  // threshold (empirical: ~1200+ features in the response) — the sheet bbox alone can exceed
  // it, so fitBounds(sheet) + a single WFS fetch reports "no matching" even when the parcel
  // exists. Fix: tile the sheet at ~1 km² (well under the threshold), fetch parcels in
  // parallel, early-exit once every target ref is found. Returns the union bbox of matched
  // parcels or null when none of the targets exist.
  async function findParcelsBBox(sheet, targetRefs) {
    if (!sheet || !sheet.bbox || !targetRefs || !targetRefs.length) return null;
    const remaining = new Set(targetRefs);
    let unionBBox = null;
    let firstErr = null;
    let allFound = false;
    let holes = 0;
    const [ss, sw, sn, se] = sheet.bbox;
    const LAT_STEP = 0.01; // ~1.1 km — safely below AE silent-zero threshold
    const midLat = (ss + sn) / 2;
    const lonStep = LAT_STEP / Math.max(0.1, Math.cos(midLat * Math.PI / 180));
    const tiles = [];
    for (let s = ss; s < sn; s += LAT_STEP) {
      const n = Math.min(s + LAT_STEP, sn);
      for (let w = sw; w < se; w += lonStep) {
        const e = Math.min(w + lonStep, se);
        tiles.push([s, w, n, e]);
      }
    }
    const CONCURRENCY = 4;
    let nextIdx = 0;
    const merge = bb => {
      if (!unionBBox) unionBBox = bb.slice();
      else {
        unionBBox[0] = Math.min(unionBBox[0], bb[0]);
        unionBBox[1] = Math.min(unionBBox[1], bb[1]);
        unionBBox[2] = Math.max(unionBBox[2], bb[2]);
        unionBBox[3] = Math.max(unionBBox[3], bb[3]);
      }
    };
    const runWorker = async () => {
      while (true) {
        if (allFound || firstErr) return;
        const idx = nextIdx++;
        if (idx >= tiles.length) return;
        try {
          const r = await fetchTileFeatures(PARCEL_TYPENAME, 'CadastralParcel', tiles[idx], 0);
          if (allFound || firstErr) return;
          holes += r.holes;
          const feats = r.feats;
          for (let i = 0; i < feats.length; i++) {
            const ref = textOf(feats[i], 'NATIONALCADASTRALREFERENCE') ||
                        textOf(feats[i], 'nationalCadastralReference');
            if (ref && remaining.has(ref)) {
              const bb = bboxFromFeature(feats[i], true);
              if (bb) merge(bb);
              remaining.delete(ref);
              if (remaining.size === 0) { allFound = true; return; }
            }
          }
        } catch (err) {
          if (!firstErr) firstErr = err;
          return;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, tiles.length) }, () => runWorker())
    );
    if (firstErr && !unionBBox) throw firstErr;
    // Nothing found, but part of the sheet was never answered: "no matching parcel" would be a
    // claim about ground the server did not show us.
    if (!unionBBox && holes) {
      const err = new Error('Ricerca incompleta: il server del catasto non ha risposto per una ' +
                            'parte del foglio. Riprova.');
      err.incomplete = true;
      throw err;
    }
    return unionBBox;
  }

  /* ===== Layer access (typeName-based, immune to UI renames) ===== */

  function findLayerByTypeName(typeName) {
    if (typeof loadedLayers === 'undefined' || !loadedLayers) return null;
    for (const id in loadedLayers) {
      const l = loadedLayers[id];
      if (l && l.options && l.options.typeName === typeName) return l;
    }
    return null;
  }

  function checkboxForLayer(layer) {
    if (typeof loadedLayers === 'undefined' || !loadedLayers) return null;
    let id = null;
    for (const k in loadedLayers) if (loadedLayers[k] === layer) { id = k; break; }
    if (!id) return null;
    const item = document.querySelector('.layer-item[data-id="' + id + '"]');
    return item ? item.querySelector('input[type=checkbox]') : null;
  }

  function ensureLayerVisible(layer) {
    if (!layer) return;
    const cb = checkboxForLayer(layer);
    if (cb && !cb.checked) {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }

  /* ===== Selection helpers (highlight matching parcels like manual Select tool) ===== */

  // Mirror map.js _selKey so wizard-marked keys match what onEachFeature computes on re-render.
  function _featKey(f) {
    return (f && f.id) || JSON.stringify(f && f.geometry && f.geometry.coordinates);
  }
  // Mirror map.js cadastral label resolution (see _labelKeys for CadastralParcel/CadastralZoning).
  function _featLabel(f) {
    const p = (f && f.properties) || {};
    const keys = ['label','code','number','numero','NUMERO','codice','CODICE','LABEL','CODE','NUMBER'];
    for (let i = 0; i < keys.length; i++) {
      const v = p[keys[i]];
      if (v != null && v !== '') return String(v);
    }
    return null;
  }

  function clearWizardSelection() {
    if (typeof _selLayers === 'undefined' || typeof _selKeys === 'undefined') return;
    _wizardSelKeys.forEach(key => {
      const layer = _selLayers.get(key);
      if (layer) {
        try { layer.setStyle(layer._selBase || {}); } catch(_) {}
        try { layer.unbindTooltip(); } catch(_) {}
      }
      _selKeys.delete(key);
      _selLayers.delete(key);
      if (typeof _selLabels !== 'undefined') _selLabels.delete(key);
      if (typeof _selFeatures !== 'undefined') _selFeatures.delete(key);
    });
    _wizardSelKeys.clear();
    if (typeof _selUpdateBadge === 'function') _selUpdateBadge();
  }

  function selectAllRendered(parcelLayer) {
    if (!parcelLayer || !parcelLayer._geo || typeof _selKeys === 'undefined') return 0;
    let count = 0;
    parcelLayer._geo.eachLayer(layer => {
      const f = layer.feature;
      if (!f) return;
      const key = _featKey(f);
      const label = _featLabel(f);
      _wizardSelKeys.add(key);
      _selKeys.add(key);
      _selLayers.set(key, layer);
      if (label && typeof _selLabels !== 'undefined') _selLabels.set(key, label);
      try {
        const gj = layer.toGeoJSON ? layer.toGeoJSON() : f;
        if (gj && typeof _selFeatures !== 'undefined') _selFeatures.set(key, gj);
      } catch(_) {}
      try { if (typeof _SEL_STYLE !== 'undefined') layer.setStyle(_SEL_STYLE); } catch(_) {}
      if (label) {
        try {
          const center = layer.getBounds ? layer.getBounds().getCenter() : null;
          layer.bindTooltip(_xmlEsc(label), { permanent:true, className:'sel-label', direction:'center', sticky:false, offset:[0,0] });
          if (center) layer.openTooltip(center);
        } catch(_) {}
      }
      count++;
    });
    if (typeof _selUpdateBadge === 'function') _selUpdateBadge();
    return count;
  }

  function computeSelBounds() {
    if (typeof L === 'undefined' || typeof _selLayers === 'undefined') return null;
    let bounds = null;
    _wizardSelKeys.forEach(key => {
      const layer = _selLayers.get(key);
      if (!layer) return;
      try {
        const b = layer.getBounds ? layer.getBounds()
          : (layer.getLatLng ? L.latLngBounds([layer.getLatLng(), layer.getLatLng()]) : null);
        if (b && b.isValid && b.isValid()) {
          bounds = bounds ? bounds.extend(b) : L.latLngBounds(b.getSouthWest(), b.getNorthEast());
        }
      } catch(_) {}
    });
    return bounds;
  }

  // After fitBounds(selBounds) + zoom clamp, the parcel layer may have refetched and rebuilt
  // _geo. Existing _selKeys ensure onEachFeature re-applies the highlight, but _selLayers still
  // points at stale screen layers — rebind them so future manual deselects find the right layer.
  function rebindStaleSelLayers(parcelLayer) {
    if (!parcelLayer || !parcelLayer._geo) return;
    parcelLayer._geo.eachLayer(layer => {
      const f = layer.feature;
      if (!f) return;
      const key = _featKey(f);
      if (_wizardSelKeys.has(key)) _selLayers.set(key, layer);
    });
  }

  /* ===== Apply / reset filter ===== */

  // applyCadasterFilter(sheet, parcelText, onDone)
  //  - onDone(): called exactly once when the async work is complete (success, no-match, timeout
  //    or fast-path) so the caller can re-enable the Go button.
  //  - parcelText empty → fast path: just fitBounds(sheet) + clamp to 14, no selection wait.
  function applyCadasterFilter(sheet, parcelText, onDone) {
    const myGen = ++_wizardGen;
    const parcelLayer = findLayerByTypeName(PARCEL_TYPENAME);
    // Temp minZoom override: when filtering, lower parcel layer's minZoom to 14 so the fetch fires
    // at the sheet's natural zoom (which may land at 14 on large sheets) and 'wfsupdate' is guaranteed.
    // Restored on any completion path (success, no-match, timeout) via _done.
    const _origParcelMinZoom = parcelLayer && parcelLayer.options ? parcelLayer.options.minZoom : null;
    const _restoreMinZoom = () => {
      if (parcelLayer && parcelLayer.options && _origParcelMinZoom != null) {
        parcelLayer.options.minZoom = _origParcelMinZoom;
      }
    };
    const _done = (() => { let called = false; return () => {
      if (called) return; called = true;
      _restoreMinZoom();
      if (typeof onDone === 'function') onDone();
    }; })();
    if (!parcelLayer) {
      // Naming the way back matters here: the layer is missing because it was deleted, and
      // until now nothing in the app told the user it could be brought back.
      setStatus('Manca il layer Catasto Particelle: rimettilo da Configurazione mappe \u203A Ripristina i predefiniti eliminati', true);
      if (typeof toastMsg === 'function') toastMsg('Il layer Catasto Particelle non è configurato', 'error', undefined, 'sidebar');
      _done(); return;
    }
    // Wildcards would slip past the WFS layer's client-side matcher but findParcelsBBox does
    // exact-set membership on NATIONALCADASTRALREFERENCE, so any '*' or '?' short-circuits to
    // "no matches". Reject up front and point the user at the manual WFS filter, which does
    // support wildcards on this layer.
    if (parcelText && /[*?]/.test(parcelText)) {
      setStatus('Qui i caratteri jolly non sono ammessi: usa il filtro del layer Catasto Particelle', true);
      _done(); return;
    }
    clearWizardSelection();
    const hadFilter = !!(parcelLayer.options.filterAttr && parcelLayer.options.filterVals);
    // Filter by NATIONALCADASTRALREFERENCE (sheetRef.parcelLabel) instead of plain LABEL: parcel
    // labels are unique only within a sheet, so a bare label match collides across adjacent sheets
    // in the bbox. Fallback to LABEL when sheet.ref is missing (e.g. legacy cached sheets).
    let targetRefs = null;
    if (parcelText && sheet && sheet.ref) {
      targetRefs = parcelText.split(',').map(p => p.trim()).filter(Boolean)
        .map(p => sheet.ref + '.' + p);
      parcelLayer.setFilter('NATIONALCADASTRALREFERENCE', targetRefs.join(','));
    } else {
      parcelLayer.setFilter('label', parcelText || '');
    }
    if (hadFilter && typeof toastMsg === 'function') {
      toastMsg('Il filtro già attivo su Catasto Particelle è stato sostituito', '', undefined, 'sidebar');
    }
    ensureLayerVisible(parcelLayer);
    const zoningLayer = findLayerByTypeName(ZONING_TYPENAME);
    if (zoningLayer) ensureLayerVisible(zoningLayer);
    // map is declared as top-level `const` in map.js — reachable by bareword from any later
    // script on the page but NOT exposed on `window` (top-level const/let aren't).
    const mapRef = (typeof map !== 'undefined') ? map : null;
    if (!mapRef || !sheet || !sheet.bbox) { _done(); return; }
    // Fast path: no parcel filter → fitBounds(sheet) + clamp to 14, no selection wait.
    if (!parcelText) {
      const [s, w, n, e] = sheet.bbox;
      try {
        mapRef.fitBounds([[s, w], [n, e]], { padding: [30, 30], animate: true });
        if (mapRef.getZoom() < 14 && mapRef.getMaxZoom() >= 14) mapRef.setZoom(14);
      } catch (err) {
        if (window.console) console.warn('cadaster fitBounds (sheet) failed', err);
      }
      revealResult('Zoom sul foglio ' + sheetText(sheet));
      _done(); return;
    }
    // Filtering path — lower parcel layer's minZoom to 14 so subsequent _update fires at the
    // parcel-tight zoom regardless of the original layer config.
    if (parcelLayer.options) parcelLayer.options.minZoom = 14;
    // Ref-based flow: tile-based prefetch resolves the parcel bbox up front so the WFS layer's
    // own fetch runs on a small viewport (immune to AE's silent-zero on wide bboxes). If none of
    // the target refs exist we short-circuit to "no matching" without waiting for the layer.
    if (targetRefs) {
      setStatus('Ricerca delle particelle\u2026', false);
      findParcelsBBox(sheet, targetRefs).then(bb => {
        if (myGen !== _wizardGen) return;
        if (!bb) {
          setStatus('Nessuna particella corrisponde a "' + parcelText + '" nel foglio ' + sheetText(sheet), true);
          _done(); return;
        }
        try {
          mapRef.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]], { padding: [60, 60], animate: false });
          if (mapRef.getZoom() < 17 && mapRef.getMaxZoom() >= 17) mapRef.setZoom(17, { animate: false });
        } catch (err) {
          if (window.console) console.warn('cadaster fitBounds (parcel prefetch) failed', err);
        }
        setStatus('Caricamento particelle\u2026', false);
        _awaitParcelWfsUpdate();
      }).catch(err => {
        if (myGen !== _wizardGen) return;
        if (window.console) console.warn('cadaster parcel prefetch failed', err);
        setStatus(err && err.incomplete ? err.message
                                        : 'Particella non trovata: ' + (err && err.message || err), true);
        _done();
      });
      return;
    }
    // Legacy label-only fallback (sheet.ref missing): keep the old sheet-fitBounds behavior.
    const [s, w, n, e] = sheet.bbox;
    try {
      mapRef.fitBounds([[s, w], [n, e]], { padding: [30, 30], animate: true });
      if (mapRef.getZoom() < 14 && mapRef.getMaxZoom() >= 14) mapRef.setZoom(14);
    } catch (err) {
      if (window.console) console.warn('cadaster fitBounds (sheet) failed', err);
    }
    setStatus('Caricamento particelle\u2026', false);
    _awaitParcelWfsUpdate();
    return;
    function _awaitParcelWfsUpdate() {
    // Step 2 — wait for the WFS layer's next 'wfsupdate' (fired by _render in map.js on both
    // success and zero-feature paths). Safety timeout 30s in case of network failure (the layer
    // toasts its own error already).
    const SAFETY_MS = 30000;
    let timer = null;
    const onUpdate = (ev) => {
      if (timer) { clearTimeout(timer); timer = null; }
      if (myGen !== _wizardGen) return;
      const count = (ev && ev.count) || 0;
      if (count === 0) {
        setStatus('Nessuna particella corrisponde a "' + parcelText + '" nel foglio ' + sheetText(sheet), true);
        _done(); return;
      }
      const marked = selectAllRendered(parcelLayer);
      revealResult(marked === 1 ? 'Selezionata 1 particella' : 'Selezionate ' + marked + ' particelle');
      // Target is now selected → drop the filter so the final (debounced) fetch loads the
      // surrounding parcels too. The selection stays highlighted via _selKeys (identity-based,
      // not filter-based), so it survives the unfiltered re-render. NB: selectAllRendered must
      // NOT run again on that render, or it would select every visible parcel — it doesn't,
      // the re-highlight is automatic in map.js onEachFeature.
      parcelLayer.setFilter('', '');
      const selB = computeSelBounds();
      if (selB && selB.isValid && selB.isValid()) {
        try {
          mapRef.fitBounds(selB, { padding: [30, 30], maxZoom: mapRef.getMaxZoom(), animate: false });
          if (mapRef.getZoom() < 15 && mapRef.getMaxZoom() >= 15) mapRef.setZoom(15, { animate: false });
        } catch (err) {
          if (window.console) console.warn('cadaster fitBounds (selection) failed', err);
        }
        // Rebind _selLayers after the refetch's _render rebuilds _geo. wfsupdate fires at the
        // end of _render, so binding here guarantees new layer instances (moveend would fire
        // before the refetch and bind against the stale _geo).
        parcelLayer.once('wfsupdate', () => {
          if (myGen !== _wizardGen) return;
          rebindStaleSelLayers(parcelLayer);
        });
      }
      _done();
    };
    // fitBounds/setZoom above ran with animate:false — map.getBounds() already reflects the
    // parcel-tight target synchronously by the time we get here. Kill any stale scheduled fetch
    // (including the one queued by the layer's persistent moveend→_schedule listener firing on
    // the sync moveend), invalidate any in-flight response via _reqId bump, then schedule a
    // fresh fetch. No moveend gating or fallback timer needed.
    try { clearTimeout(parcelLayer._timer); } catch(_) {}
    parcelLayer._reqId = (parcelLayer._reqId || 0) + 1;
    parcelLayer.once('wfsupdate', onUpdate);
    parcelLayer._schedule();
    timer = setTimeout(() => {
      timer = null;
      try { parcelLayer.off('wfsupdate', onUpdate); } catch(_) {}
      if (myGen !== _wizardGen) return;
      setStatus('Tempo scaduto in attesa dei dati catastali', true);
      _done();
    }, SAFETY_MS);
    }
  }

  function resetCadasterFilter() {
    _wizardGen++; // invalidate any in-flight selection poll/moveend
    clearWizardSelection();
    const parcelLayer = findLayerByTypeName(PARCEL_TYPENAME);
    if (parcelLayer && (parcelLayer.options.filterAttr || parcelLayer.options.filterVals)) {
      parcelLayer.setFilter('', '');
      if (typeof toastMsg === 'function') toastMsg('Filtro catastale azzerato', '', undefined, 'sidebar');
    }
    setStatus('', false);
  }

  /* ===== UI wiring ===== */

  function fillSelect(sel, items, labelFn, placeholder) {
    sel.innerHTML = '';
    const opt0 = document.createElement('option');
    opt0.value = ''; opt0.textContent = placeholder;
    sel.appendChild(opt0);
    items.forEach((it, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = labelFn(it);
      sel.appendChild(o);
    });
    sel.disabled = items.length === 0;
  }

  function reportError(err, contextMsg) {
    const offline = err && err.message === 'offline';
    const msg = offline
      ? 'Offline \u2014 la ricerca catastale richiede la connessione'
      : contextMsg + ': ' + (err && err.message || err);
    if (typeof toastMsg === 'function') toastMsg(msg, 'error', undefined, 'sidebar');
    setStatus(msg, true);
  }

  function init() {
    const regionSel = $('cad-region');
    const provSel = $('cad-province');
    const comSel = $('cad-comune');
    const sheetSel = $('cad-sheet');
    const parcelIn = $('cad-parcel');
    const goBtn = $('cad-go');
    const resetBtn = $('cad-reset');
    if (!regionSel) return; // panel markup not present

    let _regions = [], _provinces = [], _comuni = [], _sheets = [];
    let _selectedSheet = null;

    function updateGoEnabled() {
      goBtn.disabled = !_selectedSheet;
    }

    /* Reset clears the whole selection, not just the parcel field: leaving region /
       province / comune / foglio filled after the filter is gone showed a query that
       is no longer applied to anything. The region list itself is kept — it is fetched
       once on first activation of the tab and refetching it would be a pointless
       round-trip — only the choice is dropped. */
    function resetWizardForm() {
      regionSel.value = '';
      provSel.innerHTML  = '<option value="">Scegli prima la regione\u2026</option>';
      comSel.innerHTML   = '<option value="">Scegli prima la provincia\u2026</option>';
      sheetSel.innerHTML = '<option value="">Scegli prima il comune\u2026</option>';
      provSel.disabled = comSel.disabled = sheetSel.disabled = true;
      parcelIn.value = '';
      _provinces = []; _comuni = []; _sheets = [];
      _selectedSheet = null;
      updateGoEnabled();
    }

    function onComuneChosen(c) {
      _selectedSheet = null;
      sheetSel.disabled = true;
      sheetSel.innerHTML = '<option value="">Caricamento\u2026</option>';
      resetBtn.disabled = true;
      updateGoEnabled();
      const ensureBbox = c.bbox ? Promise.resolve() : loadComuneBbox(c);
      ensureBbox.then(() => loadSheets(c)).then(list => {
        _sheets = list;
        if (list.incomplete && !list.length) {
          sheetSel.innerHTML = '<option value="">Errore</option>';
          sheetSel.disabled = true;
          setStatus('Il server del catasto non ha restituito i fogli di ' + c.name +
                    '. Riprova scegliendo di nuovo il comune.', true);
          return;
        }
        if (list.incomplete) {
          setStatus('Elenco dei fogli incompleto: il server del catasto non ha risposto per una ' +
                    'parte del comune. Riprova scegliendo di nuovo il comune.', true);
        }
        if (!list.length) {
          sheetSel.innerHTML = '<option value="">Nessun foglio trovato</option>';
          sheetSel.disabled = true;
          if (typeof toastMsg === 'function') toastMsg('Nessun foglio catastale trovato per ' + c.name, 'error', undefined, 'sidebar');
          return;
        }
        fillSelect(sheetSel, list, sh => 'Foglio ' + sheetText(sh), 'Scegli il foglio\u2026');
      }).catch(err => {
        sheetSel.innerHTML = '<option value="">Errore</option>';
        sheetSel.disabled = true;
        reportError(err, 'Errore nel caricamento dei fogli');
      }).finally(() => {
        resetBtn.disabled = false;
      });
    }

    regionSel.addEventListener('change', () => {
      const i = parseInt(regionSel.value, 10);
      provSel.disabled = true; provSel.innerHTML = '<option value="">Caricamento\u2026</option>';
      comSel.disabled = true; comSel.innerHTML = '<option value="">Scegli prima la provincia\u2026</option>';
      sheetSel.disabled = true; sheetSel.innerHTML = '<option value="">Scegli prima il comune\u2026</option>';
      _selectedSheet = null; updateGoEnabled();
      if (!isFinite(i)) { provSel.innerHTML = '<option value="">Scegli prima la regione\u2026</option>'; return; }
      const r = _regions[i];
      loadProvinces(r.code).then(list => {
        _provinces = list;
        fillSelect(provSel, list, p => p.name, 'Scegli la provincia\u2026');
      }).catch(err => {
        provSel.innerHTML = '<option value="">Errore</option>';
        reportError(err, 'Errore nel caricamento delle province');
      });
    });

    provSel.addEventListener('change', () => {
      const i = parseInt(provSel.value, 10);
      comSel.disabled = true; comSel.innerHTML = '<option value="">Caricamento\u2026</option>';
      sheetSel.disabled = true; sheetSel.innerHTML = '<option value="">Scegli prima il comune\u2026</option>';
      _selectedSheet = null; updateGoEnabled();
      if (!isFinite(i)) { comSel.innerHTML = '<option value="">Scegli prima la provincia\u2026</option>'; return; }
      const p = _provinces[i];
      loadComuni(p.code).then(list => {
        _comuni = list;
        fillSelect(comSel, list, c => c.name, 'Scegli il comune\u2026');
      }).catch(err => {
        comSel.innerHTML = '<option value="">Errore</option>';
        reportError(err, 'Errore nel caricamento dei comuni');
      });
    });

    comSel.addEventListener('change', () => {
      const i = parseInt(comSel.value, 10);
      if (!isFinite(i)) return;
      onComuneChosen(_comuni[i]);
    });

    sheetSel.addEventListener('change', () => {
      const i = parseInt(sheetSel.value, 10);
      _selectedSheet = isFinite(i) ? _sheets[i] : null;
      updateGoEnabled();
    });

    goBtn.addEventListener('click', () => {
      if (!_selectedSheet) return;
      const parcel = (parcelIn.value || '').trim();
      const _origText = goBtn.textContent;
      goBtn.disabled = true;
      goBtn.textContent = 'Caricamento\u2026';
      applyCadasterFilter(_selectedSheet, parcel, () => {
        goBtn.textContent = _origText;
        updateGoEnabled();
      });
    });

    resetBtn.addEventListener('click', () => {
      resetCadasterFilter();
      resetWizardForm();
    });

    // Lazy-load regions on first activation of the Cadaster tab.
    const tabBtn = document.querySelector('[data-panel="cadaster"]');
    if (tabBtn) {
      tabBtn.addEventListener('click', function once() {
        tabBtn.removeEventListener('click', once);
        loadRegions().then(list => {
          _regions = list;
          fillSelect(regionSel, list, r => r.name, 'Scegli la regione\u2026');
        }).catch(err => reportError(err, 'Errore nel caricamento delle regioni'));
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
