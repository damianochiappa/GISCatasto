/* GISCatasto
 * Copyright (C) 2026 Damiano Chiappa
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
'use strict';
/* =====================================================
   COMPASS — map-north indicator, tap to reset to north
   The needle reflects the MAP's bearing (leaflet-rotate), not the device
   magnetometer. On some devices the magnetometer is unreliable and made the
   needle drift/spin at random while standing still; driven by the map it always
   points to true north on the current (possibly track-up) view and never wanders.
===================================================== */

(function () {

  let _svgEl = null, _ctrlDiv = null;
  // Manual rotation lock. Default OFF (north-up): two-finger rotation surprised users
  // who only meant to zoom (field feedback). Persisted, so a user who turns rotation on
  // keeps it across launches. Navigation drives track-up regardless of this flag.
  let _rotationOn = false;
  try { _rotationOn = localStorage.getItem('giscatasto_rotation') === '1'; } catch (_) {}
  let _navAuto = false;   // navigation is currently rotating the map (track-up)

  function _render() {
    if (!_svgEl) return;
    // setBearing applies CSS rotate(+theta) clockwise, so north on the map sits at
    // that same clockwise angle from screen-up — the needle matches it directly.
    const b = (typeof map.getBearing === 'function') ? map.getBearing() : 0;
    _svgEl.style.transform = 'rotate(' + (b || 0) + 'deg)';
  }

  /* Reflect the rotation state on the control: lit when the map can rotate (manual
     toggle on) or is being rotated by navigation, muted when locked to north. */
  function _applyVisual() {
    if (!_ctrlDiv) return;
    _ctrlDiv.classList.toggle('rot-on', _rotationOn || _navAuto);
    _ctrlDiv.classList.toggle('rot-nav', _navAuto);
  }

  /* Enable/disable the two-finger rotate gesture. leaflet-rotate's disable() only
     clears touchGestures.rotate — pinch-zoom stays on — so locking never blocks zoom. */
  function _applyRotateHandler() {
    if (!map.touchRotate) return;
    if (_rotationOn) map.touchRotate.enable();
    else             map.touchRotate.disable();
  }

  /* ===== LEAFLET CONTROL ===== */
  const CompassControl = L.Control.extend({
    options: { position: 'bottomright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control leaflet-control-compass');
      const a   = L.DomUtil.create('a', '', div);
      a.href = '#'; a.title = 'Bussola — tocca per riorientare la mappa a nord';
      a.innerHTML =
        '<svg id="compass-svg" width="20" height="20" viewBox="0 0 24 24" style="display:block;transition:transform .15s ease">' +
          '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.35"/>' +
          '<polygon points="12,3 14,11 12,10 10,11"  fill="#ff4757"/>' +
          '<polygon points="12,21 10,13 12,14 14,13" fill="rgba(200,220,255,0.55)"/>' +
          '<circle cx="12" cy="12" r="1.8" fill="currentColor"/>' +
          '<text x="12" y="6.5" font-family="Arial,sans-serif" font-size="4.2" font-weight="900" fill="#ff4757" text-anchor="middle">N</text>' +
        '</svg>';
      _svgEl = a.querySelector('#compass-svg');
      _ctrlDiv = div;
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(a, 'click', e => {
        L.DomEvent.preventDefault(e);
        // A tap toggles the rotation lock — unless navigation is driving the bearing,
        // where it just snaps back to north (nav will re-rotate on the next fix).
        if (!_navAuto) {
          _rotationOn = !_rotationOn;
          try { localStorage.setItem('giscatasto_rotation', _rotationOn ? '1' : '0'); } catch (_) {}
          _applyRotateHandler();
        }
        // Snap to north + recenter whenever rotation ends locked; leave the view alone
        // when unlocking, so the user keeps whatever bearing they had.
        if (!_rotationOn) {
          if (typeof map.setBearing === 'function') map.setBearing(0);
          if (typeof gpsMarker !== 'undefined' && gpsMarker) {
            map.setView(gpsMarker.getLatLng(), map.getZoom(), { animate: true });
          }
        }
        _applyVisual();
        _render();
      });
      // Initial state: apply the persisted lock and, when locked, force north (the saved
      // view may have restored a non-zero bearing).
      _applyRotateHandler();
      if (!_rotationOn && typeof map.setBearing === 'function') map.setBearing(0);
      _applyVisual();
      _render();
      return div;
    }
  });
  new CompassControl().addTo(map);

  /* Navigation (the only auto track-up case — flight and plain GPS tracking never
     rotate the map) calls this: while on, the compass shows the 'nav' state; when it
     ends, north is restored unless the user has manually enabled free rotation. */
  window._compassSetAuto = function (on) {
    _navAuto = !!on;
    if (!_navAuto && !_rotationOn && typeof map.setBearing === 'function') map.setBearing(0);
    _applyVisual();
    _render();
  };

  /* Keep the needle in step with the map. leaflet-rotate fires 'rotate' on every
     bearing change — tap reset, touch-rotate gesture, and track-up navigation. */
  map.on('rotate', _render);
  map.whenReady(_render);

})();
