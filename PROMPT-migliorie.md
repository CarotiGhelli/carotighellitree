# Prompt per migliorare il sito dell'albero genealogico

Copia da qui in giù e incollalo in una nuova conversazione con Claude.
Alla voce «COSA VOGLIO MIGLIORARE ORA» scrivi le richieste della sessione.

---

Sto lavorando al sito web del mio albero genealogico di famiglia. Ecco tutto il contesto:

## Il progetto

- **Cartella locale:** `C:\Users\pietr\Desktop\CarotiGhelliTree`
- **Stack:** HTML + CSS + JavaScript puri, senza framework e senza build step.
  - `index.html` — struttura della pagina (usa parametri `?v=N` sui file css/js per invalidare la cache: incrementali ad ogni modifica)
  - `styles.css` — stile (carte azzurre = maschi, rosa = femmine, pallino verde = in vita)
  - `app.js` — modello dati, motore di layout, editor persona, sync Firestore
  - `gedcom.js` — import/export GEDCOM 5.5.1
- **Deploy:** GitHub (`CarotiGhelli/carotighellitree`) → Vercel rideploya automaticamente ad ogni `git push` (~30 secondi). Puoi committare e pushare tu direttamente.
- **Database:** Firebase Firestore, progetto `carotighellitree`, documento unico `trees/main` con `{persons, families, seq}`. Sync in tempo reale via `onSnapshot`, senza login (regole aperte). La configurazione è in `firebase-config.js`.

## Modello dati

- `person` = `{ id, first, last, sex:'M'|'F'|'U', birth, birthPlace, death, deathPlace, deceased, notes, photo }` (foto = dataURL jpeg compresso ~300px)
- `family` = `{ id, husb, wife, children: [id...] }`
- Nell'albero reale ci sono ~140 persone e ~50 famiglie su 6+ generazioni.

## ⚠️ REGOLE CRITICHE — da rispettare sempre

1. **L'anteprima locale scrive sul database di PRODUZIONE.** Non esiste un DB di test: qualsiasi `save()` dalla preview modifica i dati veri della mia famiglia. Non innescare mai salvataggi durante i test; prima di toccare la logica di salvataggio, rileggi le protezioni esistenti in `startListening()`/`save()`.
2. **Mai ri-seminare o sovrascrivere i dati** se una lettura Firestore sembra vuota: potrebbe essere la cache offline (c'è già una protezione con `snap.metadata.fromCache` — non rimuoverla).
3. Prima di modifiche rischiose, esporta un backup JSON dei dati (leggi `trees/main` e salvalo in un file locale fuori dal repo).
4. I file di backup e i dati personali **non vanno committati** (vedi `.gitignore`).
5. Testa sempre nell'anteprima locale con verifiche funzionali (numero carte, posizioni, zero sovrapposizioni) prima di pushare.

## Funzionalità già presenti (non romperle)

- Layout a livelli stile MyHeritage: una riga per generazione, coppie adiacenti come unità atomica, figli centrati sotto i genitori, riserva ricorsiva dello spazio per sottoalbero (stile Reingold–Tilford), regressione isotonica PAVA per le X (mai divergere), de-sovrapposizione per riga.
- Scelta della linea genealogica per coppia: quando entrambi i coniugi hanno ascendenza, di default si mostra la linea **maschile**; pulsante `–`/`+` sopra ciascun coniuge per passare alla linea dell'altro (preferenza locale in localStorage, non condivisa).
- Editor persona (pannello laterale): nome, sesso, date/luoghi, note, foto, relazioni (+ coniuge, + figlio, + genitori, scollega).
- Pulsante `+` sotto ogni carta per aggiungere un figlio; clic = scheda, **doppio clic = famiglia stretta**.
- Import/Export GEDCOM, Backup/Ripristina JSON, zoom/pan, salvataggio automatico con debounce e toast «Salvato ✓».
- **Ricerca per nome** (casella in toolbar) con centratura e lampeggio sulla persona; se la persona è nascosta dalla linea genealogica apre la famiglia stretta.
- **Vista famiglia stretta** (modale): genitori, fratelli, coniugi, figli, tutti cliccabili per navigare; pulsanti "Mostra nell'albero" e "Apri scheda".
- **Esporta PNG** (📷): disegna l'albero visibile su canvas e lo scarica come immagine.
- **Grafica carte**: foto 46px, età calcolata accanto alle date ("n. 1973 · 53 anni", "1931 – 2013 · 82").
- **Cronologia modifiche** (🕐): ogni salvataggio annota data, nome (chiesto una volta per dispositivo, localStorage `albero-user-name`) e azione; ultime 100 voci nel campo `history` del documento Firestore.
- **PIN di famiglia**: per modificare serve il PIN (costante `FAMILY_PIN` in cima ad app.js, attualmente "ghelli"); chiesto una volta per dispositivo. La consultazione resta libera.
- **Statistiche** (📊): persone, famiglie, generazioni, in vita, M/F, cognomi più frequenti, persona più anziana, **compleanni nei prossimi 60 giorni** (esclusi >105 anni presunti deceduti).
- **Percorso di parentela** (🧭): clicchi due persone e viene evidenziato il legame più corto (carte in arancione, resto offuscato, linea sovrapposta); Esc per uscire.
- **Mobile**: pan a un dito, pinch-to-zoom a due dita, toolbar che va a capo, pulsanti più grandi, editor a tutto schermo (media query ≤700px).
- **Selezione multipla ed eliminazione** (☑️): attiva la modalità, clicca le persone (spunta rossa), "Seleziona tutte visibili", poi "Elimina selezionate" (conferma + PIN, una sola scrittura, cronologia). Esc/Annulla per uscire. I connettori familiari sono su **corsie separate** (binari a altezze sfalsate) per non fondersi in un'unica linea.

## COSA VOGLIO MIGLIORARE ORA

(scrivi qui le tue richieste — esempi di idee possibili:)

- [ ] Vista antenati/discendenti a ventaglio per una persona
- [ ] Anniversari di matrimonio (servono le date di matrimonio nel modello famiglia)
- [ ] Esportazione PDF impaginata per la stampa
- [ ] Note/fonti con allegati per ogni persona
- [ ] Cambiare il PIN di famiglia o gestirlo da interfaccia

Lavora in modo autonomo: implementa, verifica nell'anteprima locale e poi committa e pusha tu stesso su GitHub così Vercel pubblica.
