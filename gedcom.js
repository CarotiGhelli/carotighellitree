/* gedcom.js — Parser ed esportatore GEDCOM 5.5.1 (sottoinsieme comune).
 * Espone window.GEDCOM con parse(text) -> {persons, families} ed export(data) -> string.
 */
(function () {
  "use strict";

  // ---- Parsing di basso livello: riga GEDCOM "level [xref] tag [value]" ----
  function tokenizeLine(line) {
    // es: "1 NAME Carlo /Caroti Ghelli/"  oppure  "0 @I1@ INDI"
    const m = line.match(/^\s*(\d+)\s+(@[^@]+@\s+)?(\S+)(?:\s(.*))?$/);
    if (!m) return null;
    return {
      level: parseInt(m[1], 10),
      xref: m[2] ? m[2].trim() : null,
      tag: m[3].toUpperCase(),
      value: m[4] != null ? m[4] : "",
    };
  }

  // Costruisce un albero di nodi annidati a partire dalle righe
  function buildRecords(text) {
    const lines = text.split(/\r\n|\r|\n/);
    const root = { level: -1, children: [] };
    const stack = [root];

    for (const raw of lines) {
      if (!raw.trim()) continue;
      const tok = tokenizeLine(raw);
      if (!tok) continue;
      const node = { tag: tok.tag, xref: tok.xref, value: tok.value, children: [] };
      // gestione CONT/CONC (testo su più righe)
      while (stack.length && stack[stack.length - 1]._level >= tok.level) stack.pop();
      const parent = stack[stack.length - 1] === root ? root : stack[stack.length - 1];
      node._level = tok.level;

      if (tok.tag === "CONT" && parent !== root) {
        parent.value = (parent.value || "") + "\n" + tok.value;
        continue;
      }
      if (tok.tag === "CONC" && parent !== root) {
        parent.value = (parent.value || "") + tok.value;
        continue;
      }
      parent.children.push(node);
      stack.push(node);
    }
    return root.children;
  }

  function child(node, tag) {
    return node.children.find((c) => c.tag === tag);
  }
  function childVal(node, tag) {
    const c = child(node, tag);
    return c ? c.value.trim() : "";
  }

  function parseName(node) {
    // NAME può avere il cognome tra slash: "Mario /Rossi/"
    const c = child(node, "NAME");
    let first = "", last = "";
    if (c) {
      const v = c.value || "";
      const slash = v.match(/\/([^/]*)\//);
      if (slash) {
        last = slash[1].trim();
        first = v.replace(/\/[^/]*\//, "").replace(/\s+/g, " ").trim();
      } else {
        first = v.trim();
      }
      // forme strutturate GIVN/SURN se presenti
      const givn = childVal(c, "GIVN");
      const surn = childVal(c, "SURN");
      if (givn) first = givn;
      if (surn) last = surn;
    }
    return { first, last };
  }

  function parseEvent(node, tag) {
    const ev = child(node, tag);
    if (!ev) return { date: "", place: "" };
    return { date: childVal(ev, "DATE"), place: childVal(ev, "PLAC") };
  }

  function parse(text) {
    const records = buildRecords(text);
    const persons = [];
    const families = [];

    for (const rec of records) {
      if (rec.tag === "INDI") {
        const name = parseName(rec);
        const birt = parseEvent(rec, "BIRT");
        const deat = parseEvent(rec, "DEAT");
        let sex = childVal(rec, "SEX").toUpperCase();
        if (sex !== "M" && sex !== "F") sex = "U";
        const notes = rec.children.filter((c) => c.tag === "NOTE").map((c) => c.value).join("\n");
        persons.push({
          id: (rec.xref || "").replace(/@/g, "") || ("I" + (persons.length + 1)),
          first: name.first,
          last: name.last,
          sex,
          birth: birt.date,
          birthPlace: birt.place,
          death: deat.date,
          deathPlace: deat.place,
          deceased: !!(deat.date || deat.place || child(rec, "DEAT")),
          notes,
          photo: "",
        });
      } else if (rec.tag === "FAM") {
        const husb = childVal(rec, "HUSB").replace(/@/g, "");
        const wife = childVal(rec, "WIFE").replace(/@/g, "");
        const children = rec.children
          .filter((c) => c.tag === "CHIL")
          .map((c) => c.value.replace(/@/g, "").trim());
        families.push({
          id: (rec.xref || "").replace(/@/g, "") || ("F" + (families.length + 1)),
          husb: husb || null,
          wife: wife || null,
          children,
        });
      }
    }
    return { persons, families };
  }

  // ---------------- Export ----------------
  function esc(v) { return (v == null ? "" : String(v)); }

  function exportGedcom(data) {
    const out = [];
    out.push("0 HEAD");
    out.push("1 SOUR AlberoGenealogicoWeb");
    out.push("2 NAME Albero Genealogico");
    out.push("1 GEDC");
    out.push("2 VERS 5.5.1");
    out.push("2 FORM LINEAGE-LINKED");
    out.push("1 CHAR UTF-8");

    for (const p of data.persons) {
      out.push(`0 @${p.id}@ INDI`);
      const nameLine = `${esc(p.first)} /${esc(p.last)}/`.trim();
      out.push(`1 NAME ${nameLine}`);
      if (p.first) out.push(`2 GIVN ${esc(p.first)}`);
      if (p.last) out.push(`2 SURN ${esc(p.last)}`);
      out.push(`1 SEX ${p.sex === "F" ? "F" : p.sex === "M" ? "M" : "U"}`);
      if (p.birth || p.birthPlace) {
        out.push("1 BIRT");
        if (p.birth) out.push(`2 DATE ${esc(p.birth)}`);
        if (p.birthPlace) out.push(`2 PLAC ${esc(p.birthPlace)}`);
      }
      if (p.death || p.deathPlace || p.deceased) {
        out.push("1 DEAT" + (p.death || p.deathPlace ? "" : " Y"));
        if (p.death) out.push(`2 DATE ${esc(p.death)}`);
        if (p.deathPlace) out.push(`2 PLAC ${esc(p.deathPlace)}`);
      }
      if (p.notes) {
        const noteLines = String(p.notes).split("\n");
        out.push(`1 NOTE ${noteLines[0]}`);
        for (let i = 1; i < noteLines.length; i++) out.push(`2 CONT ${noteLines[i]}`);
      }
    }

    for (const f of data.families) {
      out.push(`0 @${f.id}@ FAM`);
      if (f.husb) out.push(`1 HUSB @${f.husb}@`);
      if (f.wife) out.push(`1 WIFE @${f.wife}@`);
      for (const c of f.children) out.push(`1 CHIL @${c}@`);
    }

    out.push("0 TRLR");
    return out.join("\n");
  }

  window.GEDCOM = { parse, export: exportGedcom };
})();
