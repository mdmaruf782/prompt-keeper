// Splits a bulk text into individual prompts. Returns [{ id, title, text }].
// mode: "auto" (#### boxes, --- lines, "Prompt N" headings, else one prompt),
//       "blank" (blank-line separated), "delim" (lines starting with `delim`), "single" (whole text).
function splitPrompts(raw, mode = "auto", delim = "") {
  const finish = (rs) =>
    rs.map((r) => ({ title: r.title, text: r.body.join("\n").trim() })).filter((r) => r.text)
      .map((r, i) => ({ id: i + 1, title: r.title, text: r.text }));
  const text = raw.replace(/\r\n?/g, "\n");
  if (mode === "single") return finish([{ title: "", body: [text] }]);
  if (mode === "blank") return finish(text.split(/\n\s*\n/).map((x) => ({ title: "", body: [x] })));
  if (mode === "delim") {
    const d = delim.trim().toLowerCase();
    if (!d) return [];
    const chunks = [];
    let c = null;
    for (const l of text.split("\n")) {
      if (l.trim().toLowerCase().startsWith(d)) {
        if (c) chunks.push(c);
        c = { title: /^[^\w]+$/.test(l.trim()) ? "" : l.trim(), body: [] };
      } else if (c) c.body.push(l);
    }
    if (c) chunks.push(c);
    return finish(chunks);
  }

  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const isBar = (l) => /^\s*#{5,}\s*$/.test(l);

  // Strategy 1: "#####" boxes with "# Title" lines inside, prompt follows the box.
  const items = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (isBar(lines[i])) {
      const header = [];
      let j = i + 1;
      while (j < lines.length && !isBar(lines[j])) {
        header.push(lines[j].replace(/^\s*#\s?/, "").trim());
        j++;
      }
      if (j >= lines.length) break;
      if (cur) items.push(cur);
      const title = header.find((h) => h && !/^\(.*\)$/.test(h)) || "";
      cur = { title, body: [] };
      i = j;
    } else if (cur) {
      cur.body.push(lines[i]);
    }
  }
  if (cur) items.push(cur);

  let result = items;

  // Strategy 2: separator lines (---, ===, ***) or "Prompt 1:" style headings.
  if (!result.length) {
    const sepRe = /^\s*([-=*_~]{3,})\s*$/;
    const headRe = /^\s*(?:#+\s*)?(?:prompt|episode|scene|part)\s*#?\d+\b.*$/i;
    const hasHeads = lines.some((l) => headRe.test(l));
    const chunks = [];
    let c = null;
    for (const l of lines) {
      if (hasHeads ? headRe.test(l) : sepRe.test(l)) {
        if (c) chunks.push(c);
        c = { title: hasHeads ? l.replace(/^\s*#+\s*/, "").trim() : "", body: [] };
        if (!hasHeads) continue;
      } else {
        if (!c) c = { title: "", body: [] };
        c.body.push(l);
      }
    }
    if (c) chunks.push(c);
    result = chunks;
  }

  // Nothing recognisable: treat everything as one prompt.
  if (!result.length) result = [{ title: "", body: [text] }];
  return finish(result);
}

if (typeof module !== "undefined") module.exports = { splitPrompts };
