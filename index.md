---
title: "GISCatasto — app per il catasto italiano: particelle, fogli, mappe offline, KML"
description: "App Android per consultare la cartografia catastale italiana sul campo: particelle e fogli dai servizi INSPIRE dell'Agenzia delle Entrate, ricerca per comune, foglio e particella, mappe salvabili per l'uso senza connessione, import ed export KML, GPX e GeoJSON."
---

App Android per **consultare la cartografia catastale italiana sul campo**. Le particelle e i fogli
arrivano dai **servizi pubblici INSPIRE dell'Agenzia delle Entrate**; la **ricerca guidata per
comune, foglio e particella** porta la mappa sull'area e la evidenzia; le **mappe scaricate restano
disponibili senza connessione**.

> **App indipendente.** GISCatasto non è affiliata all'Agenzia delle Entrate, al Ministero
> dell'Ambiente e della Sicurezza Energetica o alle Regioni, non li rappresenta e non è un canale
> ufficiale. I dati sono letti al momento della richiesta dai loro servizi pubblici — elencati con i
> link in [Fonti dei dati](#fonti-dei-dati) — e restano dei rispettivi enti; quanto mostrato non ha
> valore certificativo. Per visure ed estratti di mappa ufficiali rivolgiti all'Agenzia delle Entrate.

[![Licenza: GPL v3](https://img.shields.io/badge/Licenza-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

## Dove si scarica

L'app è in **test chiuso** su Google Play: la pubblicazione aperta arriva al termine del periodo di
prova richiesto dallo store.

<!-- Alla pubblicazione, sostituire il paragrafo qui sopra con il badge ufficiale, che va in questa
     posizione — sopra la piega, prima della descrizione:
[![Disponibile su Google Play](https://play.google.com/intl/en_us/badges/static/images/badges/it_badge_web_generic.png)](https://play.google.com/store/apps/details?id=com.geotool.giscatasto)
     Regole del marchio: usare il badge fornito da Google senza modificarlo ne' ritagliarlo. -->

Nel frattempo il codice sorgente è pubblico, come richiede la licenza:
**[github.com/damianochiappa/GISCatasto](https://github.com/damianochiappa/GISCatasto)**

---

## A cosa serve

GISCatasto non sostituisce i software catastali professionali: è uno strumento da campo, per
orientarsi sul terreno.

Ti aiuta a individuare un terreno partendo dagli estremi catastali — comune, foglio e particella — e
a riconoscerlo sulla mappa. Con il GPS lo raggiungi sul posto e ti orienti fra confini, fabbricati,
strade e corsi d'acqua, anche dove non c'è campo, grazie alle mappe salvate prima di partire.

I dati dell'Agenzia delle Entrate sono già configurati e attivi al primo avvio: particelle e fogli
del Catasto Terreni, le etichette delle particelle, il Catasto Fabbricati, acque, strade e i confini
provinciali. I livelli di dettaglio compaiono man mano che zoomi, perché l'Agenzia li pubblica solo
oltre una certa scala.

Il catasto si sovrappone alla mappa di sfondo che preferisci, e di ogni livello regoli opacità,
colore e ordine di sovrapposizione. Puoi aggiungere altri servizi cartografici indicandone
l'indirizzo una volta sola — WMS, WFS, WMTS/XYZ o ArcGIS MapServer: restano salvati e si ricaricano
agli avvii successivi.

**Per chi è pensato**

- **Proprietari** — individui un terreno che possiedi o hai ereditato partendo dagli estremi
  catastali, anche senza conoscere la zona.
- **Agricoltura** — riconosci i tuoi campi sul terreno ed esporti le particelle in KML o GPX.
- **Geometri, periti e tecnici** — sopralluoghi e consultazione sul campo: ricerca per comune,
  foglio e particella, sovrapposizione di più livelli, lettura e conversione delle coordinate
  (DD, DMS, UTM, MGRS), modifica dei vertici.
- **Rinnovabili e settore forestale** — individui le particelle di interesse e ne riconosci i
  confini prima di un intervento.

Puoi inoltre navigare verso una destinazione, registrare tracce GPS, disegnare, misurare aree e
distanze, unire più particelle in un'unica geometria per calcolarne l'estensione, e salvare il
lavoro in formati compatibili con Google Earth e i principali software GIS.

---

## Cosa questa app non fa

Vale la pena dirlo prima dell'installazione, non dopo.

- **Non è un navigatore stradale.** La cartografia è raster e non contiene la rete stradale
  vettoriale: l'app disegna il percorso e indica la direzione, ma non dice "gira a destra". Il
  ricalcolo fuori rotta richiede la connessione.
- **L'accuratezza dei confini è quella del catasto**, cioè dell'ordine di alcuni metri. Serve a
  riconoscere una particella, non a definire un confine di proprietà con valore legale: quello
  resta compito di un tecnico qualificato, sulla documentazione ufficiale e con un rilievo
  strumentale.
- **La consultazione del catasto richiede la connessione.** Senza rete restano le mappe scaricate e
  i livelli salvati, non l'interrogazione catastale.
- **La ricerca dei luoghi richiede la connessione**, e non suggerisce durante la digitazione.
- **Trentino-Alto Adige non è coperto**: Trento e Bolzano hanno un catasto provinciale proprio
  (sistema tavolare), che i servizi dell'Agenzia delle Entrate non pubblicano.

---

## Note d'uso

L'app funziona anche senza connessione, ma muoversi in aree isolate o impervie comporta rischi che
nessuno strumento elimina: GISCatasto aiuta a orientarsi, non sostituisce preparazione,
attrezzatura adeguata e prudenza. La responsabilità della propria sicurezza resta di chi si muove
sul terreno.

---

## Privacy

Nessun account, nessun sistema di analytics o telemetria, nessun SDK di terze parti e nessun
identificativo pubblicitario. Non esiste un server dell'applicazione: chi la sviluppa non riceve
nulla da chi la usa. Tracce, segnaposti, disegni, livelli importati e mappe salvate restano sul
dispositivo. Le credenziali dei servizi protetti non vengono salvate.

I servizi che l'app interroga per funzionare ricevono le tue richieste come se li visitassi con il
browser, e valgono le rispettive informative.

**[Informativa privacy completa](privacy/)**

---

## Fonti dei dati

I dati non sono di questa applicazione: sono pubblicati dagli enti che li producono, e questi sono i
loro indirizzi ufficiali. Le stesse fonti, con i link, sono nell'app in Info → Fonti.

- **Agenzia delle Entrate** — [consultazione cartografia catastale (WMS/WFS INSPIRE)](https://www.agenziaentrate.gov.it/portale/it/web/guest/schede/fabbricatiterreni/consultazione-cartografia-catastale/servizio-consultazione-cartografia) · [Geoportale Cartografico Catastale](https://geoportale.cartografia.agenziaentrate.gov.it/)
- **[Geoportale Nazionale](https://gn.mase.gov.it/portale/)** — Ministero dell'Ambiente e della Sicurezza Energetica: ortofoto AGEA e limiti amministrativi
- **Geoportali regionali** (CTR) — [Friuli-Venezia Giulia](https://irdat.regione.fvg.it/) · [Lazio](https://geoportale.regione.lazio.it/) · [Liguria](https://geoportal.regione.liguria.it/) · [Puglia](https://pugliacon.regione.puglia.it/web/sit-puglia-sit) · [Sardegna](https://www.sardegnageoportale.it/) · [Sicilia](https://www.sitr.regione.sicilia.it/) · [Toscana](https://www.regione.toscana.it/-/geoscopio)
- **Mappe di base e servizi** — [OpenStreetMap](https://www.openstreetmap.org/copyright) · [OpenTopoMap](https://opentopomap.org/about) · [CARTO](https://carto.com/attributions) · [Esri](https://www.esri.com/en-us/legal/terms/full-master-agreement) · [Open-Meteo](https://open-meteo.com/)

---

## Licenza e sorgenti

Copyright (C) 2026 Damiano Chiappa — **GPL v3**. Il codice sorgente della versione pubblicata è
disponibile pubblicamente, come la licenza richiede.

**Repository:** [github.com/damianochiappa/GISCatasto](https://github.com/damianochiappa/GISCatasto)

<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "MobileApplication",
  "name": "GISCatasto",
  "operatingSystem": "Android 10+",
  "applicationCategory": "UtilitiesApplication",
  "applicationSubCategory": "GIS",
  "description": "App Android per consultare la cartografia catastale italiana sul campo: particelle e fogli dai servizi INSPIRE dell'Agenzia delle Entrate, ricerca per comune, foglio e particella, mappe salvabili per l'uso senza connessione, export KML.",
  "url": "https://damianochiappa.github.io/GISCatasto/",
  "license": "https://www.gnu.org/licenses/gpl-3.0",
  "author": {
    "@type": "Person",
    "name": "Damiano Chiappa",
    "sameAs": [
      "https://github.com/damianochiappa"
    ]
  }
}
</script>
