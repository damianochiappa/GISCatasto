# GISCatasto

App Android per consultare la cartografia catastale italiana sul campo. Le particelle e i fogli
arrivano dai servizi pubblici INSPIRE dell'Agenzia delle Entrate; le mappe che scarichi restano
disponibili senza connessione.

> **App indipendente**: non è affiliata all'Agenzia delle Entrate, al Ministero dell'Ambiente e della
> Sicurezza Energetica o alle Regioni, non li rappresenta e non è un canale ufficiale. I dati sono
> letti al momento della richiesta dai loro servizi pubblici — indirizzi ufficiali in
> [Fonti dei dati](https://damianochiappa.github.io/GISCatasto/#fonti-dei-dati) — e restano dei
> rispettivi enti; quanto mostrato non ha valore certificativo.

[![Licenza: GPL v3](https://img.shields.io/badge/Licenza-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

**Su Google Play:** [play.google.com/store/apps/details?id=com.geotool.giscatasto](https://play.google.com/store/apps/details?id=com.geotool.giscatasto)
— [pagina del progetto](https://damianochiappa.github.io/GISCatasto/).

Questo repository contiene il codice sorgente della versione pubblicata, come richiede la GPL v3.

---

## Cosa fa

- **Catasto** — particelle e fogli del Catasto Terreni (WFS), etichette delle particelle, Catasto
  Fabbricati, acque, strade e confini provinciali (WMS): precaricati e attivi all'avvio, tutti
  dall'Agenzia delle Entrate. I livelli di dettaglio compaiono man mano che si zooma, perché
  l'Agenzia li pubblica solo oltre una certa scala.
- **Ricerca guidata** — regione, provincia, comune, foglio e infine la particella: la mappa ci va
  sopra e la evidenzia, mostrando intorno quelle vicine. Richiede la connessione.
- **Selezione ed export** — tocca le particelle per selezionarle ed esportarle in KML, con colore e
  trasparenza del layer conservati.
- **Livelli tuoi** — WMS, WFS, WMTS/XYZ e ArcGIS MapServer aggiunti per URL, con opacità, colore,
  filtri e ordine di sovrapposizione. Restano salvati e si ricaricano al lancio successivo.
- **File** — importi KML, KMZ, GeoJSON e GPX ed esporti in KML, GeoJSON e GPX (un KMZ si apre ma
  si riscrive come KML), con modifica dei vertici, popup degli attributi e dissolvenza dei
  poligoni.
- **Uso senza connessione** — delimiti un'area disegnando un rettangolo sulla mappa (o con un KML
  che hai già) e scarichi le mappe di quella zona prima di partire. Sono scaricabili l'ortofoto
  nazionale, le CTR regionali e i servizi che aggiungi tu; le mappe di base internazionali
  restano online, perché i loro fornitori non consentono la copia massiva dei tile.
- **Posizione e misure** — coordinate in DD, DMS, UTM e MGRS, bussola, tracce GPS, misura di
  distanze geodetiche sull’ellissoide WGS 84 e aree sulla sua sfera autalica, conversione fra sistemi di riferimento.
- **Navigazione** — percorso verso una destinazione in auto, a piedi o in bicicletta.

## Cosa non fa

- **Non è un navigatore stradale.** La cartografia è raster e non contiene la rete stradale
  vettoriale: l'app disegna il percorso e indica la direzione, ma non dà indicazioni di svolta né
  istruzioni vocali. Il ricalcolo fuori rotta richiede la connessione.
- **I confini non hanno valore legale.** La cartografia catastale ha un'imprecisione propria,
  dell'ordine di alcuni metri, che nessuna app può correggere. Serve a riconoscere una particella,
  non a definire un confine di proprietà: per quello servono un tecnico qualificato e un rilievo
  strumentale.
- **L'area che leggi non è la superficie di visura.** Il numero nel popup è calcolato sulla
  geometria pubblicata dall'Agenzia delle Entrate — per questo si chiama area geometrica: dice
  quanto è estesa la forma sulla mappa, non quanto risulta al catasto. La superficie ufficiale è
  quella della visura, e le due possono differire.
- **La consultazione del catasto richiede la connessione.** I dati arrivano dai servizi
  dell'Agenzia al momento della richiesta e non ne viene conservata una copia. Senza rete restano
  le mappe scaricate e i livelli salvati.
- **La ricerca dei luoghi richiede la connessione**, e non ci sono suggerimenti durante la
  digitazione.
- **Trentino-Alto Adige non è coperto.** Trento e Bolzano hanno un catasto provinciale proprio
  (sistema tavolare), che i servizi dell'Agenzia delle Entrate non pubblicano.

## Privacy

Nessun account, nessuna telemetria, nessun SDK di terze parti, nessun identificativo pubblicitario.
Non esiste un server dell'applicazione: chi la sviluppa non riceve nulla da chi la usa. Tracce,
disegni, livelli e mappe salvate restano sul dispositivo.

Informativa completa: **[damianochiappa.github.io/GISCatasto/privacy](https://damianochiappa.github.io/GISCatasto/privacy/)**

## Compilazione

Il progetto è impacchettato con Apache Cordova e viene costruito on-device con Termux e
proot-distro. `app/` contiene l'applicazione web (HTML, CSS, JavaScript e librerie), `apk/` la
configurazione Cordova, gli hook e le risorse Android.

## Licenza

Copyright (C) 2026 Damiano Chiappa — **GPL v3**, vedi [LICENSE](LICENSE).

Il progetto è GPL v3 perché usa [leaflet-rotate](https://github.com/Raruto/leaflet-rotate), che lo è.
Le altre librerie di terze parti sono MIT, BSD-2 o Apache-2.0: vedi [NOTICES](NOTICES) e
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

I dati catastali sono dell'Agenzia delle Entrate; le mappe di base provengono da OpenStreetMap,
OpenTopoMap, CARTO, Esri e dal Geoportale Nazionale, ciascuna secondo le proprie condizioni.

## Segnalazioni

Bug e proposte nelle [Issue](https://github.com/damianochiappa/GISCatasto/issues).
