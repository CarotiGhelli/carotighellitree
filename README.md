# Albero Genealogico — Caroti Ghelli

App web (HTML + CSS + JavaScript puri, **nessuna dipendenza, nessun server**) per creare,
modificare e visualizzare il tuo albero genealogico, con import/export **GEDCOM**.

## Come si apre
Fai **doppio clic su `index.html`** — si apre nel browser. Funziona offline.

## Cosa puoi fare
- **+ Persona**: aggiunge una nuova persona e ne apre la scheda.
- **Clic su una carta**: apre la scheda per modificare nome, cognome, sesso, date e luoghi
  di nascita/morte, note e **foto** (caricata dal tuo computer).
- **Pulsante `+` sotto ogni carta**: aggiunge rapidamente un figlio/a.
- Nella scheda, sezione **Relazioni**:
  - **+ Coniuge/Partner**, **+ Figlio/a**, **+ Genitori**
  - **Scollega** per rimuovere una relazione (la persona non viene eliminata).
  - Clic sul nome di un parente per saltare alla sua scheda.
- **Importa GEDCOM**: carica un file `.ged` (formato standard di MyHeritage, Ancestry, ecc.).
- **Esporta GEDCOM**: scarica l'albero in `.ged`, riapribile su altri programmi.
- **Backup / Ripristina**: salva o ricarica una copia completa in `.json`.
- **Zoom** `+ / − / ⤢` (adatta), **trascina** per spostare, **rotellina** per zoomare.
- **Svuota**: cancella tutto (fai prima un Backup!).

## Accesso
- **Consultare l'albero è libero**: chiunque abbia il link può guardarlo senza accedere.
- **Per modificarlo** serve **accedere con Google** (pulsante "Accedi con Google" in alto a
  destra), con un account nell'elenco delle persone autorizzate. Per aggiungere un
  familiare, vedi le istruzioni in cima a `firestore.rules`.

## Salvataggio
Le modifiche sono salvate **automaticamente** su Firebase Firestore e sincronizzate in
tempo reale su tutti i dispositivi. Ad ogni salvataggio viene tenuta anche una copia di
sicurezza (fino alle ultime 20 versioni, recuperabili da **Cronologia** 🕐 → **Ripristina**).
Per un backup indipendente dal database usa comunque **Esporta GEDCOM** o **Backup**.

## File
- `index.html` — struttura della pagina
- `styles.css` — stile
- `gedcom.js` — lettura/scrittura GEDCOM 5.5.1
- `app.js` — modello dati, layout dell'albero, editor, salvataggio

## Note sul layout
- Carte **azzurre = maschi**, **rosa = femmine**; il puntino verde indica chi è in vita.
- I "suoceri/nonni acquisiti" (chi si è sposato nella famiglia) vengono mostrati sopra il
  rispettivo discendente.
- Limite attuale: nell'albero viene mostrata la **prima** unione di ciascuna persona
  (i matrimoni successivi restano nei dati ma non vengono disegnati). Si può estendere.
