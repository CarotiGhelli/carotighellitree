# Albero Genealogico — Caroti Ghelli

App web (HTML + CSS + JavaScript puri, **nessun framework, nessun build step**) per
creare, modificare e visualizzare il tuo albero genealogico, con import/export **GEDCOM**.
I dati vivono su Firebase (vedi [Accesso](#accesso) e [Salvataggio](#salvataggio)): serve
una connessione internet, non funziona offline.

## Come si apre
In locale, apri una console nella cartella del progetto ed esegui `python -m http.server`
(o un qualsiasi server statico), poi vai su `http://localhost:8000`. **Non aprire
`index.html` con un doppio clic**: da `file://` alcune funzioni del browser richieste da
Firebase non funzionano. Online, l'app è pubblicata automaticamente da Vercel ad ogni
push su GitHub.

## Cosa puoi fare
- **+ Persona**: aggiunge una nuova persona e ne apre la scheda.
- **Clic su una carta**: apre la scheda per modificare nome, cognome, sesso, date e luoghi
  di nascita/morte, note e **foto** (caricata dal tuo computer).
- **Pulsante `+` sotto ogni carta**: aggiunge rapidamente un figlio/a.
- Nella scheda, sezione **Relazioni**:
  - **+ Coniuge/Partner**, **+ Figlio/a**, **+ Genitori**
  - Sulla riga di un coniuge, **+/✎ matrimonio** apre data e luogo del matrimonio.
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

Le **foto** sono su Firebase Storage (non dentro al documento principale, che ha un limite
di 1 MB): l'app avvisa se l'albero si avvicina comunque a quel limite. Perché **Esporta
PNG** includa le foto serve configurare il CORS del bucket Storage (una sola volta, da
riga di comando, con `gsutil cors set` — chiedi assistenza se serve); senza CORS l'export
funziona comunque, semplicemente senza le foto.

## File
- `index.html` — struttura della pagina
- `styles.css` — stile
- `gedcom.js` — lettura/scrittura GEDCOM 5.5.1
- `app.js` — modello dati, layout dell'albero, editor, salvataggio
- `firebase-config.js` — configurazione del progetto Firebase (Firestore, Auth, Storage)
- `firestore.rules` / `storage.rules` — regole di accesso: da incollare manualmente nella
  Firebase Console quando cambiano (vedi i commenti in cima ad ogni file)

## Note sul layout
- Carte **azzurre = maschi**, **rosa = femmine**; il puntino verde indica chi è in vita.
- I "suoceri/nonni acquisiti" (chi si è sposato nella famiglia) vengono mostrati sopra il
  rispettivo discendente.
- Limite attuale: nell'albero viene mostrata la **prima** unione di ciascuna persona
  (i matrimoni successivi restano nei dati ma non vengono disegnati). Si può estendere.
