---
title: "Informativa privacy — GISCatasto"
permalink: /privacy/
---

# Informativa privacy — GISCatasto

**Ultimo aggiornamento:** 6 agosto 2026

GISCatasto è un'applicazione **indipendente**: non è affiliata all'Agenzia delle Entrate, al Ministero
dell'Ambiente e della Sicurezza Energetica o alle Regioni, non li rappresenta e non è un canale
ufficiale. Interroga i loro servizi pubblici come farebbe un browser; i dati restano dei rispettivi
enti e quanto mostrato non ha valore certificativo. Le fonti ufficiali, con i link, sono in fondo a
questa pagina e nell'app in Info → Fonti.

GISCatasto non richiede un account, non contiene sistemi di analytics o telemetria e non raccoglie
alcun dato. Non esiste un server dell'applicazione: chi la sviluppa non riceve nulla da chi la usa.
Non sono presenti SDK di terze parti, pubblicità o identificativi pubblicitari.

## Cosa resta sul dispositivo

Tracce, segnaposti, disegni, misure, livelli importati e mappe salvate restano sul dispositivo,
insieme alle impostazioni (mappa di base, rotazione, ultima vista) e alle configurazioni dei server
cartografici che aggiungi. Si eliminano disinstallando l'app o dalle funzioni di gestione di cache e
livelli.

Per questa archiviazione non viene chiesto un consenso perché è strettamente necessaria al servizio
che ti aspetti: senza, le mappe offline e i tuoi livelli non potrebbero esistere. Non c'è
profilazione né tracciamento.

## Posizione

L'app usa la posizione (approssimativa e precisa) per mostrarti sulla mappa, per la bussola e per la
navigazione. La usa **solo mentre è in uso**: non c'è raccolta in background. Non viene inviata allo
sviluppatore, che non ha modo di riceverla. Viene comunicata a un servizio esterno solo quando usi
una funzione che lo richiede — il calcolo di un percorso e la ricerca di un indirizzo.

Puoi negare o revocare il permesso dalle impostazioni di Android: l'app continua a funzionare, senza
posizionamento e senza navigazione.

## Servizi di terze parti

I servizi che l'app interroga per funzionare ricevono le tue richieste **come se li visitassi con il
browser** — quindi l'indirizzo IP e l'informazione necessaria a rispondere, di norma l'area di mappa
inquadrata — e valgono le rispettive informative. Il dato serve a produrre la risposta: non viene
conservato dall'app né trasmesso ad altri.

| Servizio | Quando | Cosa riceve |
|---|---|---|
| Agenzia delle Entrate — cartografia catastale | Consultazione di fogli e particelle | Area richiesta |
| Geoportale Nazionale (PCN) | Cascata regione / provincia / comune; ortofoto nazionale come mappa di base | Filtri amministrativi e area richiesta |
| OpenStreetMap, OpenTopoMap, CARTO | Mappe di base | Area richiesta |
| Esri ArcGIS Online | Mappa satellitare e servizi ArcGIS | Area richiesta |
| Nominatim (OpenStreetMap) | Ricerca di un indirizzo | Il testo cercato |
| OSRM / routing OpenStreetMap | Calcolo di un percorso | Partenza e destinazione |
| Open-Meteo | Quando tieni premuto un punto per leggerne la quota del terreno | Le coordinate di quel punto |
| Geoportali regionali (Friuli-Venezia Giulia, Lazio, Liguria, Puglia, Sardegna, Sicilia, Toscana) | Carte tecniche regionali come mappa di base | Area richiesta |
| Server WMS/WFS aggiunti da te | Quando attivi quel livello | Area richiesta |

L'ultima riga dipende da te: un server cartografico che aggiungi riceverà le tue richieste secondo le
proprie condizioni, che non sono sotto il controllo di questa applicazione.

Le richieste viaggiano cifrate (HTTPS) verso tutti questi servizi tranne uno: il Geoportale
Nazionale, che pubblica i propri servizi solo in chiaro (il suo indirizzo HTTPS rimanda a HTTP). Le
richieste dirette a quel servizio — i filtri amministrativi del wizard catastale e, se scegli
l'ortofoto nazionale come mappa di base, l'area inquadrata — sono quindi leggibili lungo il percorso.
Non contengono la tua posizione, che a quel servizio non viene mai inviata. Se preferisci evitarlo,
è sufficiente non usare l'ortofoto nazionale e non usare la ricerca guidata per comune.

## Credenziali di servizi protetti

Le credenziali dei servizi protetti non vengono salvate: la password serve solo a ottenere un token
temporaneo dal servizio stesso — inviata direttamente a quel servizio, non a noi — e il token resta
in memoria fino alla chiusura dell'app. I campi vengono svuotati subito dopo l'invio.

## Permessi di archiviazione

Servono a importare ed esportare i tuoi file (KML, GPX, GeoJSON) e a salvare le mappe per l'uso
offline. Non vengono letti file diversi da quelli che scegli tu.

## Fonti ufficiali dei dati

I servizi qui sopra sono pubblicati dai rispettivi enti; questi sono i loro indirizzi ufficiali.

- Agenzia delle Entrate — [consultazione cartografia catastale (WMS/WFS INSPIRE)](https://www.agenziaentrate.gov.it/portale/it/web/guest/schede/fabbricatiterreni/consultazione-cartografia-catastale/servizio-consultazione-cartografia) · [Geoportale Cartografico Catastale](https://geoportale.cartografia.agenziaentrate.gov.it/)
- [Geoportale Nazionale](https://gn.mase.gov.it/portale/) — Ministero dell'Ambiente e della Sicurezza Energetica
- Geoportali regionali: [Friuli-Venezia Giulia](https://irdat.regione.fvg.it/) · [Lazio](https://geoportale.regione.lazio.it/) · [Liguria](https://geoportal.regione.liguria.it/) · [Puglia](https://pugliacon.regione.puglia.it/web/sit-puglia-sit) · [Sardegna](https://www.sardegnageoportale.it/) · [Sicilia](https://www.sitr.regione.sicilia.it/) · [Toscana](https://www.regione.toscana.it/-/geoscopio)
- [OpenStreetMap](https://www.openstreetmap.org/copyright) · [OpenTopoMap](https://opentopomap.org/about) · [CARTO](https://carto.com/attributions) · [Esri](https://www.esri.com/en-us/legal/terms/full-master-agreement) · [Open-Meteo](https://open-meteo.com/)

## Minori

L'applicazione non è rivolta ai minori e non raccoglie dati personali da alcuna categoria di utenti.

## Modifiche

Eventuali aggiornamenti di questa informativa saranno pubblicati a questo stesso indirizzo, con la
data di revisione aggiornata in testa.

## Contatti

Per domande su questa informativa: **giscatasto@gmail.com**
