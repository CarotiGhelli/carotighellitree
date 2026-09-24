/* app.js — Albero Genealogico
 * Dati: Firestore (sync real-time) — nessun login richiesto
 * Viewport (zoom/pan): localStorage per-dispositivo
 */
(function () {
  "use strict";

  // ============================================================ STATO
  const VIEW_KEY = "albero-view-v1";
  let state = { persons: [], families: [] };
  let seq = 1;
  const view = { scale: 1, x: 40, y: 40 };
  let editingId = null;
  let unsubscribeSnapshot = null;
  let saveTimer = null;
  let tempPhoto = null;
  let historyLog = []; // cronologia modifiche (specchiata su Firestore nel documento principale)

  const CARD_W = 160, CARD_H = 64;
  const H_GAP = 26, COUPLE_GAP = 26, V_GAP = 116, TREE_GAP = 80;
  const SETTLE_ITERS = 0; // rifinitura: la riserva ricorsiva è già pulita

  // ============================================================ UTIL
  const $ = (sel) => document.querySelector(sel);
  const cardsEl = $("#cards");
  const linksEl = $("#links");
  const worldEl = $("#world");
  const viewportEl = $("#viewport");

  function newId(prefix) {
    let id;
    do { id = prefix + seq++; } while (findPerson(id) || findFamily(id));
    return id;
  }
  function findPerson(id) { return state.persons.find((p) => p.id === id); }
  function findFamily(id) { return state.families.find((f) => f.id === id); }
  function fullName(p) { return (`${p.first || ""} ${p.last || ""}`).trim() || "(senza nome)"; }
  function familiesAsSpouse(id) { return state.families.filter((f) => f.husb === id || f.wife === id); }
  function familyAsChild(id) { return state.families.find((f) => f.children.includes(id)); }
  function partnerOf(famId, pid) { const f = findFamily(famId); return f ? (f.husb === pid ? f.wife : f.husb) : null; }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }
  function showToast(msg, ms = 3000) {
    const el = $("#syncStatus");
    el.textContent = msg; el.hidden = false;
    clearTimeout(el._t); el._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ============================================================ PIN DI FAMIGLIA (protezione scrittura)
  // Chiunque può GUARDARE l'albero; per MODIFICARE serve questo PIN (chiesto una sola
  // volta per dispositivo). Per cambiarlo, modifica la riga qui sotto.
  const FAMILY_PIN = "ghelli";
  const PIN_KEY = "albero-pin-v1";
  function ensureCanEdit() {
    try { if (localStorage.getItem(PIN_KEY) === FAMILY_PIN) return true; } catch (_) {}
    const p = prompt("PIN di famiglia per modificare l'albero:");
    if (p === null) return false;
    if (p.trim().toLowerCase() === FAMILY_PIN) {
      try { localStorage.setItem(PIN_KEY, FAMILY_PIN); } catch (_) {}
      return true;
    }
    alert("PIN errato. Puoi comunque consultare l'albero, ma non modificarlo.");
    return false;
  }

  // Nome di chi modifica (per la cronologia), chiesto una sola volta per dispositivo
  const USER_KEY = "albero-user-name";
  function getUserName() {
    let n = "";
    try { n = localStorage.getItem(USER_KEY) || ""; } catch (_) {}
    if (!n) {
      n = (prompt("Il tuo nome (comparirà nella cronologia delle modifiche):") || "Anonimo").trim() || "Anonimo";
      try { localStorage.setItem(USER_KEY, n); } catch (_) {}
    }
    return n;
  }

  // ============================================================ DATE (anno, giorno/mese, età)
  function yearOf(s) { const m = String(s || "").match(/\d{3,4}/); return m ? parseInt(m[0], 10) : null; }
  const MONTHS = { GEN: 1, JAN: 1, FEB: 2, MAR: 3, APR: 4, MAG: 5, MAY: 5, GIU: 6, JUN: 6, LUG: 7, JUL: 7, AGO: 8, AUG: 8, SET: 9, SEP: 9, OTT: 10, OCT: 10, NOV: 11, DIC: 12, DEC: 12 };
  function dayMonthOf(s) {
    s = String(s || "").trim();
    let m = s.match(/^(\d{1,2})[\/\-\.\s]+(\d{1,2})[\/\-\.\s]+\d{3,4}$/);
    if (m) { const d = +m[1], mo = +m[2]; if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return { d, m: mo }; }
    m = s.match(/(\d{1,2})\s+([A-Za-z]{3,})/);
    if (m) { const mo = MONTHS[m[2].slice(0, 3).toUpperCase()]; const d = +m[1]; if (mo && d >= 1 && d <= 31) return { d, m: mo }; }
    return null;
  }
  function ageOf(p) {
    const by = yearOf(p.birth); if (by == null) return null;
    const end = (p.death || p.deceased) ? yearOf(p.death) : new Date().getFullYear();
    if (end == null) return null;
    const a = end - by;
    return (a >= 0 && a < 130) ? a : null;
  }

  // ============================================================ PERSISTENZA
  function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (_) {} }
  function loadView() { try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null"); if (v) Object.assign(view, v); } catch (_) {} }

  function save(label) {
    if (!window.db) return;
    clearTimeout(saveTimer);
    showToast("Salvando…", 60000);
    saveTimer = setTimeout(() => {
      const who = getUserName();
      historyLog.push({ t: Date.now(), who, a: label || "Modifica" });
      if (historyLog.length > 100) historyLog = historyLog.slice(-100);
      window.db.collection("trees").doc("main").set({
        persons: state.persons,
        families: state.families,
        seq,
        history: historyLog,
        updatedBy: who,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      })
        .then(() => { saveTimer = null; showToast("Salvato ✓"); })
        .catch((e) => { saveTimer = null; console.warn("Firestore save failed", e); showToast("Errore salvataggio"); });
    }, 1200);
  }

  let seededOnce = false;
  function startListening() {
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = window.db.collection("trees").doc("main").onSnapshot(
      (snap) => {
        // IMPORTANTISSIMO: non agire mai su dati provenienti dalla cache offline.
        // Una lettura offline può sembrare "vuota" e causare una sovrascrittura.
        if (snap.metadata && snap.metadata.fromCache) return;

        if (!snap.exists) {
          // Il documento è davvero assente sul server: crea i dati iniziali UNA sola volta.
          if (!seededOnce) { seededOnce = true; seedData(); save("Creazione dati iniziali"); render(); fitToScreen(); }
          return;
        }
        const data = snap.data();
        if (!data) return;
        // Aggiorna lo stato solo se non c'è un salvataggio pendente (evita flickering)
        if (!saveTimer) {
          state = { persons: data.persons || [], families: data.families || [] };
          seq = data.seq || 1;
          historyLog = Array.isArray(data.history) ? data.history : [];
          render();
        }
      },
      (err) => { console.warn("Firestore listener error", err); showToast("Errore connessione"); }
    );
  }

  // ============================================================ COMPRESSIONE FOTO
  function compressPhoto(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const MAX = 300;
        let w = img.width, h = img.height;
        if (w > MAX || h > MAX) {
          if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
          else { w = Math.round(w * MAX / h); h = MAX; }
        }
        const c = document.createElement("canvas");
        c.width = w; c.height = h;
        c.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL("image/jpeg", 0.75));
      };
      img.onerror = () => resolve(dataUrl);
      img.src = dataUrl;
    });
  }

  // ============================================================ RAMI COMPRESSI
  // collapsedUp: insieme di persone di cui è nascosto il ramo ascendente (la "dinastia").
  // Preferenza LOCALE (non condivisa): salvata in localStorage.
  // Scelta della linea genealogica per ogni coppia "in conflitto" (entrambi i coniugi
  // hanno ascendenza nell'albero). Default: linea MASCHILE (marito). 'W' = linea femminile.
  // Preferenza LOCALE (per dispositivo), non condivisa.
  const LINEAGE_KEY = "albero-lineage-v1";
  let lineageChoice = {}; // famId -> 'H' | 'W'
  function saveLineage() { try { localStorage.setItem(LINEAGE_KEY, JSON.stringify(lineageChoice)); } catch (_) {} }
  function loadLineage() { try { lineageChoice = JSON.parse(localStorage.getItem(LINEAGE_KEY) || "{}") || {}; } catch (_) { lineageChoice = {}; } }

  // Mappe di parentela
  function buildGraph() {
    const byId = {}; state.persons.forEach((p) => (byId[p.id] = p));
    const parent = {}, child = {}, spouse = {};
    state.persons.forEach((p) => { parent[p.id] = []; child[p.id] = []; spouse[p.id] = []; });
    for (const f of state.families) {
      const h = f.husb && byId[f.husb] ? f.husb : null;
      const w = f.wife && byId[f.wife] ? f.wife : null;
      if (h && w) { spouse[h].push(w); spouse[w].push(h); }
      for (const c of f.children) { if (!byId[c]) continue; if (h) { parent[c].push(h); child[h].push(c); } if (w) { parent[c].push(w); child[w].push(c); } }
    }
    return { byId, parent, child, spouse };
  }

  // Coppia "in conflitto" di cui la persona fa parte (entrambi i coniugi hanno ascendenza).
  function clashCoupleOf(id) {
    const g = buildGraph();
    for (const f of state.families) {
      if ((f.husb === id || f.wife === id) && f.husb && f.wife && g.byId[f.husb] && g.byId[f.wife]) {
        if (g.parent[f.husb].length && g.parent[f.wife].length) return f;
      }
    }
    return null;
  }
  function chosenSpouse(f) { return (lineageChoice[f.id] || "H") === "H" ? f.husb : f.wife; }
  function closedSpouse(f) { return (lineageChoice[f.id] || "H") === "H" ? f.wife : f.husb; }

  // Persone nascoste: per ogni coppia in conflitto si nasconde la DINASTIA del coniuge
  // non scelto. Si "inonda" partendo dai suoi genitori, bloccando il coniuge stesso:
  // così restano visibili lui e i suoi discendenti, mentre spariscono i suoi antenati
  // e i rami collaterali (fratelli ecc.) di quella dinastia.
  function computeHidden() {
    const g = buildGraph();
    const clashFams = state.families.filter((f) =>
      f.husb && f.wife && g.byId[f.husb] && g.byId[f.wife] && g.parent[f.husb].length && g.parent[f.wife].length);
    if (!clashFams.length) return new Set();

    const hidden = new Set();
    // 1) Nascondi l'ASCENDENZA (antenati diretti, solo verso l'alto) del coniuge non scelto.
    //    Solo verso l'alto: niente cascata verso i discendenti.
    for (const f of clashFams) {
      const cs = closedSpouse(f);
      const stack = [...g.parent[cs]];
      while (stack.length) { const a = stack.pop(); if (hidden.has(a)) continue; hidden.add(a); for (const p of g.parent[a]) stack.push(p); }
    }
    // Un coniuge scelto/non scelto (mostrato nella coppia) non va mai nascosto.
    for (const f of clashFams) { hidden.delete(chosenSpouse(f)); hidden.delete(closedSpouse(f)); }
    // 2) Pulizia: nascondi i collaterali "foglia" (senza figli) i cui genitori sono
    //    tutti nascosti — così non restano carte orfane staccate (es. un fratello del
    //    coniuge i cui genitori sono ora nascosti). Non tocca chi ha discendenti.
    let changed = true;
    while (changed) {
      changed = false;
      for (const p of state.persons) {
        if (hidden.has(p.id)) continue;
        if (g.child[p.id].length === 0 && g.parent[p.id].length && g.parent[p.id].every((x) => hidden.has(x))) { hidden.add(p.id); changed = true; }
      }
    }
    for (const f of clashFams) { hidden.delete(chosenSpouse(f)); hidden.delete(closedSpouse(f)); }
    return hidden;
  }

  function toggleLineage(id) {
    const f = clashCoupleOf(id);
    if (!f) return;
    lineageChoice[f.id] = (lineageChoice[f.id] || "H") === "H" ? "W" : "H";
    saveLineage(); render();
  }

  // ============================================================ VISTA NAVIGABILE (stile MyHeritage)
  // Preferenza LOCALE per dispositivo. mode:
  //   'all'         -> tutto l'albero (comportamento storico, fallback)
  //   'family'      -> focus + N generazioni su/giù (default navigabile)
  //   'ancestors'   -> solo ascendenti del focus
  //   'descendants' -> solo discendenti del focus
  const VIEWSTATE_KEY = "albero-viewstate-v2";
  const viewState = { mode: "family", focusId: null, upGens: 2, downGens: 2, expUp: {}, expDown: {}, colUp: {}, colDown: {} };
  function saveViewState() { try { localStorage.setItem(VIEWSTATE_KEY, JSON.stringify(viewState)); } catch (_) {} }
  function loadViewState() {
    try { const d = JSON.parse(localStorage.getItem(VIEWSTATE_KEY) || "null"); if (d) Object.assign(viewState, d); } catch (_) {}
    for (const k of ["expUp", "expDown", "colUp", "colDown"]) if (!viewState[k]) viewState[k] = {};
  }

  // Insieme delle persone da mostrare + info sui rami nascosti (per le frecce +/–)
  function computeView() {
    const g = buildGraph();
    if (viewState.mode !== "all" && !viewState.focusId && state.persons.length) viewState.focusId = pickDefaultFocus();
    if (viewState.mode === "all" || !viewState.focusId || !g.byId[viewState.focusId]) return { visible: null, branch: {}, g };
    const vis = new Set([viewState.focusId]);
    const up = viewState.mode === "descendants" ? 0 : viewState.mode === "ancestors" ? 99 : viewState.upGens;
    const down = viewState.mode === "ancestors" ? 0 : viewState.mode === "descendants" ? 99 : viewState.downGens;
    // Biforcazione ascendente: da una coppia si prosegue verso l'alto UNA linea sola
    // (di default il marito → patrilineare). Espandere un coniuge (expUp) fa da
    // interruttore: si segue la SUA linea e si nasconde quella del partner. Così le due
    // dinastie di nonni non si scontrano mai e c'è sempre una sola linea per biforcazione.
    const chooseSide = (parents) => {
      const expd = parents.find((p) => viewState.expUp[p]);
      if (expd) return expd;
      const withAnc = parents.filter((p) => g.parent[p].length);
      return withAnc.find((p) => g.byId[p] && g.byId[p].sex === "M") || withAnc[0] || parents[0];
    };
    const climb = (id, b) => {
      if (viewState.colUp[id]) return;
      if (!(b > 0 || viewState.expUp[id])) return;
      const parents = g.parent[id];
      for (const p of parents) vis.add(p);              // mostra sempre la coppia dei genitori
      if (parents.length) climb(chooseSide(parents), b - 1); // ...ma sali una linea sola
    };
    const descend = (id, b) => { if (viewState.colDown[id]) return; if (!(b > 0 || viewState.expDown[id])) return; for (const c of g.child[id]) { vis.add(c); descend(c, b - 1); } };
    climb(viewState.focusId, up); descend(viewState.focusId, down);
    // coniugi + espansioni per-nodo, fino a stabilità
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of [...vis]) {
        for (const s of g.spouse[id]) if (g.byId[s] && !vis.has(s)) { vis.add(s); changed = true; }
        if (viewState.expUp[id]) for (const p of g.parent[id]) if (!vis.has(p)) { vis.add(p); changed = true; }
        if (viewState.expDown[id]) for (const c of g.child[id]) if (!vis.has(c)) { vis.add(c); changed = true; }
      }
    }
    const countHidden = (id, nb) => {
      const seen = new Set(); const st = [...nb[id]]; let n = 0;
      while (st.length) { const x = st.pop(); if (seen.has(x)) continue; seen.add(x); if (!vis.has(x)) n++; for (const y of nb[x]) st.push(y); }
      return n;
    };
    const branch = {};
    for (const id of vis) {
      branch[id] = {
        hasUp: g.parent[id].length > 0, hasDown: g.child[id].length > 0,
        upShown: g.parent[id].some((p) => vis.has(p)), downShown: g.child[id].some((c) => vis.has(c)),
        hiddenUp: countHidden(id, g.parent), hiddenDown: countHidden(id, g.child),
      };
    }
    return { visible: vis, branch, g };
  }

  function setFocus(id) {
    if (!findPerson(id)) return;
    viewState.focusId = id;
    if (viewState.mode === "all") viewState.mode = "family";
    // ogni cambio focus riparte con la finestra pulita
    viewState.expUp = {}; viewState.expDown = {}; viewState.colUp = {}; viewState.colDown = {};
    saveViewState();
    render(true);
    setTimeout(() => centerOnPerson(id, true), 30);
    updateViewChrome();
  }
  function setViewMode(mode) {
    viewState.mode = mode;
    if (mode !== "all" && !viewState.focusId) viewState.focusId = pickDefaultFocus();
    viewState.expUp = {}; viewState.expDown = {}; viewState.colUp = {}; viewState.colDown = {};
    saveViewState();
    render(true);
    if (mode === "all") setTimeout(() => fitToScreen(true), 30);
    else if (viewState.focusId) setTimeout(() => centerOnPerson(viewState.focusId, true), 30);
    updateViewChrome();
  }
  function isAncestorOfFocus(id, g) {
    const seen = new Set(); const st = [...g.parent[viewState.focusId]];
    while (st.length) { const x = st.pop(); if (x === id) return true; if (seen.has(x)) continue; seen.add(x); for (const p of g.parent[x]) st.push(p); }
    return false;
  }
  function toggleBranch(id, dir) {
    const exp = dir === "up" ? viewState.expUp : viewState.expDown;
    if (exp[id]) {
      delete exp[id]; // torna alla linea di default (marito)
    } else {
      const g = buildGraph();
      // Se allargo l'ascendenza di qualcuno che NON è un antenato del focus (es. il
      // coniuge di un discendente), la sua dinastia si scontrerebbe con la famiglia del
      // focus: allora ri-centro su di lui, così vedo la SUA genealogia senza incroci.
      if (dir === "up" && id !== viewState.focusId && !isAncestorOfFocus(id, g)) { setFocus(id); return; }
      exp[id] = true;
      // Interruttore: seguendo la MIA linea, smetto di seguire quella del coniuge.
      if (dir === "up") for (const s of g.spouse[id]) delete viewState.expUp[s];
    }
    saveViewState(); render(true);
  }
  // Persona di default: chi ha SIA genitori SIA figli nell'albero (una generazione
  // "cerniera" con una bella famiglia attorno), preferendo la più recente.
  function pickDefaultFocus() {
    if (!state.persons.length) return null;
    const g = buildGraph();
    let best = state.persons[0].id, bestScore = -Infinity;
    for (const p of state.persons) {
      const score = (g.parent[p.id].length ? 1000 : 0) + (g.child[p.id].length ? 1000 : 0) + (yearOf(p.birth) || 0);
      if (score > bestScore) { bestScore = score; best = p.id; }
    }
    return best;
  }

  // ============================================================ LAYOUT (a livelli, stile Sugiyama)
  function computeLayout() {
    // In modalità focus la vista decide la visibilità; la linea M/F vale solo in 'all'.
    const inView = currentView.visible; // Set oppure null (=tutti)
    const hidden = inView ? new Set() : computeHidden();
    const show = (id) => (!hidden.has(id)) && (!inView || inView.has(id));
    const persons = state.persons.filter((p) => show(p.id));
    const families = state.families
      .map((f) => ({ id: f.id, husb: f.husb && show(f.husb) ? f.husb : null, wife: f.wife && show(f.wife) ? f.wife : null, children: f.children.filter((c) => show(c)) }))
      .filter((f) => f.husb || f.wife || f.children.length);
    if (!persons.length) return { pos: {}, segs: [], linksSvg: "", width: 0, height: 0 };

    const byId = {}; persons.forEach((p) => (byId[p.id] = p));

    // --- Adiacenze precalcolate ---
    const parentMap = {}, childMap = {}, spouseMap = {}, childFam = {};
    persons.forEach((p) => { parentMap[p.id] = []; childMap[p.id] = []; spouseMap[p.id] = []; });
    for (const f of families) {
      const h = f.husb && byId[f.husb] ? f.husb : null;
      const w = f.wife && byId[f.wife] ? f.wife : null;
      if (h && w) { spouseMap[h].push(w); spouseMap[w].push(h); }
      for (const c of f.children) {
        if (!byId[c]) continue;
        childFam[c] = f;
        if (h) { parentMap[c].push(h); childMap[h].push(c); }
        if (w) { parentMap[c].push(w); childMap[w].push(c); }
      }
    }

    // --- 1) Generazioni (riga verticale) ---
    const gen = {};
    (function () {
      function g(id, st) {
        if (id in gen) return gen[id];
        if (st.has(id)) return 0;
        st.add(id);
        let v = 0;
        for (const p of parentMap[id]) v = Math.max(v, g(p, st) + 1);
        st.delete(id); gen[id] = v; return v;
      }
      persons.forEach((p) => g(p.id, new Set()));
      for (let it = 0; it < persons.length + 5; it++) {
        let changed = false;
        for (const f of families) {
          if (f.husb && f.wife && byId[f.husb] && byId[f.wife]) {
            const m = Math.max(gen[f.husb], gen[f.wife]);
            if (gen[f.husb] !== m) { gen[f.husb] = m; changed = true; }
            if (gen[f.wife] !== m) { gen[f.wife] = m; changed = true; }
          }
        }
        for (const f of families) {
          const ps = [f.husb, f.wife].filter((x) => x && byId[x]);
          if (!ps.length) continue;
          const pg = Math.max(...ps.map((x) => gen[x]));
          for (const c of f.children) if (byId[c] && gen[c] <= pg) { gen[c] = pg + 1; changed = true; }
        }
        // "Pull-down": chi non ha vincoli sopra (o ha margine) viene avvicinato
        // appena sopra i propri figli, per evitare connettori lunghissimi.
        for (const p of persons) {
          const kids = childMap[p.id];
          if (!kids.length) continue;
          const minChild = Math.min(...kids.map((c) => gen[c]));
          const lower = parentMap[p.id].length ? Math.max(...parentMap[p.id].map((x) => gen[x])) + 1 : 0;
          const target = minChild - 1;
          if (target > gen[p.id] && target >= lower) { gen[p.id] = target; changed = true; }
        }
        if (!changed) break;
      }
    })();

    const maxGen = Math.max(...persons.map((p) => gen[p.id]));

    // --- 2) Ordine iniziale (DFS) + righe ---
    const order = new Map(); let oc = 0; const vis = new Set();
    function dfs(id) {
      if (vis.has(id)) return;
      vis.add(id); order.set(id, oc++);
      for (const s of spouseMap[id]) if (!vis.has(s)) { vis.add(s); order.set(s, oc++); }
      for (const c of childMap[id]) dfs(c);
    }
    persons.filter((p) => parentMap[p.id].length === 0).sort((a, b) => gen[a.id] - gen[b.id]).forEach((f) => dfs(f.id));
    persons.forEach((p) => { if (!vis.has(p.id)) dfs(p.id); });

    const rows = [];
    for (let i = 0; i <= maxGen; i++) rows[i] = [];
    persons.forEach((p) => rows[gen[p.id]].push(p.id));
    rows.forEach((r) => r.sort((a, b) => order.get(a) - order.get(b)));

    // --- Unità per riga (coppia = unità atomica) ---
    const unitOf = {};
    const rowUnits = [];
    for (let g = 0; g <= maxGen; g++) {
      const used = new Set(), units = [];
      // Adiacenza coniugale nella stessa generazione (per formare i "cluster di matrimoni")
      const spAdj = {};
      for (const id of rows[g]) spAdj[id] = spouseMap[id].filter((s) => gen[s] === g);
      // Ordina un cluster come un cammino, così ogni coppia sposata è adiacente
      // (es. matrimoni multipli: coniuge1 — persona — coniuge2).
      const orderCluster = (cluster) => {
        if (cluster.length <= 1) return cluster.slice();
        const set = new Set(cluster);
        const start = cluster.find((id) => spAdj[id].filter((s) => set.has(s)).length === 1) || cluster[0];
        const seen = new Set([start]), path = [start];
        let cur = start;
        while (path.length < cluster.length) {
          const nxt = spAdj[cur].find((s) => set.has(s) && !seen.has(s));
          if (nxt) { seen.add(nxt); path.push(nxt); cur = nxt; }
          else { const rem = cluster.find((id) => !seen.has(id)); if (!rem) break; seen.add(rem); path.push(rem); cur = rem; }
        }
        return path;
      };
      for (const id of rows[g]) {
        if (used.has(id)) continue;
        // Raccogli l'intero cluster di matrimoni (componente connessa via coniugi)
        const cluster = []; const stack = [id]; const seen = new Set([id]);
        while (stack.length) { const x = stack.pop(); cluster.push(x); for (const s of spAdj[x]) if (!seen.has(s)) { seen.add(s); stack.push(s); } }
        cluster.forEach((m) => used.add(m));
        let members = orderCluster(cluster);
        if (members.length === 2) members = (byId[members[1]].sex !== "F" && byId[members[0]].sex === "F") ? members : (byId[members[0]].sex === "F" && byId[members[1]].sex !== "F" ? [members[1], members[0]] : members);
        const birthSize = (idm) => (childFam[idm] ? childFam[idm].children.filter((c) => byId[c]).length : 0);
        let primary = members[0];
        for (const m of members) if (birthSize(m) > birthSize(primary)) primary = m;
        const u = { members, g, primary };
        units.push(u); members.forEach((m) => (unitOf[m] = u));
      }
      rowUnits[g] = units;
    }

    // --- 3) Riduzione incroci (baricentro su unità) ---
    const reindex = (g) => rowUnits[g].forEach((u, i) => (u._i = i));
    for (let g = 0; g <= maxGen; g++) reindex(g);
    // connUp usa solo il membro primario: tiene insieme i fratelli.
    const connUp = (u) => { const a = []; for (const p of parentMap[u.primary]) { const pu = unitOf[p]; if (pu && pu.g === u.g - 1) a.push(pu._i); } return a; };
    const connDown = (u) => { const a = []; for (const m of u.members) for (const c of childMap[m]) { const cu = unitOf[c]; if (cu && cu.g === u.g + 1) a.push(cu._i); } return a; };
    const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    for (let iter = 0; iter < 12; iter++) {
      for (let g = 1; g <= maxGen; g++) {
        for (const u of rowUnits[g]) { const c = connUp(u); u._k = c.length ? avg(c) : u._i; }
        rowUnits[g].sort((a, b) => a._k - b._k); reindex(g);
      }
      for (let g = maxGen - 1; g >= 0; g--) {
        for (const u of rowUnits[g]) { const c = connDown(u); u._k = c.length ? avg(c) : u._i; }
        rowUnits[g].sort((a, b) => a._k - b._k); reindex(g);
      }
    }

    // --- 4) Coordinate X ---
    const unitWidth = (u) => u.members.length * CARD_W + (u.members.length - 1) * COUPLE_GAP;
    const unitCenter = (u) => u._x + unitWidth(u) / 2;
    for (let g = 0; g <= maxGen; g++) { let x = 0; for (const u of rowUnits[g]) { u._x = x; x += unitWidth(u) + H_GAP; } }

    const centersUp = (u) => { const a = []; for (const p of parentMap[u.primary]) { const pu = unitOf[p]; if (pu && pu.g === u.g - 1) a.push(unitCenter(pu)); } return a.length ? avg(a) : null; };
    const centersDown = (u) => { const a = []; for (const m of u.members) for (const c of childMap[m]) { const cu = unitOf[c]; if (cu && cu.g === u.g + 1) a.push(unitCenter(cu)); } return a.length ? avg(a) : null; };

    // Posiziona la riga il più vicino possibile alle posizioni desiderate (in u._x)
    // mantenendo l'ordine e le distanze minime. Usa l'algoritmo PAVA (regressione
    // isotonica): è ottimo, O(n) e — soprattutto — non diverge mai.
    function resolveRow(g) {
      const us = rowUnits[g];
      const n = us.length;
      if (!n) return;
      const w = us.map(unitWidth);
      const S = new Array(n); S[0] = 0;
      for (let i = 1; i < n; i++) S[i] = S[i - 1] + (w[i - 1] / 2 + H_GAP + w[i] / 2);
      // target del centro trasformato per renderlo un problema "non decrescente"
      const t = us.map((u, i) => (u._x + w[i] / 2) - S[i]);
      const blocks = []; // {v: valore, c: quanti punti}
      for (let i = 0; i < n; i++) {
        let nb = { v: t[i], c: 1 };
        while (blocks.length && blocks[blocks.length - 1].v >= nb.v) {
          const pb = blocks.pop();
          nb = { v: (pb.v * pb.c + nb.v * nb.c) / (pb.c + nb.c), c: pb.c + nb.c };
        }
        blocks.push(nb);
      }
      let i = 0;
      for (const b of blocks) for (let j = 0; j < b.c; j++) { const center = b.v + S[i]; us[i]._x = center - w[i] / 2; i++; }
    }

    // Riserva di spazio ricorsiva (stile Reingold–Tilford sull'albero delle coppie):
    // ogni coppia riserva una banda per i suoi discendenti, così i sottoalberi non
    // si intrecciano mai e i collegamenti restano corti e locali (come MyHeritage).
    // Figli "primari": solo le unità di cui QUESTA coppia è il genitore del membro
    // di sangue dominante. Così l'albero di riserva è un vero albero (ogni unità ha
    // un solo genitore) e nessuno viene rivendicato due volte / stirato.
    const childUnitsOf = (u) => {
      const seen = new Set(), res = [];
      for (const m of u.members) for (const c of childMap[m]) {
        const cu = unitOf[c];
        if (cu && cu.g > u.g && !seen.has(cu) && parentMap[cu.primary].includes(m)) { seen.add(cu); res.push(cu); }
      }
      res.sort((a, b) => a._i - b._i);
      return res;
    };
    // Tutti i figli (anche quelli "acquisiti" tramite il coniuge): serve per
    // posizionare gli antenati acquisiti vicino ai loro discendenti.
    const childUnitsAll = (u) => {
      const seen = new Set(), res = [];
      for (const m of u.members) for (const c of childMap[m]) {
        const cu = unitOf[c];
        if (cu && cu.g > u.g && !seen.has(cu)) { seen.add(cu); res.push(cu); }
      }
      return res;
    };
    let nextFree = 0;
    const placedU = new Set();
    function placeUnit(u) {
      if (placedU.has(u)) return u._cx;
      placedU.add(u);
      const kids = childUnitsOf(u);
      kids.filter((cu) => !placedU.has(cu)).forEach(placeUnit);
      // Centra sui figli primari; se non ne ha (coppia di soli antenati acquisiti),
      // ripiega sul figlio acquisito così l'antenato sta sopra il discendente.
      const centerKids = kids.length ? kids : childUnitsAll(u);
      const cxs = centerKids.map((cu) => cu._cx).filter((x) => x != null);
      if (cxs.length) {
        u._cx = (Math.min(...cxs) + Math.max(...cxs)) / 2;
      } else {
        u._cx = nextFree + unitWidth(u) / 2;
        nextFree += unitWidth(u) + H_GAP;
      }
      return u._cx;
    }
    const descCount = (u, seen) => { if (seen.has(u)) return 0; seen.add(u); let n = 1; for (const cu of childUnitsOf(u)) n += descCount(cu, seen); return n; };
    rowUnits[0].slice().sort((a, b) => descCount(b, new Set()) - descCount(a, new Set())).forEach(placeUnit);
    for (let g = 0; g <= maxGen; g++) for (const u of rowUnits[g]) if (!placedU.has(u)) placeUnit(u);
    for (let g = 0; g <= maxGen; g++) for (const u of rowUnits[g]) u._x = u._cx - unitWidth(u) / 2;
    // L'ordine dell'array di riga deve rispecchiare l'ordine spaziale prodotto dalla
    // riserva, altrimenti il PAVA (che assume l'array già ordinato) scombinerebbe tutto.
    for (let g = 0; g <= maxGen; g++) { rowUnits[g].sort((a, b) => a._x - b._x); reindex(g); }
    for (let g = 0; g <= maxGen; g++) resolveRow(g);

    // Rifinitura leggera: pochi passaggi per allineare meglio genitori e figli,
    // partendo già da una disposizione pulita (PAVA garantisce niente sovrapposizioni).
    for (let iter = 0; iter < SETTLE_ITERS; iter++) {
      for (let g = maxGen - 1; g >= 0; g--) { for (const u of rowUnits[g]) { const t = centersDown(u); if (t != null) u._x = t - unitWidth(u) / 2; } resolveRow(g); }
      for (let g = 1; g <= maxGen; g++) { for (const u of rowUnits[g]) { const t = centersUp(u); if (t != null) u._x = t - unitWidth(u) / 2; } resolveRow(g); }
    }

    // --- Posizioni finali ---
    const pos = {};
    for (let g = 0; g <= maxGen; g++) {
      const y = g * V_GAP;
      for (const u of rowUnits[g]) { let x = u._x; for (const m of u.members) { pos[m] = { x, y }; x += CARD_W + COUPLE_GAP; } }
    }

    // In una coppia, metti il "figlio di sangue" dal lato dei propri genitori (verso
    // l'interno, cioè verso i fratelli). Così due coppie di fratelli finiscono coi
    // fratelli ADIACENTI al centro e i coniugi all'esterno: il binario genitore→figli
    // resta corto e non passa più sopra i coniugi in mezzo (come MyHeritage).
    // Vale anche se solo UNO dei due coniugi ha i genitori visibili.
    const parentCenterX = (m) => {
      const a = [];
      for (const p of parentMap[m]) if (pos[p] && gen[p] === gen[m] - 1) a.push(pos[p].x + CARD_W / 2);
      return a.length ? avg(a) : null;
    };
    for (let g = 0; g <= maxGen; g++) for (const u of rowUnits[g]) {
      if (u.members.length !== 2) continue;
      const [a, b] = u.members;
      const pa = parentCenterX(a), pb = parentCenterX(b);
      if (pa == null && pb == null) continue;
      const aLeft = pos[a].x < pos[b].x;
      const mid = (pos[a].x + pos[b].x) / 2 + CARD_W / 2;
      let wantALeft;
      if (pa != null && pb != null) wantALeft = pa <= pb;         // ciascuno verso il proprio genitore
      else if (pa != null) wantALeft = pa <= mid;                 // solo a ha genitori: va verso di loro
      else wantALeft = pb > mid;                                  // solo b ha genitori: b verso i suoi
      if (wantALeft !== aLeft) { const t = pos[a].x; pos[a].x = pos[b].x; pos[b].x = t; }
    }

    // Normalizza origine
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    for (const id in pos) { minX = Math.min(minX, pos[id].x); minY = Math.min(minY, pos[id].y); }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    for (const id in pos) { pos[id].x -= minX; pos[id].y -= minY; }
    for (const id in pos) { maxX = Math.max(maxX, pos[id].x + CARD_W); maxY = Math.max(maxY, pos[id].y + CARD_H); }

    // --- Connettori SVG ---
    const segs = [];
    const buses = []; // un "binario" orizzontale per famiglia (genitori -> figli)
    for (const fam of families) {
      const parents = [fam.husb, fam.wife].filter((x) => x && pos[x]);
      const kids = fam.children.filter((c) => pos[c]);
      if (!parents.length || !kids.length && parents.length < 2) continue;
      let midX, bottomY;
      const childCentersAll = kids.length ? kids.map((c) => pos[c].x + CARD_W / 2) : [];
      const childMean = childCentersAll.length ? childCentersAll.reduce((a, b) => a + b, 0) / childCentersAll.length : null;
      if (parents.length === 2 && Math.abs(pos[parents[0]].y - pos[parents[1]].y) < 4) {
        const a = pos[parents[0]], b = pos[parents[1]];
        const lp = a.x < b.x ? a : b, rp = a.x < b.x ? b : a;
        const adjacent = rp.x - (lp.x + CARD_W) < 60; // coniugi affiancati (coppia normale)
        if (adjacent) {
          segs.push({ x1: lp.x + CARD_W, y1: lp.y + CARD_H / 2, x2: rp.x, y2: rp.y + CARD_H / 2 });
          midX = (lp.x + CARD_W + rp.x) / 2; bottomY = lp.y + CARD_H;
        } else {
          // Coppia "spezzata" (es. matrimonio multiplo): niente linea orizzontale lunga.
          // Aggancio i figli al genitore più vicino a loro.
          const pick = childMean == null ? a : [a, b].reduce((u, v) => Math.abs((v.x + CARD_W / 2) - childMean) < Math.abs((u.x + CARD_W / 2) - childMean) ? v : u);
          midX = pick.x + CARD_W / 2; bottomY = pick.y + CARD_H;
        }
      } else {
        midX = pos[parents[0]].x + CARD_W / 2; bottomY = pos[parents[0]].y + CARD_H;
      }
      if (!kids.length) continue;
      const childTop = Math.min(...kids.map((c) => pos[c].y));
      const centers = childCentersAll;
      buses.push({ kids, midX, bottomY, childTop, x1: Math.min(midX, ...centers), x2: Math.max(midX, ...centers) });
    }

    // Ogni famiglia ha la sua CORSIA: famiglie che scendono nella stessa riga e sono
    // orizzontalmente vicine ricevono altezze diverse, così i binari di fratelli di
    // famiglie diverse non si fondono mai in un'unica linea continua.
    const groups = {};
    for (const b of buses) { const k = Math.round(b.childTop); (groups[k] = groups[k] || []).push(b); }
    for (const k in groups) {
      const gs = groups[k].sort((a, b) => a.x1 - b.x1);
      const laneEnd = []; // per ogni corsia, l'ultima x occupata
      // Due famiglie condividono la stessa altezza solo se molto distanti (>400px):
      // così due binari vicini non vengono mai percepiti come un'unica linea.
      for (const b of gs) {
        let lane = laneEnd.findIndex((e) => b.x1 > e + 400);
        if (lane === -1) { lane = laneEnd.length; laneEnd.push(b.x2); }
        else laneEnd[lane] = b.x2;
        b.lane = lane;
      }
      const lanes = laneEnd.length;
      for (const b of gs) {
        const gap = b.childTop - b.bottomY;
        const step = Math.min(12, Math.max(7, (gap - 18) / Math.max(1, lanes - 1)));
        b.busY = Math.max(b.bottomY + 8, b.childTop - 12 - b.lane * step);
      }
    }
    for (const b of buses) {
      segs.push({ x1: b.midX, y1: b.bottomY, x2: b.midX, y2: b.busY });
      segs.push({ x1: b.x1, y1: b.busY, x2: b.x2, y2: b.busY });
      for (const c of b.kids) {
        const cx = pos[c].x + CARD_W / 2;
        segs.push({ x1: cx, y1: b.busY, x2: cx, y2: pos[c].y });
      }
    }
    const linksSvg = segs.map((s) =>
      `<line x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(1)}" stroke="#9aa7b2" stroke-width="2" stroke-linecap="round"/>`
    ).join("");

    return { pos, segs, linksSvg, width: maxX, height: maxY };
  }

  // ============================================================ RENDER
  let lastLayout = null;
  let currentClash = {}; // id -> { famId, chosen:bool }  (coppie in conflitto, per render)
  let currentView = { visible: null, branch: {}, g: null }; // stato vista per il render corrente

  // Precalcola, una volta per render, chi è in una coppia "in conflitto" e quale lato è scelto
  function computeClashMap() {
    const g = buildGraph();
    const map = {};
    for (const f of state.families) {
      if (f.husb && f.wife && g.byId[f.husb] && g.byId[f.wife] && g.parent[f.husb].length && g.parent[f.wife].length) {
        const ch = (lineageChoice[f.id] || "H") === "H" ? f.husb : f.wife;
        if (!map[f.husb]) map[f.husb] = { famId: f.id, chosen: ch === f.husb };
        if (!map[f.wife]) map[f.wife] = { famId: f.id, chosen: ch === f.wife };
      }
    }
    return map;
  }

  function render(animate) {
    if (pathMode) exitPathMode();
    // Posizioni precedenti (per l'animazione FLIP)
    const oldPos = {};
    if (animate) cardsEl.querySelectorAll(".card").forEach((el) => { oldPos[el.dataset.id] = { x: parseFloat(el.style.left), y: parseFloat(el.style.top) }; });

    cardsEl.innerHTML = "";
    currentClash = computeClashMap();
    currentView = computeView();
    const layout = computeLayout();
    lastLayout = layout;
    $("#emptyHint").hidden = state.persons.length > 0;
    const pad = 60;
    linksEl.setAttribute("width", layout.width + pad);
    linksEl.setAttribute("height", layout.height + pad);
    linksEl.innerHTML = layout.linksSvg;
    for (const p of state.persons) {
      const pp = layout.pos[p.id];
      if (!pp) continue;
      cardsEl.appendChild(buildCard(p, pp));
    }
    worldEl.style.width = (layout.width + pad) + "px";
    worldEl.style.height = (layout.height + pad) + "px";
    applyTransform();
    drawMinimap();
    updateViewChrome();

    if (animate) {
      linksEl.style.opacity = "0";
      requestAnimationFrame(() => {
        cardsEl.querySelectorAll(".card").forEach((el) => {
          const o = oldPos[el.dataset.id];
          if (o) {
            const nx = parseFloat(el.style.left), ny = parseFloat(el.style.top);
            el.style.transition = "none";
            el.style.transform = `translate(${o.x - nx}px, ${o.y - ny}px)`;
            requestAnimationFrame(() => {
              el.style.transition = "transform .45s cubic-bezier(.4,.1,.2,1)";
              el.style.transform = "";
              el.addEventListener("transitionend", () => { el.style.transition = ""; el.style.transform = ""; }, { once: true });
            });
          } else {
            el.classList.add("card-enter");
            requestAnimationFrame(() => el.classList.remove("card-enter"));
          }
        });
        setTimeout(() => { linksEl.style.opacity = "1"; }, 200);
      });
    } else {
      linksEl.style.opacity = "1";
    }
  }

  function buildCard(p, pos) {
    const focusMode = viewState.mode !== "all";
    const info = currentView.branch[p.id] || null;
    const el = document.createElement("div");
    el.className = "card " + (p.sex === "M" ? "male" : p.sex === "F" ? "female" : "unknown");
    if (focusMode && p.id === viewState.focusId) el.classList.add("is-focus");
    el.style.left = pos.x + "px"; el.style.top = pos.y + "px";
    el.dataset.id = p.id;
    const dates = formatDates(p);
    const living = !p.deceased && !p.death;
    const avatar = p.photo
      ? `<div class="avatar" style="background-image:url('${p.photo}')"></div>`
      : `<div class="avatar">${p.sex === "F" ? "👩" : p.sex === "M" ? "👨" : "👤"}</div>`;
    el.innerHTML = `${avatar}
      <div class="info">
        <div class="name">${escapeHtml(fullName(p))}</div>
        ${dates ? `<div class="dates">${escapeHtml(dates)}</div>` : ""}
      </div>
      ${living ? `<span class="living-dot" title="In vita"></span>` : ""}
      <span class="edit-pencil" title="Apri scheda">✎</span>`;

    el.querySelector(".edit-pencil").addEventListener("click", (e) => { e.stopPropagation(); openEditor(p.id); });

    // Clic: selezione/percorso hanno priorità. In modalità focus il clic ri-centra;
    // in 'all' apre la scheda. Doppio clic = famiglia stretta.
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      if (selectMode) { toggleSelect(p.id); return; }
      if (pathMode) { selectForPath(p.id); return; }
      clearTimeout(el._ct);
      el._ct = setTimeout(() => { if (focusMode) setFocus(p.id); else openEditor(p.id); }, 220);
    });
    el.addEventListener("dblclick", (e) => { e.stopPropagation(); clearTimeout(el._ct); if (selectMode || pathMode) return; openFocus(p.id); });

    // Evidenzia la linea diretta focus <-> questa persona al passaggio del mouse
    if (focusMode && !selectMode && !pathMode) {
      el.addEventListener("mouseenter", () => highlightLineage(p.id));
      el.addEventListener("mouseleave", clearLineageHighlight);
    }

    // Selezione multipla
    if (selectMode) {
      el.classList.add("selectable");
      if (selected.has(p.id)) {
        el.classList.add("selected");
        const c = document.createElement("span"); c.className = "sel-check"; c.textContent = "✓"; el.appendChild(c);
      }
    }

    // Barra azioni rapide (compare al passaggio del mouse)
    if (!selectMode && !pathMode) {
      const qa = document.createElement("div");
      qa.className = "quick-actions";
      const mkBtn = (label, title, fn) => { const b = document.createElement("button"); b.textContent = label; b.title = title; b.addEventListener("click", (e) => { e.stopPropagation(); fn(); }); qa.appendChild(b); };
      mkBtn("✎", "Apri scheda", () => openEditor(p.id));
      mkBtn("＋", "Aggiungi figlio/a", () => addChildTo(p.id));
      mkBtn("🎯", "Centra qui", () => setFocus(p.id));
      mkBtn("👪", "Famiglia stretta", () => openFocus(p.id));
      el.appendChild(qa);
    }

    if (focusMode && info) {
      // Frecce sulla FRONTIERA: espandi dove ci sono parenti nascosti; comprimi solo
      // ciò che è stato espanso (come MyHeritage), niente "–" inutili sui nodi interni.
      const upExpand = !info.upShown && info.hasUp;
      const upCollapse = info.upShown && viewState.expUp[p.id];
      if (upExpand || upCollapse) el.appendChild(makeBranchArrow(p.id, "up", info, upExpand));
      const downExpand = !info.downShown && info.hasDown;
      const downCollapse = info.downShown && viewState.expDown[p.id];
      if (downExpand || downCollapse) el.appendChild(makeBranchArrow(p.id, "down", info, downExpand));
    } else if (!focusMode) {
      // 'all': comportamento storico — aggiungi figlio (sotto) + scelta linea M/F (sopra)
      const add = document.createElement("div");
      add.className = "add-btn card-child add-bottom"; add.textContent = "+"; add.title = "Aggiungi figlio/a";
      add.addEventListener("click", (e) => { e.stopPropagation(); addChildTo(p.id); });
      el.appendChild(add);
      const ci = currentClash[p.id];
      if (ci) {
        const tog = document.createElement("div");
        tog.className = "collapse-btn card-child line-top" + (ci.chosen ? "" : " collapsed");
        tog.textContent = ci.chosen ? "–" : "+";
        tog.title = ci.chosen ? `Nascondi la linea di ${fullName(p)}` : `Mostra la linea di ${fullName(p)} (nasconde quella del coniuge)`;
        tog.addEventListener("click", (e) => { e.stopPropagation(); toggleLineage(p.id); });
        el.appendChild(tog);
      }
    }
    return el;
  }

  function makeBranchArrow(id, dir, info, expand) {
    const hidden = dir === "up" ? info.hiddenUp : info.hiddenDown;
    const b = document.createElement("div");
    b.className = `branch-arrow card-child ${dir}` + (expand ? "" : " open");
    b.textContent = expand ? (hidden > 0 ? "+" + hidden : "+") : "–";
    b.title = expand
      ? (dir === "up" ? `Mostra ascendenti${hidden ? " (" + hidden + ")" : ""}` : `Mostra discendenti${hidden ? " (" + hidden + ")" : ""}`)
      : (dir === "up" ? "Nascondi ascendenti" : "Nascondi discendenti");
    b.addEventListener("click", (e) => { e.stopPropagation(); toggleBranch(id, dir); });
    return b;
  }

  // Evidenziazione della linea diretta tra il focus e una persona (solo carte visibili)
  function highlightLineage(id) {
    if (!currentView.g || !viewState.focusId || id === viewState.focusId) return;
    const path = shortestVisiblePath(viewState.focusId, id);
    if (!path) return;
    const set = new Set(path);
    cardsEl.querySelectorAll(".card").forEach((el) => el.classList.toggle("lineage-hi", set.has(el.dataset.id)));
  }
  function clearLineageHighlight() { cardsEl.querySelectorAll(".card.lineage-hi").forEach((el) => el.classList.remove("lineage-hi")); }
  function shortestVisiblePath(a, b) {
    const g = currentView.g || buildGraph();
    const vis = currentView.visible;
    const ok = (x) => !vis || vis.has(x);
    const prev = { [a]: null }; const q = [a];
    while (q.length) {
      const n = q.shift();
      if (n === b) break;
      for (const m of [...g.parent[n], ...g.child[n], ...g.spouse[n]]) if (ok(m) && !(m in prev)) { prev[m] = n; q.push(m); }
    }
    if (!(b in prev)) return null;
    const path = []; let c = b; while (c != null) { path.push(c); c = prev[c]; }
    return path;
  }

  function formatDates(p) {
    const b = p.birth || "", d = p.death || "";
    const a = ageOf(p);
    if (!b && !d) return p.birthPlace || "";
    if (b && d) return `${shortYear(b)} – ${shortYear(d)}${a != null ? ` · ${a}` : ""}`;
    if (b) return `n. ${shortYear(b)}${a != null && !p.deceased && !p.death ? ` · ${a} anni` : ""}`;
    if (d) return `† ${shortYear(d)}`;
    return "";
  }
  function shortYear(s) { const m = String(s).match(/\d{3,4}/); return m ? m[0] : s; }

  // ============================================================ PAN & ZOOM
  function applyTransform() {
    worldEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
  }

  function setupPanZoom() {
    let drag = false, sx = 0, sy = 0, ox = 0, oy = 0;
    viewportEl.addEventListener("mousedown", (e) => {
      if (e.target.closest(".card") || e.target.closest(".add-btn")) return;
      drag = true; sx = e.clientX; sy = e.clientY; ox = view.x; oy = view.y;
      viewportEl.classList.add("panning");
    });
    window.addEventListener("mousemove", (e) => {
      if (!drag) return;
      view.x = ox + (e.clientX - sx); view.y = oy + (e.clientY - sy);
      applyTransform();
    });
    window.addEventListener("mouseup", () => { if (drag) { drag = false; viewportEl.classList.remove("panning"); saveView(); } });
    viewportEl.addEventListener("wheel", (e) => {
      e.preventDefault();
      const r = viewportEl.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    }, { passive: false });

    // --- Touch (telefono/tablet): 1 dito = sposta, 2 dita = pizzica per lo zoom ---
    let tPan = null, tPinch = null;
    const tDist = (e) => Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
    viewportEl.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) {
        if (e.target.closest(".card") || e.target.closest(".add-btn") || e.target.closest(".collapse-btn")) return;
        tPan = { sx: e.touches[0].clientX, sy: e.touches[0].clientY, ox: view.x, oy: view.y };
      } else if (e.touches.length === 2) {
        tPan = null;
        tPinch = { d0: tDist(e), s0: view.scale };
        e.preventDefault();
      }
    }, { passive: false });
    viewportEl.addEventListener("touchmove", (e) => {
      if (tPinch && e.touches.length === 2) {
        e.preventDefault();
        const r = viewportEl.getBoundingClientRect();
        const mx = (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left;
        const my = (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top;
        const target = Math.min(2.5, Math.max(0.2, tPinch.s0 * tDist(e) / tPinch.d0));
        const k = target / view.scale;
        view.x = mx - (mx - view.x) * k;
        view.y = my - (my - view.y) * k;
        view.scale = target;
        applyTransform();
      } else if (tPan && e.touches.length === 1) {
        e.preventDefault();
        view.x = tPan.ox + (e.touches[0].clientX - tPan.sx);
        view.y = tPan.oy + (e.touches[0].clientY - tPan.sy);
        applyTransform();
      }
    }, { passive: false });
    viewportEl.addEventListener("touchend", (e) => {
      if (e.touches.length === 0) { if (tPan || tPinch) saveView(); tPan = null; tPinch = null; }
      else if (e.touches.length === 1 && tPinch) {
        tPinch = null;
        tPan = { sx: e.touches[0].clientX, sy: e.touches[0].clientY, ox: view.x, oy: view.y };
      }
    });
  }

  function zoomAt(mx, my, factor) {
    const ns = Math.min(2.5, Math.max(0.2, view.scale * factor));
    const k = ns / view.scale;
    view.x = mx - (mx - view.x) * k; view.y = my - (my - view.y) * k; view.scale = ns;
    applyTransform(); saveView();
  }

  function fitToScreen(animate) {
    if (!lastLayout) return;
    const vw = viewportEl.clientWidth, vh = viewportEl.clientHeight;
    const w = lastLayout.width || 1, h = lastLayout.height || 1;
    view.scale = Math.max(0.2, Math.min(vw / (w + 80), vh / (h + 80), 1.4));
    view.x = (vw - w * view.scale) / 2; view.y = 30;
    if (animate) animateWorld();
    applyTransform(); saveView(); drawMinimap();
  }

  // ============================================================ MINIMAPPA
  function drawMinimap() {
    const cv = document.getElementById("minimapCanvas");
    if (!cv || !lastLayout || !lastLayout.width) return;
    const W = cv.width, H = cv.height, ctx = cv.getContext("2d");
    ctx.clearRect(0, 0, W, H);
    const lw = lastLayout.width || 1, lh = lastLayout.height || 1;
    const s = Math.min((W - 6) / lw, (H - 6) / lh);
    const ox = (W - lw * s) / 2, oy = (H - lh * s) / 2;
    ctx.fillStyle = "#c3ccd4";
    for (const id in lastLayout.pos) { const p = lastLayout.pos[id]; ctx.fillRect(ox + p.x * s, oy + p.y * s, Math.max(1.5, CARD_W * s), Math.max(1.5, CARD_H * s)); }
    const vw = viewportEl.clientWidth, vh = viewportEl.clientHeight;
    const rx = -view.x / view.scale, ry = -view.y / view.scale;
    ctx.strokeStyle = "#3a7afe"; ctx.lineWidth = 1.5;
    ctx.strokeRect(ox + rx * s, oy + ry * s, (vw / view.scale) * s, (vh / view.scale) * s);
    cv._map = { s, ox, oy };
  }
  function minimapPan(ev) {
    const cv = document.getElementById("minimapCanvas");
    if (!cv || !cv._map) return;
    const r = cv.getBoundingClientRect();
    const { s, ox, oy } = cv._map;
    const wx = ((ev.clientX - r.left) - ox) / s, wy = ((ev.clientY - r.top) - oy) / s;
    view.x = viewportEl.clientWidth / 2 - wx * view.scale;
    view.y = viewportEl.clientHeight / 2 - wy * view.scale;
    animateWorld(); applyTransform(); saveView(); drawMinimap();
  }

  function updateViewChrome() {
    document.querySelectorAll("#viewModes .vm").forEach((b) => b.classList.toggle("active", b.dataset.mode === viewState.mode));
    const lbl = document.getElementById("focusLabel");
    if (lbl) {
      const p = viewState.focusId && findPerson(viewState.focusId);
      const show = viewState.mode !== "all" && p;
      lbl.hidden = !show;
      lbl.textContent = show ? "◎ " + fullName(p) : "";
    }
  }

  // ============================================================ EDITOR
  function openEditor(id) {
    const p = findPerson(id); if (!p) return;
    editingId = id; tempPhoto = p.photo || null;
    $("#editorTitle").textContent = fullName(p);
    $("#fFirst").value = p.first || ""; $("#fLast").value = p.last || "";
    $("#fSex").value = p.sex || "U";
    $("#fBirth").value = p.birth || ""; $("#fBirthPlace").value = p.birthPlace || "";
    $("#fDeath").value = p.death || ""; $("#fDeathPlace").value = p.deathPlace || "";
    $("#fNotes").value = p.notes || "";
    updatePhotoPreview(); renderRelations(p);
    $("#overlay").hidden = false; $("#editor").hidden = false;
  }

  function closeEditor() { $("#overlay").hidden = true; $("#editor").hidden = true; editingId = null; tempPhoto = null; }

  function updatePhotoPreview() {
    const el = $("#photoPreview");
    if (tempPhoto) { el.style.backgroundImage = `url('${tempPhoto}')`; el.textContent = ""; }
    else { el.style.backgroundImage = ""; el.textContent = "👤"; }
  }

  function renderRelations(p) {
    const list = $("#relList"); list.innerHTML = "";
    const addRow = (label, kind, otherId, onRemove) => {
      const row = document.createElement("div"); row.className = "rel-item";
      const other = otherId ? findPerson(otherId) : null;
      row.innerHTML = `<span><strong>${escapeHtml(label)}</strong> <span class="rel-kind">${escapeHtml(kind)}</span></span>`;
      const btn = document.createElement("button"); btn.textContent = "Scollega";
      btn.addEventListener("click", () => { onRemove(); openEditor(p.id); });
      row.appendChild(btn);
      if (other) { row.firstChild.style.cursor = "pointer"; row.firstChild.addEventListener("click", () => { saveCurrent(true); openEditor(other.id); }); }
      list.appendChild(row);
    };
    const cf = familyAsChild(p.id);
    if (cf) {
      if (cf.husb) addRow(fullName(findPerson(cf.husb) || {}), "padre", cf.husb, () => removeChildFromFamily(cf.id, p.id));
      if (cf.wife) addRow(fullName(findPerson(cf.wife) || {}), "madre", cf.wife, () => removeChildFromFamily(cf.id, p.id));
    }
    for (const f of familiesAsSpouse(p.id)) {
      const sp = partnerOf(f.id, p.id);
      if (sp) addRow(fullName(findPerson(sp) || {}), "coniuge", sp, () => unlinkSpouse(f.id, p.id));
      for (const c of f.children) addRow(fullName(findPerson(c) || {}), "figlio/a", c, () => removeChildFromFamily(f.id, c));
    }
  }

  function saveCurrent(silent) {
    const p = findPerson(editingId); if (!p) return;
    if (!ensureCanEdit()) return;
    p.first = $("#fFirst").value.trim(); p.last = $("#fLast").value.trim();
    p.sex = $("#fSex").value;
    p.birth = $("#fBirth").value.trim(); p.birthPlace = $("#fBirthPlace").value.trim();
    p.death = $("#fDeath").value.trim(); p.deathPlace = $("#fDeathPlace").value.trim();
    p.deceased = !!(p.death || p.deathPlace);
    p.notes = $("#fNotes").value; p.photo = tempPhoto || "";
    save(`Modificata la scheda di ${fullName(p)}`); render();
    if (!silent) closeEditor();
  }

  // ============================================================ OPERAZIONI RELAZIONALI
  function createPerson(opts) {
    const p = Object.assign({ id: newId("I"), first: "Nuova", last: "Persona", sex: "U", birth: "", birthPlace: "", death: "", deathPlace: "", deceased: false, notes: "", photo: "" }, opts || {});
    if (!opts || !opts.id) p.id = newId("I");
    state.persons.push(p); return p;
  }

  function addChildTo(parentId) {
    if (!ensureCanEdit()) return;
    const parentName = fullName(findPerson(parentId) || {});
    let fam = familiesAsSpouse(parentId)[0];
    if (!fam) {
      fam = { id: newId("F"), husb: null, wife: null, children: [] };
      const parent = findPerson(parentId);
      if (parent && parent.sex === "F") fam.wife = parentId; else fam.husb = parentId;
      state.families.push(fam);
    }
    const child = createPerson({ last: (findPerson(parentId) || {}).last || "" });
    fam.children.push(child.id); save(`Aggiunto/a figlio/a a ${parentName}`); render(); openEditor(child.id);
  }

  function addPartner(personId) {
    if (!ensureCanEdit()) return;
    const person = findPerson(personId);
    let fam = familiesAsSpouse(personId)[0];
    if (!fam) { fam = { id: newId("F"), husb: null, wife: null, children: [] }; state.families.push(fam); }
    const partnerSex = person.sex === "F" ? "M" : person.sex === "M" ? "F" : "U";
    const partner = createPerson({ first: "Coniuge", last: "", sex: partnerSex });
    if (person.sex === "F") { fam.wife = personId; fam.husb = partner.id; }
    else { fam.husb = personId; fam.wife = partner.id; }
    save(`Aggiunto coniuge a ${fullName(person)}`); render(); openEditor(partner.id);
  }

  function addParents(personId) {
    if (!ensureCanEdit()) return;
    let fam = familyAsChild(personId);
    if (!fam) { fam = { id: newId("F"), husb: null, wife: null, children: [personId] }; state.families.push(fam); }
    if (!fam.husb) { const f = createPerson({ first: "Padre", last: (findPerson(personId) || {}).last || "", sex: "M" }); fam.husb = f.id; }
    if (!fam.wife) { const m = createPerson({ first: "Madre", last: "", sex: "F" }); fam.wife = m.id; }
    save(`Aggiunti genitori a ${fullName(findPerson(personId) || {})}`); render();
  }

  function removeChildFromFamily(famId, childId) {
    if (!ensureCanEdit()) return;
    const f = findFamily(famId); if (!f) return;
    f.children = f.children.filter((c) => c !== childId); cleanupFamily(famId);
    save(`Scollegato/a ${fullName(findPerson(childId) || {})} dai genitori`); render();
  }

  function unlinkSpouse(famId, personId) {
    if (!ensureCanEdit()) return;
    const f = findFamily(famId); if (!f) return;
    if (f.husb === personId) f.husb = null; else if (f.wife === personId) f.wife = null;
    cleanupFamily(famId); save(`Scollegato coniuge di ${fullName(findPerson(personId) || {})}`); render();
  }

  function cleanupFamily(famId) {
    const f = findFamily(famId); if (!f) return;
    if (!f.husb && !f.wife && !f.children.length) state.families = state.families.filter((x) => x.id !== famId);
  }

  function deletePerson(id) {
    if (!ensureCanEdit()) return;
    const name = fullName(findPerson(id) || {});
    state.persons = state.persons.filter((p) => p.id !== id);
    for (const f of state.families) {
      if (f.husb === id) f.husb = null; if (f.wife === id) f.wife = null;
      f.children = f.children.filter((c) => c !== id);
    }
    state.families = state.families.filter((f) => f.husb || f.wife || f.children.length);
    save(`Eliminata la persona: ${name}`); render();
  }

  // ============================================================ IMPORT / EXPORT
  function importGedcomText(text) {
    if (!ensureCanEdit()) return;
    const data = window.GEDCOM.parse(text);
    if (!data.persons.length) { alert("Nessuna persona trovata nel file GEDCOM."); return; }
    state = data; seq = 1;
    state.persons.forEach((p) => bumpSeq(p.id)); state.families.forEach((f) => bumpSeq(f.id));
    save("Importato albero da file GEDCOM"); render(); fitToScreen();
  }
  function bumpSeq(id) { const m = String(id).match(/(\d+)/); if (m) seq = Math.max(seq, parseInt(m[1], 10) + 1); }

  function downloadFile(name, content, mime) {
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = document.createElement("a"); a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ============================================================ DATI INIZIALI
  function seedData() {
    const P = [];
    const mk = (id, first, last, sex, opts) =>
      P.push(Object.assign({ id, first, last, sex, birth: "", birthPlace: "", death: "", deathPlace: "", deceased: false, notes: "", photo: "" }, opts || {}));

    mk("I1", "Carlo", "Caroti Ghelli", "M", { deceased: true });
    mk("I2", "Emma", "Baldacci", "F", { deceased: true });
    mk("I3", "Sconosciuto", "Capobianchi", "M", { deceased: true });
    mk("I4", "Sconosciuto", "", "F", { deceased: true });
    mk("I5", "Franco", "Caroti Ghelli", "M");
    mk("I6", "Rosaria", "", "F");
    mk("I7", "Piero", "Caroti Ghelli", "M");
    mk("I8", "Miranda", "Capobianchi", "F");
    mk("I9", "Claudio", "Capobianchi", "M");
    mk("I10", "Francesca", "Caroti Ghelli", "F");
    mk("I11", "Cristina", "Caroti Ghelli", "F");
    mk("I12", "Enrico", "Caroti Ghelli", "M");
    mk("I13", "Michela", "La Marca", "F");
    mk("I14", "Alessandro", "De Notariis", "M");
    mk("I15", "Claudia", "Caroti Ghelli", "F");
    mk("I16", "Rocco", "Caroti Ghelli", "M");
    mk("I17", "Pietro", "Caroti Ghelli", "M");
    mk("I18", "Matilde", "De Notariis", "F");
    mk("I19", "Matteo", "De Notariis", "M");

    const F = [];
    const fam = (id, husb, wife, children) => F.push({ id, husb, wife, children });
    fam("F1", "I1", "I2", ["I5", "I7"]);
    fam("F2", "I3", "I4", ["I8", "I9"]);
    fam("F3", "I5", "I6", ["I10", "I11"]);
    fam("F4", "I7", "I8", ["I12", "I15"]);
    fam("F5", "I12", "I13", ["I16", "I17"]);
    fam("F6", "I14", "I15", ["I18", "I19"]);
    state = { persons: P, families: F }; seq = 20;
  }

  // ============================================================ MODALE GENERICA
  function openModal(title, bodyHtml) {
    $("#modalTitle").textContent = title;
    $("#modalBody").innerHTML = bodyHtml;
    $("#modal").hidden = false;
    return $("#modalBody");
  }
  function closeModal() { $("#modal").hidden = true; }

  // Riga-persona cliccabile riutilizzata da ricerca / famiglia stretta / statistiche
  function miniPersonHtml(p, extra) {
    const dotCls = p.sex === "M" ? "male" : p.sex === "F" ? "female" : "unknown";
    return `<div class="mini-person" data-id="${p.id}">
      <span class="mini-dot ${dotCls}"></span>
      <span class="mini-name">${escapeHtml(fullName(p))}</span>
      <span class="mini-extra">${escapeHtml(extra != null ? extra : (formatDates(p) || ""))}</span>
    </div>`;
  }

  // ============================================================ RICERCA
  function bindSearch() {
    const box = $("#searchBox"), res = $("#searchResults");
    const hide = () => { res.hidden = true; };
    box.addEventListener("input", () => {
      const q = box.value.trim().toLowerCase();
      if (q.length < 2) { hide(); return; }
      const matches = state.persons.filter((p) => fullName(p).toLowerCase().includes(q)).slice(0, 8);
      if (!matches.length) { res.innerHTML = `<div class="search-empty">Nessun risultato</div>`; res.hidden = false; return; }
      res.innerHTML = matches.map((p) => {
        const vis = lastLayout && lastLayout.pos[p.id];
        return miniPersonHtml(p, (formatDates(p) || "") + (vis ? "" : " · nascosta"));
      }).join("");
      res.hidden = false;
    });
    res.addEventListener("mousedown", (e) => {
      const row = e.target.closest(".mini-person"); if (!row) return;
      e.preventDefault();
      const id = row.dataset.id;
      box.value = ""; hide(); box.blur();
      if (viewState.mode !== "all") { setFocus(id); return; } // in modalità focus, ri-centra su di lei
      if (lastLayout && lastLayout.pos[id]) centerOnPerson(id);
      else openFocus(id); // nascosta dalla linea genealogica: mostra la famiglia stretta
    });
    box.addEventListener("blur", () => setTimeout(hide, 200));
    box.addEventListener("keydown", (e) => { if (e.key === "Escape") { box.value = ""; hide(); box.blur(); } });
  }

  function animateWorld() {
    worldEl.classList.add("animating");
    clearTimeout(worldEl._at);
    worldEl._at = setTimeout(() => worldEl.classList.remove("animating"), 480);
  }

  function centerOnPerson(id, animate) {
    const pp = lastLayout && lastLayout.pos[id];
    if (!pp) { openFocus(id); return; }
    const vw = viewportEl.clientWidth, vh = viewportEl.clientHeight;
    if (view.scale < 0.7) view.scale = 0.9;
    view.x = vw / 2 - (pp.x + CARD_W / 2) * view.scale;
    view.y = vh / 2.6 - pp.y * view.scale;
    if (animate) animateWorld();
    applyTransform(); saveView();
    if (!animate) {
      const el = cardsEl.querySelector(`.card[data-id="${id}"]`);
      if (el) { el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); setTimeout(() => el.classList.remove("flash"), 2800); }
    }
  }

  // ============================================================ FAMIGLIA STRETTA
  function openFocus(id) {
    const p = findPerson(id); if (!p) return;
    const cf = familyAsChild(id);
    const parents = [], siblings = [];
    if (cf) {
      if (cf.husb && findPerson(cf.husb)) parents.push(findPerson(cf.husb));
      if (cf.wife && findPerson(cf.wife)) parents.push(findPerson(cf.wife));
      for (const c of cf.children) if (c !== id && findPerson(c)) siblings.push(findPerson(c));
    }
    const unions = familiesAsSpouse(id).map((f) => ({
      spouse: findPerson(partnerOf(f.id, id)),
      children: f.children.map(findPerson).filter(Boolean),
    }));
    const sect = (title, arr) => arr.length ? `<div class="focus-sect"><h4>${title}</h4>${arr.map((x) => miniPersonHtml(x)).join("")}</div>` : "";
    let html = `<div class="focus-me">${miniPersonHtml(p)}</div>`;
    html += sect("Genitori", parents);
    html += sect("Fratelli e sorelle", siblings);
    for (const u of unions) {
      if (u.spouse) html += sect("Coniuge", [u.spouse]);
      html += sect("Figli", u.children);
    }
    if (!parents.length && !siblings.length && !unions.length) html += `<p class="focus-none">Nessuna relazione registrata.</p>`;
    const visible = lastLayout && lastLayout.pos[id];
    html += `<div class="focus-actions">
      ${visible ? `<button class="btn" id="focusCenter">Mostra nell'albero</button>` : ""}
      <button class="btn btn-primary" id="focusEdit">Apri scheda</button>
    </div>`;
    const body = openModal("Famiglia di " + fullName(p), html);
    body.querySelectorAll(".mini-person").forEach((row) => {
      if (row.dataset.id !== id) row.addEventListener("click", () => openFocus(row.dataset.id));
    });
    const fc = body.querySelector("#focusCenter");
    if (fc) fc.addEventListener("click", () => { closeModal(); centerOnPerson(id); });
    body.querySelector("#focusEdit").addEventListener("click", () => { closeModal(); openEditor(id); });
  }

  // ============================================================ STATISTICHE & COMPLEANNI
  function computeGenerationsCount() {
    if (!state.persons.length) return 0;
    const g = buildGraph();
    const gen = {};
    state.persons.forEach((p) => (gen[p.id] = 0));
    for (let it = 0; it < state.persons.length + 5; it++) {
      let ch = false;
      // i coniugi stanno sulla stessa generazione (come nel disegno)
      for (const f of state.families) {
        if (f.husb && f.wife && g.byId[f.husb] && g.byId[f.wife]) {
          const m = Math.max(gen[f.husb], gen[f.wife]);
          if (gen[f.husb] !== m) { gen[f.husb] = m; ch = true; }
          if (gen[f.wife] !== m) { gen[f.wife] = m; ch = true; }
        }
      }
      for (const f of state.families) {
        const ps = [f.husb, f.wife].filter((x) => x && g.byId[x]);
        if (!ps.length) continue;
        const pg = Math.max(...ps.map((x) => gen[x]));
        for (const c of f.children) if (g.byId[c] && gen[c] <= pg) { gen[c] = pg + 1; ch = true; }
      }
      if (!ch) break;
    }
    let mx = 0; state.persons.forEach((p) => (mx = Math.max(mx, gen[p.id])));
    return mx + 1;
  }

  function upcomingBirthdays(days) {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const out = [];
    for (const p of state.persons) {
      if (p.deceased || p.death) continue;
      const dm = dayMonthOf(p.birth); if (!dm) continue;
      let next = new Date(today.getFullYear(), dm.m - 1, dm.d);
      if (next < today) next = new Date(today.getFullYear() + 1, dm.m - 1, dm.d);
      const diff = Math.round((next - today) / 86400000);
      if (diff <= days) {
        const by = yearOf(p.birth);
        const turns = by != null ? next.getFullYear() - by : null;
        // Persone nate >105 anni fa senza data di morte: quasi certamente decedute
        // ma non registrate — meglio non mostrarle tra i compleanni.
        if (turns != null && turns > 105) continue;
        out.push({ p, next, diff, turns });
      }
    }
    out.sort((a, b) => a.diff - b.diff);
    return out;
  }

  function openStats() {
    const ps = state.persons;
    const male = ps.filter((p) => p.sex === "M").length;
    const female = ps.filter((p) => p.sex === "F").length;
    const living = ps.filter((p) => !p.deceased && !p.death).length;
    const surn = {};
    ps.forEach((p) => { const l = (p.last || "").trim(); if (l) surn[l] = (surn[l] || 0) + 1; });
    const top = Object.entries(surn).sort((a, b) => b[1] - a[1]).slice(0, 6);
    let oldest = null;
    ps.forEach((p) => { if (!p.deceased && !p.death) { const a = ageOf(p); if (a != null && (!oldest || a > oldest.a)) oldest = { p, a }; } });
    const bd = upcomingBirthdays(60);
    const fmt = new Intl.DateTimeFormat("it-IT", { day: "numeric", month: "long" });
    let html = `<div class="stats-grid">
      <div class="stat"><b>${ps.length}</b><span>persone</span></div>
      <div class="stat"><b>${state.families.length}</b><span>famiglie</span></div>
      <div class="stat"><b>${computeGenerationsCount()}</b><span>generazioni</span></div>
      <div class="stat"><b>${living}</b><span>in vita</span></div>
      <div class="stat"><b>${male}</b><span>maschi</span></div>
      <div class="stat"><b>${female}</b><span>femmine</span></div>
    </div>`;
    if (oldest) html += `<p class="stats-line">Persona in vita più anziana: <strong>${escapeHtml(fullName(oldest.p))}</strong> (${oldest.a} anni)</p>`;
    if (top.length) html += `<div class="focus-sect"><h4>Cognomi più frequenti</h4>${top.map(([l, n]) => `<div class="stats-row"><span>${escapeHtml(l)}</span><b>${n}</b></div>`).join("")}</div>`;
    html += `<div class="focus-sect"><h4>Compleanni nei prossimi 60 giorni</h4>` +
      (bd.length
        ? bd.slice(0, 12).map((b) => miniPersonHtml(b.p, `${fmt.format(b.next)}${b.turns != null ? ` · compie ${b.turns}` : ""}${b.diff === 0 ? " · OGGI 🎂" : ""}`)).join("")
        : `<p class="focus-none">Nessun compleanno imminente (o date senza giorno e mese).</p>`) +
      `</div>`;
    const body = openModal("Statistiche", html);
    body.querySelectorAll(".mini-person").forEach((row) => row.addEventListener("click", () => {
      closeModal();
      const id = row.dataset.id;
      if (lastLayout && lastLayout.pos[id]) centerOnPerson(id); else openFocus(id);
    }));
  }

  // ============================================================ CRONOLOGIA MODIFICHE
  function openHistory() {
    const fmt = new Intl.DateTimeFormat("it-IT", { dateStyle: "short", timeStyle: "short" });
    const rows = historyLog.slice().reverse();
    const html = rows.length
      ? rows.map((h) => `<div class="hist-row"><span class="hist-when">${fmt.format(new Date(h.t))}</span><span class="hist-who">${escapeHtml(h.who || "?")}</span><span class="hist-what">${escapeHtml(h.a || "")}</span></div>`).join("")
      : `<p class="focus-none">Nessuna modifica registrata finora. Da adesso ogni modifica verrà annotata qui, con nome e data.</p>`;
    openModal("Cronologia modifiche", html);
  }

  // ============================================================ SELEZIONE MULTIPLA
  let selectMode = false;
  const selected = new Set();

  function enterSelectMode() {
    if (pathMode) exitPathMode();
    selectMode = true; selected.clear();
    viewportEl.classList.add("selecting");
    $("#btnSelect").classList.add("active");
    $("#selectBar").hidden = false;
    cardsEl.querySelectorAll(".card").forEach((c) => c.classList.add("selectable"));
    updateSelectBar();
    showToast("Clicca le persone da eliminare, poi «Elimina selezionate»", 5000);
  }
  function exitSelectMode() {
    selectMode = false; selected.clear();
    viewportEl.classList.remove("selecting");
    $("#btnSelect").classList.remove("active");
    $("#selectBar").hidden = true;
    cardsEl.querySelectorAll(".card").forEach((c) => {
      c.classList.remove("selectable", "selected");
      const chk = c.querySelector(".sel-check"); if (chk) chk.remove();
    });
  }
  function updateSelectBar() {
    const n = selected.size;
    $("#selectCount").textContent = n === 1 ? "1 selezionata" : `${n} selezionate`;
    $("#btnSelectDelete").disabled = n === 0;
  }
  function toggleSelect(id) {
    const el = cardsEl.querySelector(`.card[data-id="${id}"]`);
    if (selected.has(id)) {
      selected.delete(id);
      if (el) { el.classList.remove("selected"); const c = el.querySelector(".sel-check"); if (c) c.remove(); }
    } else {
      selected.add(id);
      if (el) {
        el.classList.add("selected");
        if (!el.querySelector(".sel-check")) { const c = document.createElement("span"); c.className = "sel-check"; c.textContent = "✓"; el.appendChild(c); }
      }
    }
    updateSelectBar();
  }
  function selectAllVisible() {
    if (!lastLayout) return;
    for (const id in lastLayout.pos) if (!selected.has(id)) toggleSelect(id);
    updateSelectBar();
  }
  function deleteSelected() {
    if (!selected.size) return;
    if (!ensureCanEdit()) return;
    const ids = [...selected];
    const names = ids.map((id) => fullName(findPerson(id) || {})).filter(Boolean);
    const preview = names.slice(0, 8).join(", ") + (names.length > 8 ? `, … (+${names.length - 8})` : "");
    if (!confirm(`Eliminare definitivamente ${ids.length} person${ids.length === 1 ? "a" : "e"}?\n\n${preview}\n\nL'operazione non è reversibile (fai prima un Backup se non sei sicuro).`)) return;
    const idset = new Set(ids);
    state.persons = state.persons.filter((p) => !idset.has(p.id));
    for (const f of state.families) {
      if (idset.has(f.husb)) f.husb = null;
      if (idset.has(f.wife)) f.wife = null;
      f.children = f.children.filter((c) => !idset.has(c));
    }
    state.families = state.families.filter((f) => f.husb || f.wife || f.children.length);
    save(`Eliminate ${ids.length} persone: ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}`);
    exitSelectMode();
    render();
    showToast(`${ids.length} persone eliminate ✓`);
  }

  // ============================================================ PERCORSO DI PARENTELA
  let pathMode = false, pathSel = [];
  function enterPathMode() {
    pathMode = true; pathSel = [];
    $("#btnPath").classList.add("active");
    showToast("Clicca due persone per vedere il loro legame di parentela", 6000);
  }
  function exitPathMode() {
    pathMode = false; pathSel = [];
    $("#btnPath").classList.remove("active");
    cardsEl.querySelectorAll(".card").forEach((c) => c.classList.remove("dim", "path-on", "path-sel"));
    const ov = linksEl.querySelector("#pathOverlay"); if (ov) ov.remove();
  }
  function selectForPath(id) {
    if (pathSel.includes(id)) return;
    pathSel.push(id);
    const el = cardsEl.querySelector(`.card[data-id="${id}"]`);
    if (el) el.classList.add("path-sel");
    if (pathSel.length === 2) showPath(pathSel[0], pathSel[1]);
  }
  function showPath(a, b) {
    const g = buildGraph();
    const visible = (id) => lastLayout && lastLayout.pos[id];
    const prev = { [a]: null };
    const q = [a];
    while (q.length && !(b in prev)) {
      const n = q.shift();
      for (const m of [...g.parent[n], ...g.child[n], ...g.spouse[n]]) {
        if (m in prev || !visible(m)) continue;
        prev[m] = n; q.push(m);
      }
    }
    if (!(b in prev)) { showToast("Nessun percorso visibile tra le due persone"); exitPathMode(); return; }
    const path = []; let cur = b;
    while (cur != null) { path.push(cur); cur = prev[cur]; }
    const inPath = new Set(path);
    cardsEl.querySelectorAll(".card").forEach((c) => c.classList.toggle("dim", !inPath.has(c.dataset.id)));
    path.forEach((id) => { const el = cardsEl.querySelector(`.card[data-id="${id}"]`); if (el) { el.classList.add("path-on"); el.classList.remove("path-sel"); } });
    const NS = "http://www.w3.org/2000/svg";
    const gEl = document.createElementNS(NS, "g");
    gEl.setAttribute("id", "pathOverlay");
    for (let i = 0; i + 1 < path.length; i++) {
      const p1 = lastLayout.pos[path[i]], p2 = lastLayout.pos[path[i + 1]];
      const l = document.createElementNS(NS, "line");
      l.setAttribute("x1", p1.x + CARD_W / 2); l.setAttribute("y1", p1.y + CARD_H / 2);
      l.setAttribute("x2", p2.x + CARD_W / 2); l.setAttribute("y2", p2.y + CARD_H / 2);
      l.setAttribute("class", "path-line");
      gEl.appendChild(l);
    }
    linksEl.appendChild(gEl);
    showToast(`Legame trovato: ${path.length - 1} passaggi · premi Esc per uscire`, 7000);
  }

  // ============================================================ ESPORTA PNG
  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function wrapText(ctx, text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (!cur || ctx.measureText(t).width <= maxW) cur = t;
      else { lines.push(cur); cur = w; if (lines.length === 2) break; }
    }
    if (lines.length < 2 && cur) lines.push(cur);
    return lines.slice(0, 2).map((ln) => {
      if (ctx.measureText(ln).width <= maxW) return ln;
      while (ln.length && ctx.measureText(ln + "…").width > maxW) ln = ln.slice(0, -1);
      return ln + "…";
    });
  }
  async function exportPNG(testOnly) {
    if (!lastLayout || !lastLayout.width) { alert("Niente da esportare."); return null; }
    const layout = lastLayout;
    const PAD = 50;
    const S = layout.width > 5000 ? 1.5 : 2;
    const W = Math.ceil((layout.width + PAD * 2) * S);
    const H = Math.ceil((layout.height + PAD * 2 + 24) * S);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#f2f5f7"; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.scale(S, S); ctx.translate(PAD, PAD);

    // connettori
    ctx.strokeStyle = "#9aa7b2"; ctx.lineWidth = 2; ctx.lineCap = "round";
    for (const s of layout.segs || []) { ctx.beginPath(); ctx.moveTo(s.x1, s.y1); ctx.lineTo(s.x2, s.y2); ctx.stroke(); }

    // pre-carica le foto
    const imgs = {};
    await Promise.all(state.persons.filter((p) => layout.pos[p.id] && p.photo).map((p) => new Promise((res) => {
      const im = new Image();
      im.onload = () => { imgs[p.id] = im; res(); };
      im.onerror = () => res();
      im.src = p.photo;
    })));

    const COLORS = { M: ["#36a9d6", "#f3fbfe"], F: ["#e98aa6", "#fef6f8"], U: ["#b8c2cc", "#f7f9fb"] };
    for (const p of state.persons) {
      const pp = layout.pos[p.id]; if (!pp) continue;
      const [bc, bg] = COLORS[p.sex === "M" || p.sex === "F" ? p.sex : "U"];
      roundRectPath(ctx, pp.x, pp.y, CARD_W, CARD_H, 10);
      ctx.fillStyle = bg; ctx.fill();
      ctx.strokeStyle = bc; ctx.lineWidth = 2; ctx.stroke();
      // avatar
      const ax = pp.x + 8 + 23, ay = pp.y + CARD_H / 2, ar = 21;
      ctx.save();
      ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.clip();
      if (imgs[p.id]) {
        const im = imgs[p.id];
        const k = Math.max((ar * 2) / im.width, (ar * 2) / im.height);
        ctx.drawImage(im, ax - (im.width * k) / 2, ay - (im.height * k) / 2, im.width * k, im.height * k);
      } else {
        ctx.fillStyle = p.sex === "M" ? "#e2f3fb" : p.sex === "F" ? "#fce8ee" : "#e8edf1";
        ctx.fillRect(ax - ar, ay - ar, ar * 2, ar * 2);
        ctx.font = "20px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText(p.sex === "F" ? "👩" : p.sex === "M" ? "👨" : "👤", ax, ay + 1);
      }
      ctx.restore();
      // testo
      const tx = pp.x + 8 + 46 + 8, maxW = CARD_W - (8 + 46 + 8) - 8;
      ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
      ctx.fillStyle = "#2c3e50"; ctx.font = "700 12px 'Segoe UI', sans-serif";
      const lines = wrapText(ctx, fullName(p), maxW);
      const d = formatDates(p);
      let ty = pp.y + (lines.length > 1 ? 24 : (d ? 28 : 36));
      for (const ln of lines) { ctx.fillText(ln, tx, ty); ty += 14; }
      if (d) { ctx.fillStyle = "#8795a1"; ctx.font = "10px 'Segoe UI', sans-serif"; ctx.fillText(d, tx, pp.y + CARD_H - 11); }
      if (!p.deceased && !p.death) {
        ctx.beginPath(); ctx.arc(pp.x + CARD_W - 11, pp.y + 11, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#46c07a"; ctx.fill();
        ctx.strokeStyle = "#fff"; ctx.lineWidth = 1.5; ctx.stroke();
      }
    }

    ctx.fillStyle = "#8795a1"; ctx.font = "12px 'Segoe UI', sans-serif"; ctx.textAlign = "left";
    ctx.fillText("Albero Genealogico Caroti Ghelli — " + new Date().toLocaleDateString("it-IT"), 0, layout.height + PAD - 4);
    ctx.restore();

    if (testOnly) return { w: W, h: H };
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "albero-genealogico.png";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      showToast("PNG scaricato ✓");
    }, "image/png");
    return null;
  }

  // La toolbar può andare su più righe (mobile): tieni l'albero subito sotto
  function fixViewportTop() {
    const tb = document.querySelector(".toolbar");
    if (tb) viewportEl.style.top = tb.offsetHeight + "px";
  }

  // ============================================================ EVENTI UI
  function bindUI() {
    $("#btnAdd").addEventListener("click", () => {
      if (!ensureCanEdit()) return;
      const p = createPerson({ first: "Nuova", last: "Persona" });
      save("Aggiunta una nuova persona"); render(); openEditor(p.id);
    });
    $("#editorClose").addEventListener("click", closeEditor);
    $("#overlay").addEventListener("click", closeEditor);
    $("#btnSave").addEventListener("click", () => saveCurrent(false));
    $("#btnDelete").addEventListener("click", () => {
      const p = findPerson(editingId);
      if (p && confirm(`Eliminare definitivamente "${fullName(p)}"?`)) { deletePerson(editingId); closeEditor(); }
    });
    $("#relAddPartner").addEventListener("click", () => { saveCurrent(true); addPartner(editingId); });
    $("#relAddChild").addEventListener("click", () => { saveCurrent(true); addChildTo(editingId); });
    $("#relAddParents").addEventListener("click", () => { saveCurrent(true); addParents(editingId); openEditor(editingId); });
    $("#photoInput").addEventListener("change", (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => { tempPhoto = await compressPhoto(reader.result); updatePhotoPreview(); };
      reader.readAsDataURL(file); e.target.value = "";
    });
    $("#photoRemove").addEventListener("click", () => { tempPhoto = null; updatePhotoPreview(); });
    $("#fileGedcom").addEventListener("change", (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => importGedcomText(reader.result);
      reader.readAsText(file, "UTF-8"); e.target.value = "";
    });
    $("#btnExportGed").addEventListener("click", () => {
      downloadFile("albero-genealogico.ged", window.GEDCOM.export(state), "text/plain;charset=utf-8");
    });
    $("#btnExportJson").addEventListener("click", () => {
      downloadFile("albero-backup.json", JSON.stringify({ state, seq }, null, 2), "application/json");
    });
    $("#fileJson").addEventListener("change", (e) => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        if (!ensureCanEdit()) return;
        try {
          const d = JSON.parse(reader.result);
          if (d.state && Array.isArray(d.state.persons)) { state = d.state; seq = d.seq || 20; save("Ripristinato da backup JSON"); render(); fitToScreen(); }
          else alert("File di backup non valido.");
        } catch { alert("Impossibile leggere il JSON."); }
      };
      reader.readAsText(file); e.target.value = "";
    });
    $("#btnZoomIn").addEventListener("click", () => zoomAt(viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, 1.15));
    $("#btnZoomOut").addEventListener("click", () => zoomAt(viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, 1 / 1.15));
    $("#btnZoomReset").addEventListener("click", fitToScreen);
    $("#btnReset").addEventListener("click", () => {
      if (!ensureCanEdit()) return;
      if (confirm("Cancellare tutto l'albero? Fai prima un Backup.")) {
        state = { persons: [], families: [] }; seq = 1; save("Svuotato l'intero albero"); render();
      }
    });

    // Nuove funzioni
    $("#btnStats").addEventListener("click", openStats);
    $("#btnHistory").addEventListener("click", openHistory);
    $("#btnPng").addEventListener("click", () => exportPNG());
    $("#btnPath").addEventListener("click", () => { if (pathMode) exitPathMode(); else enterPathMode(); });
    $("#btnSelect").addEventListener("click", () => { if (selectMode) exitSelectMode(); else enterSelectMode(); });
    $("#btnSelectCancel").addEventListener("click", exitSelectMode);
    $("#btnSelectDelete").addEventListener("click", deleteSelected);
    $("#btnSelectAllVisible").addEventListener("click", selectAllVisible);

    // Modalità di visualizzazione + minimappa
    document.querySelectorAll("#viewModes .vm").forEach((b) => b.addEventListener("click", () => setViewMode(b.dataset.mode)));
    $("#focusLabel").addEventListener("click", () => { if (viewState.focusId) centerOnPerson(viewState.focusId, true); });
    const mm = $("#minimapCanvas");
    if (mm) {
      let mmDrag = false;
      mm.addEventListener("mousedown", (e) => { mmDrag = true; minimapPan(e); });
      window.addEventListener("mousemove", (e) => { if (mmDrag) minimapPan(e); });
      window.addEventListener("mouseup", () => { mmDrag = false; });
    }
    $("#modalClose").addEventListener("click", closeModal);
    $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
    bindSearch();

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        if (!$("#modal").hidden) { closeModal(); return; }
        if (selectMode) { exitSelectMode(); return; }
        if (pathMode) { exitPathMode(); return; }
        if (!$("#editor").hidden) closeEditor();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !$("#editor").hidden) saveCurrent(false);
    });
    window.addEventListener("resize", () => { fixViewportTop(); applyTransform(); });
  }

  // ============================================================ AVVIO
  function init() {
    bindUI();
    setupPanZoom();
    loadView();
    loadLineage();
    loadViewState();
    fixViewportTop();
    startListening();
    window.__exportPNG = exportPNG; // usato solo per le verifiche automatiche
  }

  document.addEventListener("DOMContentLoaded", init);
})();
