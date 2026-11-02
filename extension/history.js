// Runs on axcel.cloud pages (isolated world).
// On the History list it labels each card with Project > Category > serial, adds a "Download list" button,
// and reports cards whose generation failed so the prompt can be marked as failed.
(() => {
  const normText = (t) => t.replace(/[\s"'“”‘’]+/g, "");
  const JOB_RE = /job_[0-9a-f]{8,}/i;

  function buildIndex(state) {
    const idx = new Map();
    for (const pr of state?.projects || [])
      for (const cat of pr.categories)
        for (const p of cat.prompts) {
          const k = normText(p.text);
          if (!idx.has(k)) idx.set(k, []);
          idx.get(k).push({ pr, cat, p });
        }
    return idx;
  }
  // Same prompt text in several places: prefer the active project.
  const findMatch = (idx, text, activeId) => {
    const hits = idx.get(normText(text));
    return hits ? hits.find((h) => h.pr.id === activeId) || hits[0] : null;
  };
  const serialOf = (cat, p) => String(p.id).padStart(Math.max(2, String(cat.prompts.length).length), "0");

  // For a result whose prompt is not in the lists: serial from "EPISODE 30" in its text (only at the start of the
  // text: the rest of a long prompt may mention other episodes), and a short title.
  function unmatchedInfo(text) {
    // Only when the episode label opens the prompt ("CREATE EPISODE 30: ..." / "EPISODE 30 — ..."), not a mention further in.
    const m = text.match(/^\s*(?:[A-Za-z]+\s+){0,3}EPISODE\s*0*(\d+)\b\s*[:—–-]?\s*([^.,;(]{0,50})/i);
    if (!m) return { serial: null, title: text.slice(0, 60).trim() };
    return { serial: Number(m[1]), title: `EPISODE ${m[1]}${m[2].trim() ? " — " + m[2].trim() : ""}` };
  }

  // A card's prompt <p> sits next to the model-name <p translate="no">. The failure message of a failed card
  // is also a clamped <p>, but it has no such sibling, so it is not mistaken for a prompt.
  const isPromptP = (p) => !!(p.parentElement && p.parentElement.querySelector(':scope > p[translate="no"]'));
  // The whole card: climb while the parent still contains only this card's model-name <p>.
  function cardRoot(block) {
    let el = block;
    while (el.parentElement && el.parentElement.querySelectorAll('p[translate="no"]').length === 1) el = el.parentElement;
    return el;
  }
  // A failed card shows a leaf element reading exactly "Failed", with the reason next to it.
  function failInfo(card) {
    for (const el of card.querySelectorAll("*")) {
      if (el.children.length === 0 && el.textContent.trim() === "Failed") {
        const reason = (el.parentElement ? el.parentElement.textContent : "").replace("Failed", "").replace(/\s+/g, " ").trim();
        return { failed: true, reason: reason.slice(0, 200) };
      }
    }
    return { failed: false, reason: "" };
  }

  if (typeof module !== "undefined") module.exports = { normText, buildIndex, findMatch, serialOf, isPromptP, cardRoot, failInfo, unmatchedInfo };
  if (typeof document === "undefined" || typeof chrome === "undefined" || !chrome.storage) return;

  let data = { state: null, jobMap: {}, dlList: [], genFailed: {}, target: null, idx: new Map() };
  let timer = null;
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  const style = document.createElement("style");
  style.textContent = `
    .ps-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:8px}
    .ps-badge{font:600 12px system-ui,sans-serif;background:#1a7f37;color:#fff;padding:4px 9px;border-radius:12px}
    .ps-badge.gray{background:#8c959f}
    .ps-badge.red{background:#cf222e}
    .ps-add{flex:1 1 100%;font:700 14px system-ui,sans-serif;border:2px solid #1a7f37;color:#1a7f37;background:transparent;padding:9px 14px;border-radius:10px;cursor:pointer;text-align:center}
    .ps-add:hover{background:rgba(26,127,55,.12)}
    .ps-add.on{background:#1a7f37;color:#fff}
    .ps-add:disabled{opacity:.5;cursor:default}`;
  document.documentElement.appendChild(style);

  function paint() {
    if (!data.state) return;
    const cards = [];
    for (const p of document.querySelectorAll('p[class*="line-clamp"]')) {
      const text = p.textContent.trim();
      if (text.length < 20 || !isPromptP(p)) continue;
      const block = p.parentElement;
      const card = cardRoot(block);
      const m = findMatch(data.idx, text, data.state.active);
      const link = p.closest("a");
      let jobId = (((link && link.href) || "") + " " + (card.outerHTML.length < 20000 ? card.outerHTML : block.outerHTML)).match(JOB_RE)?.[0] || "";
      if (!jobId && m) jobId = data.jobMap[`${m.cat.id}:${m.p.id}`]?.jobId || "";
      cards.push({ block, m, jobId, text, key: m ? `${m.cat.id}:${m.p.id}` : "", ...failInfo(card) });
    }

    // Report generation failures (only for prompts that have no good result), and clear marks once one succeeds.
    const okKeys = new Set(cards.filter((c) => c.key && !c.failed).map((c) => c.key));
    const fail = cards
      .filter((c) => c.key && c.failed && !okKeys.has(c.key) && data.genFailed[c.key]?.jobId !== c.jobId)
      .map((c) => ({ key: c.key, jobId: c.jobId, reason: c.reason }));
    const clear = [...okKeys].filter((k) => data.genFailed[k]);
    if (fail.length || clear.length) {
      try { chrome.runtime.sendMessage({ type: "genfailed", fail, clear }); } catch {}
    }

    // Category chosen in the Download tab for results whose prompt is not in the lists.
    const tPr = data.target && data.state.projects.find((p) => p.id === data.target.projectId);
    const tCat = tPr && tPr.categories.find((c) => c.id === data.target.catId);

    for (const c of cards) {
      const { block, m, jobId } = c;
      let row = block.querySelector(":scope > .ps-row");
      if (!row) {
        row = document.createElement("div");
        row.className = "ps-row";
        block.appendChild(row);
      }
      const entry = jobId ? data.dlList.find((e) => same(e.jobId, jobId)) : null;
      const sig = JSON.stringify([!!m, m && [m.pr.name, m.cat.name, m.p.id], c.failed, jobId, entry && entry.status, tCat && [tPr.name, tCat.name]]);
      if (row.dataset.sig === sig) continue;
      row.dataset.sig = sig;
      row.textContent = "";

      const badge = document.createElement("span");
      badge.className = "ps-badge" + (!m ? " gray" : c.failed ? " red" : "");
      badge.textContent = m ? `${m.pr.name} › ${m.cat.name} › ${serialOf(m.cat, m.p)}` : tCat ? `not in your prompts → ${tPr.name} › ${tCat.name}` : "not in your prompts";
      if (c.failed) badge.textContent += " · generation failed";
      row.append(badge);
      if (c.failed) continue; // nothing to download
      if (!m && !tCat) continue; // not in the lists and no category chosen for such results

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "ps-add" + (entry ? " on" : "");
      btn.disabled = !jobId;
      btn.textContent = !jobId ? "no job id" : entry ? (entry.status === "done" ? "✓ Downloaded" : "✓ In download list") : "＋ Download list";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          const u = m ? null : unmatchedInfo(c.text);
          chrome.runtime.sendMessage({
            type: "dllist", op: "toggle",
            entry: m
              ? { jobId, projectId: m.pr.id, catId: m.cat.id, promptId: m.p.id }
              : { jobId, projectId: tPr.id, catId: tCat.id, promptId: null, unmatched: true, serial: u.serial, title: u.title },
          });
        } catch {}
      };
      row.append(btn);
    }
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(paint, 300); };

  const load = () =>
    chrome.storage.local.get(["state", "jobMap", "dlList", "genFailed", "unmatchedTarget"], (d) => {
      data = { state: d.state || null, jobMap: d.jobMap || {}, dlList: d.dlList || [], genFailed: d.genFailed || {}, target: d.unmatchedTarget || null, idx: buildIndex(d.state) };
      schedule();
    });
  try {
    load();
    chrome.storage.onChanged.addListener((ch) => { if (ch.state || ch.jobMap || ch.dlList || ch.genFailed || ch.unmatchedTarget) load(); });
    // The site is a single-page app: repaint whenever its cards change (ignoring our own labels).
    new MutationObserver((muts) => {
      if (muts.every((m) => m.target.closest && m.target.closest(".ps-row"))) return;
      schedule();
    }).observe(document.documentElement, { childList: true, subtree: true });
  } catch {}
})();
