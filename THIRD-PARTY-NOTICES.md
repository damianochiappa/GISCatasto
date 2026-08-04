# Third-Party Notices

GISCatasto includes the following open-source libraries. Their licenses are reproduced below or referenced via the included files.

---

## Leaflet
- License: BSD-2-Clause
- https://github.com/Leaflet/Leaflet

## leaflet-rotate (Raruto)
- License: **GPL-3.0** — primary reason this project is GPL v3
- https://github.com/Raruto/leaflet-rotate

## Leaflet.draw
- License: MIT
- https://github.com/Leaflet/Leaflet.draw

## Leaflet.PolylineMeasure (ppete2)
- License: BSD-2-Clause
- https://github.com/ppete2/Leaflet.PolylineMeasure

## Leaflet.FileLayer (Makina Corpus)
- License: MIT
- https://github.com/makinacorpus/Leaflet.FileLayer

## ESRI Leaflet
- License: Apache-2.0
- https://github.com/Esri/esri-leaflet

## L.KML (Pavel Shramov, Bruno Bergot)
- License: MIT
- https://github.com/shramov/leaflet-plugins

## OpenLayers
- License: BSD-2-Clause
- https://github.com/openlayers/openlayers

## proj4js
- License: MIT
- https://github.com/proj4js/proj4js

## MGRS (mgrs.js)
- License: MIT
- https://github.com/proj4js/mgrs

## tokml (tmcw)
- License: MIT
- https://github.com/tmcw/tokml

## toGeoJSON (Mapbox)
- License: BSD-2-Clause
- https://github.com/mapbox/togeojson

## JSZip
- License: dual MIT / GPL-3.0 (used here under MIT)
- https://github.com/Stuk/jszip

## Turf.js
- License: MIT
- https://github.com/Turfjs/turf

---

## Runtime services (no bundled library)

## OSRM routing
- License: BSD-2-Clause (public servers — project-osrm.org, routing.openstreetmap.de)

## Default tile providers (public distribution)
- **Satellite Hybrid** layer (`google_hybrid` key): [Stadia Maps](https://stadiamaps.com) "alidade_satellite"
- **Street Map** layer (`google_maps` key): [CartoDB Voyager](https://carto.com/basemaps/) — free for non-commercial use, attribution required

The `google_*` keys are historical identifiers; the public build does **not** use Google Maps tiles. Users can locally override these via `app/js/basemaps-private.js` (excluded from the repo via `.gitignore`).
