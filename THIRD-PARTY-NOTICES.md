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
- Modified: `extendeddata()` skips the properties already emitted as KML elements of their own (see the comment in `app/lib/tokml.js`)

## toGeoJSON (Mapbox)
- License: BSD-2-Clause
- https://github.com/mapbox/togeojson

## JSZip
- License: dual MIT / GPL-3.0 (used here under MIT)
- https://github.com/Stuk/jszip

## Turf.js
- License: MIT
- https://github.com/Turfjs/turf

## EGM96 geoid undulation grid
- Bundled as `app/lib/geoid-egm96.js`
- Source: EGM96, the NGA/NASA global gravity model — **public domain**
- Sampled from the authoritative 15-minute grid distributed with [GeographicLib](https://geographiclib.sourceforge.io/) (`egm96-15.pgm`) down to a 1-degree grid; the surrounding lookup code is part of this program
- Used to state a GNSS altitude above sea level instead of above the WGS 84 ellipsoid

---

## Runtime services (no bundled library)

## OSRM routing
- License: BSD-2-Clause (public servers — project-osrm.org, routing.openstreetmap.de)

## Open-Meteo elevation
- Free for non-commercial use; data licensed CC BY 4.0
- Terrain elevation derived from the [Copernicus DEM](https://spacedata.copernicus.eu/) (ESA / European Union)
- https://open-meteo.com/

## Map and data sources

- **Agenzia delle Entrate** — cadastral mapping (INSPIRE WMS/WFS), public data under the service terms
- **Geoportale Nazionale (PCN)** — administrative boundaries and the AGEA 2012 orthophoto, Ministry of the Environment and Energy Security, public data
- **OpenStreetMap** — base map, address search and routing; © OpenStreetMap contributors, ODbL
- **OpenTopoMap** — topographic map, CC BY-SA
- **Esri and the ArcGIS Online providers** — satellite and thematic maps, under the Esri terms
- **Italian regions** — regional technical maps (CTR), open data of the respective geoportals

The same list, with the links each provider asks for, is in the app under **Info → Attribuzioni e licenze**.
