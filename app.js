/* app.js — Albero Genealogico con Firebase Firestore + Google Auth
 * Dati dell'albero: Firestore (sync real-time su tutti i dispositivi)
 * Stato viewport (zoom/pan): localStorage (preferenza locale per dispositivo)
 */
(function () {
  "use strict";

  // ============================================================ STATO
  const VIEW_KEY = "albero-view-v1";
  let state = { persons: [], families: [] };
  let seq = 1;
  const view = { scale: 1, x: 40, y: 40 };
  let editingId = null;
  let currentUser = null;
  let unsubscribeSnapshot = null;
  let saveTimer = null;
  let tempPhoto = null;

  // Costanti di layout
  const CARD_W = 160, CARD_H = 64;
  const H_GAP = 26, COUPLE_GAP = 26, V_GAP = 116, TREE_GAP = 80;

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

  function showToast(msg, ms = 3500) {
    const el = $("#syncStatus");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  // ============================================================ PERSISTENZA
  function saveView() {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); } catch (_) {}
  }
  function loadView() {
    try { const v = JSON.parse(localStorage.getItem(VIEW_KEY) || "null"); if (v) Object.assign(view, v); } catch (_) {}
  }

  function save() {
    if (!currentUser || !window.db) return;
    clearTimeout(saveTimer);
    showToast("Salvando…", 60000);
    saveTimer = setTimeout(() => {
      window.db.collection("trees").doc("main").set({
        persons: state.persons,
        families: state.families,
        seq,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: currentUser.displayName || currentUser.email || "Utente",
        updatedByPhoto: currentUser.photoURL || "",
      })
        .then(() => showToast("Salvato ✓"))
        .catch((e) => { console.warn("Firestore save failed", e); showToast("Errore salvataggio"); });
    }, 1200);
  }

  function startListening() {
    if (unsubscribeSnapshot) unsubscribeSnapshot();
    unsubscribeSnapshot = window.db.collection("trees").doc("main").onSnapshot(
      (snap) => {
        if (!snap.exists) {
          // Prima volta: seed dati di esempio
          seedData(); save(); render(); fitToScreen();
          return;
        }
        const data = snap.data();
        if (!data) return;
        state = { persons: data.persons || [], families: data.families || [] };
        seq = data.seq || 1;
        render();
        const myName = currentUser ? (currentUser.displayName || currentUser.email || "") : "";
        if (data.updatedBy && data.updatedBy !== myName) {
          showToast(`Aggiornato da ${data.updatedBy}`);
        }
      },
      (err) => {
        console.warn("Firestore listener error", err);
        showToast("Errore connessione al database");
      }
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

  // ============================================================ LAYOUT
  function computeLayout() {
    const pos = {};
    const node = {};
    const visited = new Set();

    function measure(id) {
      if (node[id]) return node[id].width;
      if (visited.has(id)) return 0;
      visited.add(id);

      const fam = familiesAsSpouse(id)[0] || null;
      let spouseId = fam ? partnerOf(fam.id, id) : null;
      if (spouseId && visited.has(spouseId)) spouseId = null;
      if (spouseId) visited.add(spouseId);

      const ownChildren = fam ? fam.children.filter((c) => !visited.has(c)) : [];
      const childWidths = ownChildren.map(measure);
      let childrenTotal = childWidths.reduce((a, b) => a + b, 0);
      if (ownChildren.length > 1) childrenTotal += H_GAP * (ownChildren.length - 1);

      const coupleW = spouseId ? CARD_W * 2 + COUPLE_GAP : CARD_W;
      const width = Math.max(coupleW, childrenTotal, CARD_W);
      node[id] = { id, fam, spouseId, ownChildren, childWidths, childrenTotal, coupleW, width };
      return width;
    }

    function place(id, left, top) {
      const n = node[id];
      if (!n || pos[id]) return;
      const childTop = top + V_GAP;
      let cx = left + (n.width - n.childrenTotal) / 2;
      n.ownChildren.forEach((c, i) => { place(c, cx, childTop); cx += n.childWidths[i] + H_GAP; });
      const coupleLeft = left + (n.width - n.coupleW) / 2;
      pos[id] = { x: coupleLeft, y: top };
      if (n.spouseId && !pos[n.spouseId]) pos[n.spouseId] = { x: coupleLeft + CARD_W + COUPLE_GAP, y: top };
    }

    function reachSize(id, seen) {
      if (seen.has(id)) return 0; seen.add(id); let s = 1;
      const fam = familiesAsSpouse(id)[0];
      if (fam) for (const c of fam.children) s += reachSize(c, seen);
      return s;
    }

    const isChild = new Set();
    state.families.forEach((f) => f.children.forEach((c) => isChild.add(c)));
    const founders = state.persons
      .filter((p) => !isChild.has(p.id))
      .sort((a, b) => reachSize(b.id, new Set()) - reachSize(a.id, new Set()));

    let offsetX = 0;
    for (const f of founders) {
      if (pos[f.id] || visited.has(f.id)) continue;
      const fam = familiesAsSpouse(f.id)[0];
      if (fam && fam.children.some((c) => pos[c])) continue;
      measure(f.id); place(f.id, offsetX, 0);
      offsetX += node[f.id].width + TREE_GAP;
    }

    // Antenati acquisiti (posizionati sopra i figli già piazzati)
    let guard = 0, changed = true;
    while (changed && guard++ < 200) {
      changed = false;
      for (const p of state.persons) {
        if (!pos[p.id]) continue;
        const fam = familyAsChild(p.id);
        if (!fam) continue;
        const parents = [fam.husb, fam.wife].filter(Boolean);
        if (!parents.length || parents.every((x) => pos[x])) continue;
        const placedKids = fam.children.filter((c) => pos[c]);
        if (!placedKids.length) continue;
        const kidY = Math.min(...placedKids.map((c) => pos[c].y));
        const centerX = placedKids.reduce((a, c) => a + pos[c].x + CARD_W / 2, 0) / placedKids.length;
        const coupleW = parents.length > 1 ? CARD_W * 2 + COUPLE_GAP : CARD_W;
        const left = centerX - coupleW / 2;
        const y = kidY - V_GAP;
        parents.forEach((pid, i) => { if (!pos[pid]) pos[pid] = { x: left + i * (CARD_W + COUPLE_GAP), y }; });
        const unplaced = fam.children.filter((c) => !pos[c]);
        let kx = Math.max(...placedKids.map((c) => pos[c].x)) + CARD_W + H_GAP;
        for (const c of unplaced) { measure(c); place(c, kx, kidY); kx += (node[c] ? node[c].width : CARD_W) + H_GAP; }
        changed = true;
      }
    }

    for (const p of state.persons) {
      if (!pos[p.id]) { measure(p.id); place(p.id, offsetX, 0); offsetX += (node[p.id] ? node[p.id].width : CARD_W) + TREE_GAP; }
    }

    // De-sovrapposizione per riga
    const rows = {};
    for (const id in pos) { const key = Math.round(pos[id].y); (rows[key] = rows[key] || []).push(id); }
    for (const key in rows) {
      const ids = rows[key].sort((a, b) => pos[a].x - pos[b].x);
      let prevRight = -Infinity;
      for (const id of ids) { if (pos[id].x < prevRight + 14) pos[id].x = prevRight + 14; prevRight = pos[id].x + CARD_W; }
    }

    // Normalizza origine
    let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
    for (const id in pos) { minX = Math.min(minX, pos[id].x); minY = Math.min(minY, pos[id].y); }
    if (!isFinite(minX)) { minX = 0; minY = 0; }
    for (const id in pos) { pos[id].x -= minX; pos[id].y -= minY; }
    for (const id in pos) { maxX = Math.max(maxX, pos[id].x + CARD_W); maxY = Math.max(maxY, pos[id].y + CARD_H); }

    // Connettori SVG
    const segs = [];
    for (const fam of state.families) {
      const parents = [fam.husb, fam.wife].filter((x) => x && pos[x]);
      const kids = fam.children.filter((c) => pos[c]);
      if (!parents.length) continue;
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
    view.scale = Math.min(Math.max(0.2, Math.min(vw / (w + 80), vh / (h + 80), 1.4)));
    view.x = (vw - w * view.scale) / 2; view.y = 30;
    applyTransform(); saveView();
  }

  // ============================================================ EDITOR
  function openEditor(id) {
    const p = findPerson(id);
    if (!p) return;
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

  // ============================================================ AUTH
  function initAuth() {
    if (!window.auth) {
      // Firebase non ancora configurato — modalità offline con localStorage
      console.warn("Firebase non configurato. Funzionamento offline.");
      runOffline(); return;
    }

    $("#btnGoogleLogin").addEventListener("click", () => {
      window.auth.signInWithPopup(window.googleProvider).catch((err) => {
        console.error("Login failed", err);
        const errEl = $("#loginError");
        if (err.code === "auth/popup-blocked") {
          window.auth.signInWithRedirect(window.googleProvider);
        } else {
          errEl.textContent = "Accesso non riuscito: " + (err.message || err.code);
          errEl.hidden = false;
        }
      });
    });

    $("#btnLogout").addEventListener("click", () => {
      if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
      window.auth.signOut();
    });

    window.auth.getRedirectResult().catch((err) => console.warn("Redirect result error", err));

    window.auth.onAuthStateChanged((user) => {
      currentUser = user;
      if (user) {
        $("#loginScreen").hidden = true;
        $("#appHeader").hidden = false;
        $("#viewport").hidden = false;
        const badge = $("#userBadge"); badge.hidden = false;
        $("#userName").textContent = user.displayName || user.email || "Utente";
        if (user.photoURL) { $("#userAvatar").src = user.photoURL; $("#userAvatar").hidden = false; }
        else { $("#userAvatar").hidden = true; }
        loadView(); startListening();
      } else {
        if (unsubscribeSnapshot) { unsubscribeSnapshot(); unsubscribeSnapshot = null; }
        $("#loginScreen").hidden = false;
        $("#appHeader").hidden = true;
        $("#viewport").hidden = true;
        $("#userBadge").hidden = true;
      }
    });
  }

  // Modalità offline (Firebase non configurato): usa localStorage
  function runOffline() {
    const LS_KEY = "albero-genealogico-v1";
    save = function () {
      try { localStorage.setItem(LS_KEY, JSON.stringify({ state, seq })); showToast("Salvato ✓"); } catch (_) {}
    };
    const raw = localStorage.getItem(LS_KEY);
    if (raw) { try { const d = JSON.parse(raw); state = d.state; seq = d.seq || 1; } catch (_) { seedData(); } }
    else { seedData(); save(); }
    $("#loginScreen").hidden = true;
    $("#appHeader").hidden = false;
    $("#viewport").hidden = false;
    loadView(); render(); fitToScreen();
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
    initAuth();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
