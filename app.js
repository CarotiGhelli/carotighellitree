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

  // ============================================================ PERSISTENZA
  function saveView() { try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (_) {} }
  function loadView() { try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null"); if (v) Object.assign(view, v); } catch (_) {} }

  function save() {
    if (!window.db) return;
    clearTimeout(saveTimer);
    showToast("Salvando…", 60000);
    saveTimer = setTimeout(() => {
      window.db.collection("trees").doc("main").set({
        persons: state.persons,
        families: state.families,
        seq,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      })
        .then(() => showToast("Salvato ✓"))
        .catch((e) => { console.warn("Firestore save failed", e); showToast("Errore salvataggio"); });
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
          if (!seededOnce) { seededOnce = true; seedData(); save(); render(); fitToScreen(); }
          return;
        }
        const data = snap.data();
        if (!data) return;
        // Aggiorna lo stato solo se non c'è un salvataggio pendente (evita flickering)
        if (!saveTimer) {
          state = { persons: data.persons || [], families: data.families || [] };
          seq = data.seq || 1;
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

  // ============================================================ LAYOUT (a livelli, stile Sugiyama)
  function computeLayout() {
    const persons = state.persons, families = state.families;
    if (!persons.length) return { pos: {}, linksSvg: "", width: 0, height: 0 };

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
      for (const id of rows[g]) {
        if (used.has(id)) continue;
        const sp = spouseMap[id].find((s) => gen[s] === g && !used.has(s));
        let members;
        if (sp) {
          members = (byId[id].sex === "F" && byId[sp].sex !== "F") ? [sp, id] : [id, sp];
          used.add(id); used.add(sp);
        } else { members = [id]; used.add(id); }
        // Membro "primario" = linea di sangue dominante (chi ha più fratelli
        // nell'albero). Ancorando l'unità ai SUOI genitori, i fratelli restano
        // vicini invece di essere trascinati via dalla famiglia del coniuge.
        const birthSize = (idm) => (childFam[idm] ? childFam[idm].children.filter((c) => byId[c]).length : 0);
        let primary = members[0];
        if (members.length === 2 && birthSize(members[1]) > birthSize(members[0])) primary = members[1];
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
    const unitWidth = (u) => (u.members.length === 2 ? CARD_W * 2 + COUPLE_GAP : CARD_W);
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

    // In una coppia, metti ogni membro dal lato dei propri genitori: evita che i
    // due connettori verso le rispettive famiglie si incrocino.
    const parentCenterX = (m) => {
      const a = [];
      for (const p of parentMap[m]) if (pos[p] && gen[p] === gen[m] - 1) a.push(pos[p].x + CARD_W / 2);
      return a.length ? avg(a) : null;
    };
    for (let g = 0; g <= maxGen; g++) for (const u of rowUnits[g]) {
      if (u.members.length !== 2) continue;
      const [a, b] = u.members;
      const pa = parentCenterX(a), pb = parentCenterX(b);
      if (pa == null || pb == null) continue;
      const aLeft = pos[a].x < pos[b].x;
      const leftP = aLeft ? pa : pb, rightP = aLeft ? pb : pa;
      if (leftP > rightP + 1) { const t = pos[a].x; pos[a].x = pos[b].x; pos[b].x = t; }
    }

    // Normalizza origine
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    for (const id in pos) { minX = Math.min(minX, pos[id].x); minY = Math.min(minY, pos[id].y); }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    for (const id in pos) { pos[id].x -= minX; pos[id].y -= minY; }
    for (const id in pos) { maxX = Math.max(maxX, pos[id].x + CARD_W); maxY = Math.max(maxY, pos[id].y + CARD_H); }

    // --- Connettori SVG ---
    const segs = [];
    for (const fam of families) {
      const parents = [fam.husb, fam.wife].filter((x) => x && pos[x]);
      const kids = fam.children.filter((c) => pos[c]);
      if (!parents.length || !kids.length && parents.length < 2) continue;
      let midX, bottomY;
      if (parents.length === 2 && Math.abs(pos[parents[0]].y - pos[parents[1]].y) < 4) {
        const a = pos[parents[0]], b = pos[parents[1]];
        const lp = a.x < b.x ? a : b, rp = a.x < b.x ? b : a;
        segs.push({ x1: lp.x + CARD_W, y1: lp.y + CARD_H / 2, x2: rp.x, y2: rp.y + CARD_H / 2 });
        midX = (lp.x + CARD_W + rp.x) / 2; bottomY = lp.y + CARD_H;
      } else {
        midX = pos[parents[0]].x + CARD_W / 2; bottomY = pos[parents[0]].y + CARD_H;
      }
      for (const c of kids) {
        const cx = pos[c].x + CARD_W / 2, cy = pos[c].y, busY = (bottomY + cy) / 2;
        segs.push({ x1: midX, y1: bottomY, x2: midX, y2: busY });
        segs.push({ x1: midX, y1: busY, x2: cx, y2: busY });
        segs.push({ x1: cx, y1: busY, x2: cx, y2: cy });
      }
    }
    const linksSvg = segs.map((s) =>
      `<line x1="${s.x1.toFixed(1)}" y1="${s.y1.toFixed(1)}" x2="${s.x2.toFixed(1)}" y2="${s.y2.toFixed(1)}" stroke="#9aa7b2" stroke-width="2" stroke-linecap="round"/>`
    ).join("");

    return { pos, linksSvg, width: maxX, height: maxY };
  }

  // ============================================================ RENDER
  let lastLayout = null;

  function render() {
    cardsEl.innerHTML = "";
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
  }

  function buildCard(p, pos) {
    const el = document.createElement("div");
    el.className = "card " + (p.sex === "M" ? "male" : p.sex === "F" ? "female" : "unknown");
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
      <span class="edit-pencil">✎</span>`;
    el.addEventListener("click", (e) => { e.stopPropagation(); openEditor(p.id); });
    const add = document.createElement("div");
    add.className = "add-btn"; add.textContent = "+"; add.title = "Aggiungi figlio/a";
    add.style.left = (pos.x + CARD_W / 2 - 11) + "px";
    add.style.top = (pos.y + CARD_H - 4) + "px";
    add.addEventListener("click", (e) => { e.stopPropagation(); addChildTo(p.id); });
    cardsEl.appendChild(add);
    return el;
  }

  function formatDates(p) {
    const b = p.birth || "", d = p.death || "";
    if (!b && !d) return p.birthPlace || "";
    if (b && d) return `${shortYear(b)} – ${shortYear(d)}`;
    if (b) return `n. ${shortYear(b)}`;
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
  }

  function zoomAt(mx, my, factor) {
    const ns = Math.min(2.5, Math.max(0.2, view.scale * factor));
    const k = ns / view.scale;
    view.x = mx - (mx - view.x) * k; view.y = my - (my - view.y) * k; view.scale = ns;
    applyTransform(); saveView();
  }

  function fitToScreen() {
    if (!lastLayout) return;
    const vw = viewportEl.clientWidth, vh = viewportEl.clientHeight;
    const w = lastLayout.width || 1, h = lastLayout.height || 1;
    view.scale = Math.max(0.2, Math.min(vw / (w + 80), vh / (h + 80), 1.4));
    view.x = (vw - w * view.scale) / 2; view.y = 30;
    applyTransform(); saveView();
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
    p.first = $("#fFirst").value.trim(); p.last = $("#fLast").value.trim();
    p.sex = $("#fSex").value;
    p.birth = $("#fBirth").value.trim(); p.birthPlace = $("#fBirthPlace").value.trim();
    p.death = $("#fDeath").value.trim(); p.deathPlace = $("#fDeathPlace").value.trim();
    p.deceased = !!(p.death || p.deathPlace);
    p.notes = $("#fNotes").value; p.photo = tempPhoto || "";
    save(); render();
    if (!silent) closeEditor();
  }

  // ============================================================ OPERAZIONI RELAZIONALI
  function createPerson(opts) {
    const p = Object.assign({ id: newId("I"), first: "Nuova", last: "Persona", sex: "U", birth: "", birthPlace: "", death: "", deathPlace: "", deceased: false, notes: "", photo: "" }, opts || {});
    if (!opts || !opts.id) p.id = newId("I");
    state.persons.push(p); return p;
  }

  function addChildTo(parentId) {
    let fam = familiesAsSpouse(parentId)[0];
    if (!fam) {
      fam = { id: newId("F"), husb: null, wife: null, children: [] };
      const parent = findPerson(parentId);
      if (parent && parent.sex === "F") fam.wife = parentId; else fam.husb = parentId;
      state.families.push(fam);
    }
    const child = createPerson({ last: (findPerson(parentId) || {}).last || "" });
    fam.children.push(child.id); save(); render(); openEditor(child.id);
  }

  function addPartner(personId) {
    const person = findPerson(personId);
    let fam = familiesAsSpouse(personId)[0];
    if (!fam) { fam = { id: newId("F"), husb: null, wife: null, children: [] }; state.families.push(fam); }
    const partnerSex = person.sex === "F" ? "M" : person.sex === "M" ? "F" : "U";
    const partner = createPerson({ first: "Coniuge", last: "", sex: partnerSex });
    if (person.sex === "F") { fam.wife = personId; fam.husb = partner.id; }
    else { fam.husb = personId; fam.wife = partner.id; }
    save(); render(); openEditor(partner.id);
  }

  function addParents(personId) {
    let fam = familyAsChild(personId);
    if (!fam) { fam = { id: newId("F"), husb: null, wife: null, children: [personId] }; state.families.push(fam); }
    if (!fam.husb) { const f = createPerson({ first: "Padre", last: (findPerson(personId) || {}).last || "", sex: "M" }); fam.husb = f.id; }
    if (!fam.wife) { const m = createPerson({ first: "Madre", last: "", sex: "F" }); fam.wife = m.id; }
    save(); render();
  }

  function removeChildFromFamily(famId, childId) {
    const f = findFamily(famId); if (!f) return;
    f.children = f.children.filter((c) => c !== childId); cleanupFamily(famId); save(); render();
  }

  function unlinkSpouse(famId, personId) {
    const f = findFamily(famId); if (!f) return;
    if (f.husb === personId) f.husb = null; else if (f.wife === personId) f.wife = null;
    cleanupFamily(famId); save(); render();
  }

  function cleanupFamily(famId) {
    const f = findFamily(famId); if (!f) return;
    if (!f.husb && !f.wife && !f.children.length) state.families = state.families.filter((x) => x.id !== famId);
  }

  function deletePerson(id) {
    state.persons = state.persons.filter((p) => p.id !== id);
    for (const f of state.families) {
      if (f.husb === id) f.husb = null; if (f.wife === id) f.wife = null;
      f.children = f.children.filter((c) => c !== id);
    }
    state.families = state.families.filter((f) => f.husb || f.wife || f.children.length);
    save(); render();
  }

  // ============================================================ IMPORT / EXPORT
  function importGedcomText(text) {
    const data = window.GEDCOM.parse(text);
    if (!data.persons.length) { alert("Nessuna persona trovata nel file GEDCOM."); return; }
    state = data; seq = 1;
    state.persons.forEach((p) => bumpSeq(p.id)); state.families.forEach((f) => bumpSeq(f.id));
    save(); render(); fitToScreen();
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

  // ============================================================ EVENTI UI
  function bindUI() {
    $("#btnAdd").addEventListener("click", () => { const p = createPerson({ first: "Nuova", last: "Persona" }); save(); render(); openEditor(p.id); });
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
        try {
          const d = JSON.parse(reader.result);
          if (d.state && Array.isArray(d.state.persons)) { state = d.state; seq = d.seq || 20; save(); render(); fitToScreen(); }
          else alert("File di backup non valido.");
        } catch { alert("Impossibile leggere il JSON."); }
      };
      reader.readAsText(file); e.target.value = "";
    });
    $("#btnZoomIn").addEventListener("click", () => zoomAt(viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, 1.15));
    $("#btnZoomOut").addEventListener("click", () => zoomAt(viewportEl.clientWidth / 2, viewportEl.clientHeight / 2, 1 / 1.15));
    $("#btnZoomReset").addEventListener("click", fitToScreen);
    $("#btnReset").addEventListener("click", () => {
      if (confirm("Cancellare tutto l'albero? Fai prima un Backup.")) {
        state = { persons: [], families: [] }; seq = 1; save(); render();
      }
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !$("#editor").hidden) closeEditor();
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !$("#editor").hidden) saveCurrent(false);
    });
    window.addEventListener("resize", applyTransform);
  }

  // ============================================================ AVVIO
  function init() {
    bindUI();
    setupPanZoom();
    loadView();
    startListening();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
