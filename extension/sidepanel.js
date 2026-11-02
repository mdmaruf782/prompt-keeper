const $ = (id) => document.getElementById(id);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// state = { projects: [{ id, name, categories: [{ id, name, prompts: [{id,title,text}], copied: [id] }] }], active }
let state = { projects: [], active: null };
let selectMode = false;
let dlList = []; // History cards added for download
let dlRunning = false, dlStopFlag = false;
let unmatchedTarget = null; // { projectId, catId } for results whose prompt is not in the lists
let genFailed = {}; // { "<catId>:<promptId>": { jobId, reason } } generations the site rejected
const openSet = new Set(); // categories whose setup panel is open
const editing = new Set(); // prompt keys currently being edited
const drafts = {}; // unsaved edits, so a re-render does not lose typing
let genPending = {}; // requests sent and still waiting for their job id
let jobMap = {}; // { "<catId>:<promptId>": { jobId, at } }, written by the background
const selected = new Set();

const save = () => chrome.storage.local.set({ state });
const project = () => state.projects.find((p) => p.id === state.active);

function ensureProject() {
  if (!state.projects.length) {
    const p = { id: uid(), name: "My Project", categories: [] };
    state.projects.push(p);
    state.active = p.id;
  }
  if (!project()) state.active = state.projects[0].id;
}

function render() {
  ensureProject();
  const proj = project();

  const sel = $("projectSel");
  sel.textContent = "";
  for (const p of state.projects) sel.add(new Option(p.name, p.id, false, p.id === state.active));

  const host = $("cats");
  const wasOpen = new Set([...host.querySelectorAll("details[open]")].map((d) => d.dataset.id));
  host.textContent = "";

  let total = 0, done = 0;
  for (const cat of proj.categories) {
    const copied = new Set(cat.copied);
    total += cat.prompts.length;
    done += copied.size;

    const det = document.createElement("details");
    det.className = "cat" + (copied.size === cat.prompts.length ? " done" : "");
    det.dataset.id = cat.id;
    det.open = wasOpen.has(cat.id) || (!host.children.length && !wasOpen.size);

    const sum = document.createElement("summary");
    const mk = (cls, text, title, fn) => {
      const el = document.createElement(fn ? "button" : "span");
      el.className = cls;
      el.textContent = text;
      if (title) el.title = title;
      if (fn) el.onclick = (e) => { e.preventDefault(); e.stopPropagation(); fn(); };
      return el;
    };
    if (selectMode) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selected.has(cat.id);
      cb.onclick = (e) => {
        e.stopPropagation();
        cb.checked ? selected.add(cat.id) : selected.delete(cat.id);
        updateBulk();
      };
      sum.append(cb);
    }
    sum.append(
      mk("name", cat.name),
      mk("count", `${copied.size}/${cat.prompts.length}` + ((n) => (n ? ` · ⚠${n} failed` : ""))(cat.prompts.filter((p) => genFailed[`${cat.id}:${p.id}`]).length)),
      mk("mini", "＋", "Add more prompts to this category (bulk import)", () => openImport(cat)),
      mk("mini" + (cat.setup ? " on" : ""), "⚙", cat.setup ? "This category has its own auto setup" : "Auto setup for this category (now: global)", () => {
        openSet.has(cat.id) ? openSet.delete(cat.id) : openSet.add(cat.id);
        render();
      }),
      mk("mini", "▶", "Copy next in this category", () => copyNext(cat)),
      mk("mini", "↺", "Reset copied marks", () => {
        if (confirm(`Clear copied marks in "${cat.name}"?`)) { cat.copied = []; save(); render(); }
      }),
      mk("mini", "✎", "Rename category", () => {
        const n = prompt("Category name", cat.name);
        if (n?.trim()) { cat.name = n.trim(); save(); render(); }
      }),
      mk("mini", "🗑", "Delete category", () => {
        if (confirm(`Delete category "${cat.name}"?`)) {
          proj.categories = proj.categories.filter((c) => c !== cat); save(); render();
        }
      })
    );
    det.append(sum);
    if (openSet.has(cat.id)) det.append(catSetupPanel(cat));

    const ul = document.createElement("ul");
    for (const p of cat.prompts) {
      const isDone = copied.has(p.id);
      const li = document.createElement("li");
      const isAsg = (cat.assigned || []).includes(p.id);
      const isDl = (cat.downloaded || []).includes(p.id);
      li.className = [isDone ? "copied" : "", isAsg ? "assigned" : "", isDl ? "downloaded" : ""].join(" ").trim();
      li.id = `p-${cat.id}-${p.id}`;
      const main = document.createElement("div");
      main.className = "main";
      main.append(
        Object.assign(document.createElement("div"), { className: "title", textContent: `${p.title || "Prompt " + p.id} · ${p.text.length} chars` }),
        Object.assign(document.createElement("div"), { className: "preview", textContent: p.text, title: "Click to expand/collapse" })
      );
      main.lastChild.onclick = (e) => e.currentTarget.classList.toggle("open");
      const ek = `${cat.id}:${p.id}`;
      const gf = genFailed[ek];
      if (gf) {
        li.classList.add("genfailed");
        main.append(Object.assign(document.createElement("div"), { className: "gf", textContent: "⚠ Generation failed" + (gf.reason ? ": " + gf.reason : "") }));
      }
      if (editing.has(ek)) {
        main.querySelector(".preview").hidden = true;
        const ta = Object.assign(document.createElement("textarea"), { className: "editor", value: drafts[ek] ?? p.text });
        ta.oninput = () => (drafts[ek] = ta.value);
        const save = Object.assign(document.createElement("button"), { className: "primary", textContent: "Save prompt" });
        save.onclick = () => savePromptEdit(cat, p.id, drafts[ek] ?? p.text);
        const cancel = Object.assign(document.createElement("button"), { textContent: "Cancel" });
        cancel.onclick = () => { editing.delete(ek); delete drafts[ek]; render(); };
        const bar = document.createElement("div");
        bar.className = "row";
        bar.append(save, cancel);
        main.append(ta, bar);
      } else {
        const erow = document.createElement("div");
        erow.className = "row";
        erow.append(
          Object.assign(document.createElement("button"), {
            className: "mini editbtn",
            textContent: "✎ Edit prompt",
            title: "Change this prompt's text so it can be generated again",
            onclick: () => { editing.add(ek); render(); },
          }),
          Object.assign(document.createElement("button"), {
            className: "mini editbtn danger",
            textContent: "🗑 Delete",
            title: "Delete this prompt",
            onclick: () => deletePrompt(cat, p.id),
          })
        );
        main.append(erow);
      }
      const btn = Object.assign(document.createElement("button"), {
        className: "copy",
        textContent: isDone ? "Copied" : "Copy",
        onclick: () => copyPrompt(cat, p.id),
      });
      const key = `${cat.id}:${p.id}`;
      const assign = Object.assign(document.createElement("button"), {
        className: "assign" + (isAsg ? " done" : ""),
        textContent: isAsg ? "Assigned" : "Assign prompt",
        onclick: (e) => assignPrompt(cat, p.id, e.currentTarget),
      });
      const assignSetup = Object.assign(document.createElement("button"), {
        className: "assign",
        textContent: "Assign + setup",
        title: "Apply the saved Setup settings on the page, then paste this prompt",
        onclick: (e) => assignPrompt(cat, p.id, e.currentTarget, true),
      });
      const btns = document.createElement("div");
      btns.className = "btns";
      btns.append(btn, assign, assignSetup);
      const jm = jobMap[key];
      if (Object.values(genPending).some((x) => x.key === key)) {
        btns.append(Object.assign(document.createElement("button"), {
          className: "assign",
          textContent: "Waiting for job id…",
          disabled: true,
        }));
      } else if (jm && !(genFailed[key] && genFailed[key].jobId === jm.jobId)) {
        btns.append(Object.assign(document.createElement("button"), {
          className: "assign view",
          textContent: "View video",
          title: jm.jobId,
          onclick: () => chrome.tabs.create({ url: `https://axcel.cloud/history/${jm.jobId}` }),
        }));
      }
      li.append(Object.assign(document.createElement("div"), { className: "num", textContent: p.id }), main, btns);
      ul.append(li);
    }
    det.append(ul);
    host.append(det);
  }

  $("bulkBar").hidden = !selectMode;
  $("selectMode").textContent = selectMode ? "Done" : "Select…";
  updateBulk();
  renderDlCats();
  renderDlList();
  $("empty").hidden = proj.categories.length > 0;
  $("stats").textContent = `${done} / ${total} copied · ${proj.categories.length} categories`;
  $("barFill").style.width = total ? (done / total) * 100 + "%" : "0";
}

function updateBulk() {
  const cats = project().categories;
  for (const id of [...selected]) if (!cats.some((c) => c.id === id)) selected.delete(id);
  $("selCount").textContent = `${selected.size} selected`;
  $("selAll").checked = cats.length > 0 && selected.size === cats.length;
}

async function copyPrompt(cat, id) {
  const p = cat.prompts.find((x) => x.id === id);
  try {
    await navigator.clipboard.writeText(p.text);
  } catch {
    const t = document.createElement("textarea");
    t.value = p.text;
    document.body.append(t);
    t.select();
    document.execCommand("copy");
    t.remove();
  }
  if (!cat.copied.includes(id)) cat.copied.push(id);
  save();
  render();
  return p;
}

function copyNext(cat) {
  const next = cat.prompts.find((p) => !cat.copied.includes(p.id));
  if (!next) return alert(`All prompts in "${cat.name}" are copied.`);
  copyPrompt(cat, next.id).then(() => {
    const d = document.querySelector(`details[data-id="${cat.id}"]`);
    if (d) d.open = true;
    document.getElementById(`p-${cat.id}-${next.id}`)?.scrollIntoView({ block: "center" });
  });
}

let importTarget = null; // category receiving the import; null = create a new category
function openImport(cat) {
  importTarget = cat || null;
  $("importBox").hidden = false;
  $("importTitle").textContent = cat ? `Add prompts to "${cat.name}"` : "New category";
  $("newCatFields").hidden = !!cat;
  $("splitBtn").textContent = cat ? "Split & add to category" : "Split & add to project";
  $("importBox").scrollIntoView({ block: "nearest" });
  $("input").focus();
}
function closeImport() { importTarget = null; $("importBox").hidden = true; }

function importText(text, fallbackName) {
  const prompts = splitPrompts(text, $("splitMode").value, $("delim").value);
  if (!prompts.length) return alert("No prompts found.");
  const proj = project();
  let cat = importTarget && proj.categories.find((c) => c.id === importTarget.id);
  if (cat) {
    // Keep ids unique: continue after the highest existing id.
    const base = cat.prompts.reduce((m, p) => Math.max(m, Number(p.id) || 0), 0);
    prompts.forEach((p, i) => (p.id = base + i + 1));
    cat.prompts.push(...prompts);
  } else {
    const name = $("catName").value.trim() || fallbackName || `Category ${proj.categories.length + 1}`;
    cat = { id: uid(), name, prompts, copied: [] };
    if ($("catSetupMode").value === "specific") {
      cat.setup = JSON.parse(JSON.stringify(SETUP)); // starts as a copy of the global setup
      openSet.add(cat.id);
    }
    proj.categories.push(cat);
  }
  save();
  $("input").value = "";
  $("catName").value = "";
  $("catSetupMode").value = "global";
  $("splitCount").textContent = "";
  closeImport();
  render();
}

function previewSplit() {
  $("delim").hidden = $("splitMode").value !== "delim";
  const t = $("input").value;
  $("splitCount").textContent = t.trim()
    ? `Will create ${splitPrompts(t, $("splitMode").value, $("delim").value).length} prompt(s)`
    : "";
}
["input", "delim"].forEach((id) => ($(id).oninput = previewSplit));
$("splitMode").onchange = previewSplit;
$("splitBtn").onclick = () => importText($("input").value);
$("file").onchange = async (e) => {
  const f = e.target.files[0];
  if (f) importText(await f.text(), f.name.replace(/\.[^.]+$/, ""));
  e.target.value = "";
};
$("toggleImport").onclick = () => ($("importBox").hidden || importTarget ? openImport(null) : closeImport());
$("cancelImport").onclick = closeImport;
$("nextBtn").onclick = () => {
  const cat = project().categories.find((c) => c.copied.length < c.prompts.length);
  if (!cat) return alert("Nothing left to copy in this project.");
  copyNext(cat);
};
$("projectSel").onchange = (e) => { state.active = e.target.value; save(); render(); };
$("newProject").onclick = () => {
  const n = prompt("Project name");
  if (!n?.trim()) return;
  const p = { id: uid(), name: n.trim(), categories: [] };
  state.projects.push(p);
  state.active = p.id;
  save(); render();
};
$("renameProject").onclick = () => {
  const n = prompt("Project name", project().name);
  if (n?.trim()) { project().name = n.trim(); save(); render(); }
};
$("deleteProject").onclick = () => {
  if (!confirm(`Delete project "${project().name}" and all its prompts?`)) return;
  state.projects = state.projects.filter((p) => p.id !== state.active);
  state.active = null;
  save(); render();
};
$("selectMode").onclick = () => { selectMode = !selectMode; selected.clear(); render(); };
$("selAll").onchange = (e) => {
  selected.clear();
  if (e.target.checked) project().categories.forEach((c) => selected.add(c.id));
  render();
};
$("resetAll").onclick = () => {
  if (!confirm("Clear copied marks for every category in this project?")) return;
  project().categories.forEach((c) => (c.copied = []));
  save(); render();
};
$("deleteAll").onclick = () => {
  const n = project().categories.length;
  if (!n) return;
  if (!confirm(`Delete all ${n} categories and their prompts from this project?`)) return;
  project().categories = [];
  selected.clear();
  save(); render();
};
$("bulkReset").onclick = () => {
  if (!selected.size) return alert("Select at least one category.");
  if (!confirm(`Clear copied marks in ${selected.size} selected categories?`)) return;
  project().categories.filter((c) => selected.has(c.id)).forEach((c) => (c.copied = []));
  save(); render();
};
$("bulkDelete").onclick = () => {
  if (!selected.size) return alert("Select at least one category.");
  if (!confirm(`Delete ${selected.size} selected categories?`)) return;
  project().categories = project().categories.filter((c) => !selected.has(c.id));
  selected.clear();
  save(); render();
};

chrome.storage.local.get(["state", "prompts", "copied"], (d) => {
  if (d.state) state = d.state;
  else if (d.prompts?.length) {
    // migrate v1 single-list data
    const p = { id: uid(), name: "My Project", categories: [
      { id: uid(), name: "Imported", prompts: d.prompts, copied: d.copied || [] },
    ] };
    state = { projects: [p], active: p.id };
    chrome.storage.local.remove(["prompts", "copied"]);
    save();
  }
  render();
});

// ================= tabs =================
function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => (t.hidden = t.id !== "tab-" + name));
  document.querySelectorAll("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
}
document.querySelectorAll("#tabs button[data-tab]").forEach((b) => (b.onclick = () => showTab(b.dataset.tab)));

// Old versions stored a captured request (with session headers) and a queue; wipe them.
chrome.storage.local.remove(["target", "queue", "capturing", "capFilter"]);

// ================= observe diagnostics =================
function renderDiag(d = {}) {
  const t = (ms) => (ms ? new Date(ms).toLocaleTimeString() : "never");
  $("diag").textContent =
    `Content script on page: ${t(d.relayAt)}\n` +
    `Page hook running:      ${t(d.hookAt)}\n` +
    `Refs injected on Generate: ${t(d.injectAt)}${d.injectAt ? ` (${d.injectN} ids)` : ""}\n` +
    `Last Generate seen:     ${t(d.genAt)}${d.genNote ? ` (${d.genNote})` : ""}\n` +
    `Last /api/jobs seen:    ${t(d.jobsAt)}` +
    (d.jobsAt ? ` (${d.jobsUrl}, ${d.jobsCount ?? "?"} items${d.jobsParsed ? "" : ", not JSON"})` : "");
  $("diag").style.whiteSpace = "pre-wrap";
}
chrome.storage.local.get("diag", (d) => renderDiag(d.diag));
chrome.storage.onChanged.addListener((ch) => { if (ch.diag) renderDiag(ch.diag.newValue); });

// ================= page auto setup =================
// Options as shown on the site's Text to Video form.
const SETUP_OPTIONS = {
  duration: [["5", "5s"], ["8", "8s"], ["10", "10s"], ["12", "12s"], ["15", "15s"], ["30", "30s"]],
  resolution: [["480", "480p"], ["720", "720p"], ["1080", "1080p"]],
  ratio: [["auto", "Auto (match image, Image to Video only)"], ["16:9", "16:9"], ["9:16", "9:16"], ["1:1", "1:1"], ["3:4", "3:4"], ["4:3", "4:3"], ["21:9", "21:9"]],
};
const DEFAULT_SETUP = { model: "Seedance 2.5", duration: "30", resolution: "1080", ratio: "9:16", audio: true, imageMode: "Reference", injectRefs: true, selectRefs: false, refs: [] };
let SETUP = { ...DEFAULT_SETUP };

function updateSetupTitle() {
  $("autoSetup").title = `Model: ${SETUP.model}\nDuration: ${SETUP.duration}s · Resolution: ${SETUP.resolution}p · Ratio: ${SETUP.ratio} · Audio: ${SETUP.audio ? "on" : "off"}`;
}
function fillOptions(sel, list) {
  sel.textContent = "";
  for (const [v, label] of list) sel.add(new Option(label, v));
}
function renderSetup() {
  $("sModel").value = SETUP.model;
  $("sDuration").value = SETUP.duration;
  $("sResolution").value = SETUP.resolution;
  $("sRatio").value = SETUP.ratio;
  $("sAudio").checked = SETUP.audio;
  $("sImageMode").value = SETUP.imageMode;
  $("sSelectRefs").checked = SETUP.selectRefs;
  $("sInjectRefs").checked = SETUP.injectRefs;
  $("sRefs").textContent = SETUP.refs.length
    ? SETUP.refs.map((r, i) => `Image ${i + 1}: ${r.name || r.id}`).join("\n")
    : "No reference images saved.";
  $("sRefs").style.whiteSpace = "pre-wrap";
}
fillOptions($("sDuration"), SETUP_OPTIONS.duration);
fillOptions($("sResolution"), SETUP_OPTIONS.resolution);
fillOptions($("sRatio"), SETUP_OPTIONS.ratio);
chrome.storage.local.get("setup", (d) => {
  SETUP = { ...DEFAULT_SETUP, ...(d.setup || {}) };
  renderSetup();
  updateSetupTitle();
});
$("sSave").onclick = async () => {
  SETUP = {
    model: $("sModel").value.trim() || DEFAULT_SETUP.model,
    duration: $("sDuration").value,
    resolution: $("sResolution").value,
    ratio: $("sRatio").value,
    audio: $("sAudio").checked,
    imageMode: $("sImageMode").value,
    selectRefs: $("sSelectRefs").checked,
    injectRefs: $("sInjectRefs").checked,
    refs: SETUP.refs || [],
  };
  await chrome.storage.local.set({ setup: SETUP });
  await chrome.storage.local.remove("activeSetup");
  renderSetup();
  updateSetupTitle();
  $("sStatus").textContent = "Saved. Auto setup will use these settings.";
};
$("sReset").onclick = async () => {
  SETUP = { ...DEFAULT_SETUP, refs: SETUP.refs || [] };
  await chrome.storage.local.set({ setup: SETUP });
  await chrome.storage.local.remove("activeSetup");
  renderSetup();
  updateSetupTitle();
  $("sStatus").textContent = "Reset to defaults.";
};

// Runs inside the axcel.cloud page (MAIN world). Must be self-contained.
async function pageSetup(cfg) {
  const log = [];
  let html = "";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Model picker is a custom dropdown: open it, then click the matching item.
  const trigger = document.querySelector("ax-model-picker button.trigger");
  if (!trigger) log.push("Model: picker not found");
  else if (trigger.textContent.trim().includes(cfg.model)) log.push(`Model: already ${cfg.model}`);
  else {
    trigger.click();
    await wait(400);
    const opt = [...document.querySelectorAll("button, li, div, [role=option]")]
      .filter((el) => el.children.length <= 3 && el.textContent.trim() === cfg.model)
      .pop();
    if (opt) { opt.click(); log.push(`Model: set ${cfg.model}`); }
    else { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); log.push(`Model: "${cfg.model}" not found in list`); }
    await wait(300);
  }

  // Native selects: find the one that offers the required option values.
  const setSelect = (label, need, value) => {
    const sel = [...document.querySelectorAll("select")].find((s) => {
      const vals = [...s.options].map((o) => o.value);
      return need.every((v) => vals.includes(v));
    });
    if (!sel) return log.push(`${label}: select not found`);
    if (![...sel.options].some((o) => o.value === value)) return log.push(`${label}: "${value}" is not available on this page`);
    if (sel.value !== value) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
      setter.call(sel, value);
      sel.dispatchEvent(new Event("input", { bubbles: true }));
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }
    log.push(`${label}: ${sel.value === value ? "set " + value : "FAILED (is " + sel.value + ")"}`);
  };
  // Image to Video only: "Image mode" radio group (First frame / First + last / Reference).
  const group = document.querySelector('[role="radiogroup"][aria-labelledby="mode-gambar-label"]');
  if (group && cfg.imageMode) {
    const b = [...group.querySelectorAll('[role="radio"]')].find((x) => x.textContent.trim().toLowerCase() === cfg.imageMode.toLowerCase());
    if (!b) log.push(`Image mode: "${cfg.imageMode}" not found`);
    else if (b.getAttribute("aria-checked") === "true") log.push(`Image mode: already ${cfg.imageMode}`);
    else {
      b.click();
      await wait(400);
      log.push(b.getAttribute("aria-checked") === "true" ? `Image mode: set ${cfg.imageMode}` : "Image mode: FAILED");
    }
  }

  setSelect("Duration", ["5", "30"], cfg.duration);
  setSelect("Resolution", ["480", "1080"], cfg.resolution);
  setSelect("Ratio", ["16:9", "9:16"], cfg.ratio);

  // Generate Audio: a role="switch" button inside the label that holds the text.
  const want = cfg.audio;
  const audioLabel = [...document.querySelectorAll("label")].find((l) => l.textContent.includes("Generate Audio"));
  const sw = audioLabel?.querySelector('button[role="switch"]');
  if (!sw) log.push("Generate Audio: switch not found");
  else if ((sw.getAttribute("aria-checked") === "true") === want) log.push(`Generate Audio: already ${want ? "on" : "off"}`);
  else {
    sw.click();
    await wait(200);
    const now = sw.getAttribute("aria-checked") === "true";
    log.push(now === want ? `Generate Audio: set ${want ? "on" : "off"}` : `Generate Audio: FAILED (is ${now ? "on" : "off"})`);
  }
  // Reference images (Image to Video): open the library, wait for thumbnails to load,
  // click each saved asset as it appears, then close the dialog.
  const libBtn = document.querySelector('[data-uji="library-refimg"]');
  if (cfg.selectRefs && cfg.refs?.length && libBtn) {
    const idOf = (src) => (String(src).match(/\/api\/library\/(as_[0-9a-f]+)/) || [])[1];
    const current = () =>
      [...document.querySelectorAll('[data-uji="nomor-ref"]')].map((b) => idOf(b.parentElement.querySelector("img")?.src));
    // Library thumbnails only: not the form's own grid tiles or "Mention in prompt" chips.
    const libImgs = (sel) =>
      [...document.querySelectorAll(sel)].filter(
        (i) => !i.closest('[data-uji^="sisip-"]') && !i.closest('[data-uji="nomor-ref"]') && !i.parentElement.querySelector('[data-uji="nomor-ref"]')
      );
    const findDialog = () =>
      [...document.querySelectorAll('[role="dialog"], [aria-modal="true"], dialog, [class*="modal"], [class*="dialog"], [class*="overlay"], [class*="backdrop"]')]
        .filter((d) => d.getClientRects().length > 0)
        .sort((a, b) => b.querySelectorAll("img").length - a.querySelectorAll("img").length)[0];
    const until = async (fn, ms) => {
      const t = Date.now();
      while (Date.now() - t < ms) { if (fn()) return true; await wait(250); }
      return false;
    };

    const missing = cfg.refs.filter((r) => !current().includes(r.id));
    if (!missing.length) log.push(`References: all ${cfg.refs.length} already selected`);
    else {
      libBtn.click();
      const pending = new Set(missing.map((r) => r.id));
      const started = Date.now();
      while (pending.size && Date.now() - started < 25000) {
        let progressed = false;
        for (const id of [...pending]) {
          const img = libImgs(`img[src*="${id}"]`).find((i) => i.complete && i.naturalWidth > 0);
          if (!img) continue;
          (img.closest('button, [role="button"], [role="option"], li, label') || img).click();
          pending.delete(id);
          progressed = true;
          await wait(250);
        }
        if (pending.size && !progressed) {
          // Not loaded yet, or further down a long list: scroll the list to load more, then retry.
          let el = libImgs('img[src*="/api/library/"]')[0]?.parentElement;
          while (el && !(el.scrollHeight > el.clientHeight + 4)) el = el.parentElement;
          if (el && el.scrollTop + el.clientHeight < el.scrollHeight - 2) el.scrollBy(0, el.clientHeight);
          await wait(400);
        }
      }

      const dlg = findDialog();
      const ok = [...(dlg || document).querySelectorAll("button")].find(
        (b) => /^(add|done|select|use|confirm|insert|choose|ok|apply|attach|pilih|tambah|selesai|gunakan)\b/i.test(b.textContent.trim()) && !b.closest("section")
      );
      if (ok) { ok.click(); await wait(500); }
      await until(() => cfg.refs.every((r) => current().includes(r.id)), 4000);

      const now = current();
      const got = cfg.refs.filter((r) => now.includes(r.id)).length;
      if (got === cfg.refs.length) {
        // All selected: close the dialog if it is still open.
        const d2 = findDialog();
        if (d2) {
          const x = d2.querySelector('[aria-label*="close" i], [aria-label*="tutup" i], [data-uji*="tutup"], [data-uji*="close"]');
          if (x) x.click();
          else for (const t of [document.activeElement, document.body]) t?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
          await wait(400);
        }
      } else {
        // Leave the dialog open and dump it so its structure can be inspected.
        const root = findDialog() || document.body.lastElementChild;
        html = (root?.outerHTML || "")
          .replace(/<svg[\s\S]*?<\/svg>/g, "<svg/>")
          .replace(/ _ng[\w-]+=""/g, "")
          .slice(0, 60000);
      }
      log.push(`References: ${got}/${cfg.refs.length} selected${got < cfg.refs.length ? " (see dialog HTML below)" : ""}`);
    }
  } else if (cfg.selectRefs && cfg.refs?.length) log.push("References: library button not found (Text to Video page, so skipped)");

  return { log, html };
}

async function findTab() {
  const url = "https://axcel.cloud/*";
  // The tab the user is looking at (in the focused window) first, then any axcel.cloud tab.
  const [current] = await chrome.tabs.query({ url, active: true, lastFocusedWindow: true });
  return current || (await chrome.tabs.query({ url }))[0];
}

// Applies the saved settings on the page. Returns false only if the script itself could not run.
const effSetup = (cat) => (cat && cat.setup ? { ...DEFAULT_SETUP, ...cat.setup } : SETUP);

async function runSetup(tab, cfg = SETUP) {
  $("setupStatus").style.whiteSpace = "pre-wrap";
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "MAIN", func: pageSetup, args: [cfg],
    });
    // The reference ids sent with the next Generate follow the setup that was just applied.
    await chrome.storage.local.set({ activeSetup: cfg });
    $("setupStatus").textContent = result.log.join("\n");
    if (result.html) {
      $("setupDebug").hidden = false;
      $("setupDebug").value = result.html;
      let copied = false;
      try { await navigator.clipboard.writeText(result.html); copied = true; } catch {}
      $("setupStatus").textContent += copied
        ? "\nLibrary dialog HTML copied to clipboard. Paste it into the chat."
        : "\nLibrary dialog HTML is in the box below. Select all, copy, and paste it into the chat.";
    } else $("setupDebug").hidden = true;
    return true;
  } catch (e) {
    $("setupStatus").textContent = "Setup failed: " + e.message;
    return false;
  }
}

async function autoSetup() {
  const tab = await findTab();
  if (!tab) return ($("setupStatus").textContent = "Open an axcel.cloud tab first.");
  await runSetup(tab);
}
$("autoSetup").onclick = autoSetup;

// ================= assign prompt into the site's textarea =================
// Runs inside the axcel.cloud page (MAIN world). Must be self-contained.
// Only fills the textarea. The user clicks Generate on the site themselves.
function pageAssign(text) {
  const ta = document.querySelector('textarea[data-uji="prompt"]');
  if (!ta) return { ok: false, msg: "Prompt textarea not found. Open the Text to Video page." };
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
  setter.call(ta, text);
  ta.dispatchEvent(new Event("input", { bubbles: true }));
  ta.dispatchEvent(new Event("change", { bubbles: true }));
  return ta.value === text ? { ok: true } : { ok: false, msg: "Page did not accept the text." };
}

async function assignPrompt(cat, id, btn, withSetup = false) {
  const p = cat.prompts.find((x) => x.id === id);
  const tab = await findTab();
  if (!tab) return alert("Open an axcel.cloud tab first.");
  btn.disabled = true;
  btn.textContent = withSetup ? "Setting up…" : "Assigning…";
  try {
    // Settings first (they can re-render the form), prompt last.
    if (withSetup && !(await runSetup(tab, effSetup(cat)))) { render(); return alert($("setupStatus").textContent); }
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, world: "MAIN", func: pageAssign, args: [p.text],
    });
    if (!result.ok) { render(); return alert(result.msg); }
    // The next Generate the site sends is tied to this prompt (see background handleGen).
    await chrome.storage.local.set({ assignedLast: { catId: cat.id, promptId: id, at: Date.now() } });
    cat.assigned = cat.assigned || [];
    if (!cat.assigned.includes(id)) cat.assigned.push(id);
    save();
    render();
  } catch (e) {
    render();
    alert("Assign failed: " + e.message);
  }
}

// ================= capture reference images from the page =================
// Runs inside the axcel.cloud page (MAIN world). Must be self-contained.
function pageReadRefs() {
  return [...document.querySelectorAll('[data-uji="nomor-ref"]')]
    .map((b) => {
      const img = b.parentElement.querySelector("img");
      const m = (img?.src || "").match(/\/api\/library\/(as_[0-9a-f]+)/);
      return m ? { id: m[1], name: img.alt || "" } : null;
    })
    .filter(Boolean);
}
$("sCaptureRefs").onclick = async () => {
  const tab = await findTab();
  if (!tab) return ($("sStatus").textContent = "Open the axcel.cloud Image to Video page first.");
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: pageReadRefs });
    if (!result.length) return ($("sStatus").textContent = "No reference images found on that page.");
    SETUP.refs = result;
    await chrome.storage.local.set({ setup: SETUP });
    await chrome.storage.local.remove("activeSetup");
    renderSetup();
    $("sStatus").textContent = `Captured ${result.length} reference image(s).`;
  } catch (e) {
    $("sStatus").textContent = "Capture failed: " + e.message;
  }
};
$("sClearRefs").onclick = async () => {
  SETUP.refs = [];
  await chrome.storage.local.set({ setup: SETUP });
  await chrome.storage.local.remove("activeSetup");
  renderSetup();
  $("sStatus").textContent = "Cleared saved reference images.";
};

// ================= download result =================
// Runs inside the axcel.cloud page (MAIN world). Must be self-contained.
function pageReadResult() {
  // The result's download button: by data-uji, else by its text.
  const btn =
    document.querySelector('[data-uji="unduh-preview"]') ||
    [...document.querySelectorAll("button, a")].find((b) => /download\s+for\s+final/i.test(b.textContent));
  if (!btn) {
    const near = [...document.querySelectorAll("button, a")]
      .filter((b) => /download|unduh/i.test(b.textContent + (b.getAttribute("data-uji") || "")))
      .map((b) => `"${b.textContent.trim().slice(0, 40)}"${b.getAttribute("data-uji") ? ` [data-uji=${b.getAttribute("data-uji")}]` : ""}`);
    return {
      ok: false,
      msg: "Download button not found on this tab (" + location.pathname + "). " +
        (near.length ? "Download-like buttons here: " + near.join(", ") : "No download-like buttons on this tab. Make sure the result tab is the active tab."),
    };
  }
  if (btn.disabled) return { ok: false, msg: "Download button is disabled (result not ready?)." };

  // Prompt text: the paragraph under the "Prompt" label, else the biggest pre-wrap paragraph.
  const paras = [...document.querySelectorAll("p")].filter((p) => /whitespace-pre/.test(p.className));
  const p = paras.sort((a, b) => b.textContent.length - a.textContent.length)[0];
  const dd = (label) => {
    const dt = [...document.querySelectorAll("dt")].find((d) => d.textContent.trim() === label);
    return dt?.nextElementSibling?.textContent.trim() || "";
  };
  // Job id (job_…): from the page address, else from the video's own URL.
  const srcs = [location.href, ...[...document.querySelectorAll("video, video source")].map((v) => v.currentSrc || v.src || "")];
  const jobId = (srcs.join(" ").match(/job_[0-9a-f]+/i) || [""])[0];
  return { ok: true, text: (p?.textContent || "").trim(), created: dd("Created"), jobId };
}
// Is the site itself still downloading the file? (button reads "Downloading…", a "1 downloading" panel with a % bar)
function pageDownloadState() {
  const leaves = [...document.querySelectorAll("*")].filter((el) => el.children.length === 0);
  const btn =
    document.querySelector('[data-uji="unduh-preview"]') ||
    [...document.querySelectorAll("button, a")].find((b) => /download/i.test(b.textContent));
  const busyBtn = !!btn && /downloading|preparing/i.test(btn.textContent);
  const panel = leaves.some((el) => /^\d+\s+downloading$/i.test(el.textContent.trim()));
  const pctEl = leaves.find((el) => /^downloading\s+\d+%$/i.test(el.textContent.trim()));
  return { busy: busyBtn || panel || !!pctEl, pct: pctEl ? pctEl.textContent.trim() : "" };
}
function pageClickDownload() {
  const btn =
    document.querySelector('[data-uji="unduh-preview"]') ||
    [...document.querySelectorAll("button, a")].find((b) => /download\s+for\s+final/i.test(b.textContent));
  btn.click();
}

const cleanPart = (x) => x.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 80);

// "<base subfolder>/<project>/<category>/" under Chrome's Downloads folder.
function folderFor(proj, cat) {
  const baseDirs = ($("dlBase").value || "").split(/[\\/]+/).map(cleanPart).filter((x) => x && x !== "..");
  return [...baseDirs, cleanPart(proj.name), cleanPart(cat.name)].join("/") + "/";
}

function makeFileName(template, info) {
  if (info.serial && !template.includes("{serial}")) template = "{serial} - " + template;
  // Episode number / title come from the matched prompt's title (or the result's first line),
  // never from the whole prompt text, which may mention other episodes.
  const src = info.title || info.text.split("\n")[0] || "";
  const m = src.match(/EPISODE\s*0*(\d+)/i);
  const ep = m ? m[1] : info.serial ? String(Number(info.serial)) : cleanPart(src).slice(0, 40);
  const title = cleanPart(src.replace(/^\s*EPISODE\s*\d+\s*[—–:\-]*\s*/i, ""));
  return (
    cleanPart(
      template
        .replace(/\{serial\}/g, info.serial || "")
        .replace(/\{ep\}/g, ep)
        .replace(/\{title\}/g, title)
        .replace(/\{created\}/g, info.created.replace(/,/g, ""))
    ) || "video"
  );
}

// Finds which prompt of the category this result was generated from (full-text match, whitespace/quote-insensitive).
function matchPrompt(cat, pageText) {
  const key = (t) => t.replace(/[\s"'“”‘’]+/g, "");
  const k = key(pageText);
  const hits = cat.prompts.filter((p) => key(p.text) === k);
  if (hits.length) return { prompt: hits.find((p) => !(cat.downloaded || []).includes(p.id)) || hits[0] };
  let best = null, bestLen = 0;
  for (const p of cat.prompts) {
    const pk = key(p.text);
    let n = 0;
    while (n < pk.length && n < k.length && pk[n] === k[n]) n++;
    if (n > bestLen) { bestLen = n; best = p; }
  }
  return { prompt: null, best, same: bestLen, pageLen: k.length, bestLenTotal: best ? key(best.text).length : 0 };
}

function renderDlCats() {
  const sel = $("dlCat");
  const keep = sel.value || localStorage.getItem("dlCat");
  const proj = project();
  $("dlProject").textContent = "Project: " + proj.name;
  sel.textContent = "";
  for (const c of proj.categories) sel.add(new Option(`${c.name} (${c.prompts.length})`, c.id));
  if (proj.categories.some((c) => c.id === keep)) sel.value = keep;

  // Where results whose prompt is not in the lists should go (read by the History page script).
  const u = $("unmatchedCat");
  u.textContent = "";
  u.add(new Option("— none (no button for them) —", ""));
  for (const c of proj.categories) u.add(new Option(c.name, c.id));
  u.value = unmatchedTarget && unmatchedTarget.projectId === proj.id && proj.categories.some((c) => c.id === unmatchedTarget.catId) ? unmatchedTarget.catId : "";
}
$("unmatchedCat").onchange = () => {
  const catId = $("unmatchedCat").value;
  if (catId) chrome.storage.local.set({ unmatchedTarget: { projectId: project().id, catId } });
  else chrome.storage.local.remove("unmatchedTarget");
};
$("dlBase").value = localStorage.getItem("dlBase") || "";
$("dlBase").onchange = () => localStorage.setItem("dlBase", $("dlBase").value.trim());
$("dlCat").onchange = () => localStorage.setItem("dlCat", $("dlCat").value);
$("dlFolders").onchange = () => localStorage.setItem("dlFolders", $("dlFolders").checked ? "1" : "0");
if (localStorage.getItem("dlFolders") === "0") $("dlFolders").checked = false;

async function downloadResult() {
  const st = $("dlStatus");
  st.style.whiteSpace = "pre-wrap";
  const tab = await findTab();
  if (!tab) return (st.textContent = "Open an axcel.cloud tab first.");
  try {
    const run = (func) => chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func });
    const [{ result: info }] = await run(pageReadResult);
    if (!info.ok) return (st.textContent = info.msg);

    let cat = null, folder = "";
    if ($("dlFolders").checked) {
      const proj = project();
      // 1) The job id on this page, if we recorded which prompt generated it.
      let matched = null;
      if (info.jobId) {
        for (const c of proj.categories) {
          for (const [k, v] of Object.entries(jobMap)) {
            if (k.startsWith(c.id + ":") && v.jobId.toLowerCase() === info.jobId.toLowerCase()) {
              const pr = c.prompts.find((x) => x.id === Number(k.split(":")[1]));
              if (pr) { cat = c; matched = pr; }
            }
          }
        }
      }
      // 2) Otherwise compare the result's prompt text with the selected category.
      if (!matched) {
        cat = proj.categories.find((c) => c.id === $("dlCat").value);
        if (!cat) return (st.textContent = "Choose a category first (Prompts tab > Bulk import creates one).");
        const m = matchPrompt(cat, info.text);
        if (!m.prompt) {
          return (st.textContent =
            `Nothing downloaded: this result's prompt does not match any prompt in "${cat.name}".` +
            (m.best ? `\nClosest is #${m.best.id}: first ${m.same} characters are the same, then they differ (result prompt ${m.pageLen} chars, #${m.best.id} is ${m.bestLenTotal} chars).` : "") +
            "\nCheck that the right category is selected.");
        }
        matched = m.prompt;
      }
      info.serial = String(matched.id).padStart(Math.max(2, String(cat.prompts.length).length), "0");
      info.promptId = matched.id;
      info.title = matched.title || "";
      folder = folderFor(proj, cat);
    }

    const name = folder + makeFileName($("dlTemplate").value || "{serial} - Episode {ep}", info);
    // Register the name under this page's job id before clicking, so several tabs can download at once.
    if (info.jobId) await chrome.runtime.sendMessage({ type: "dl-register", jobId: info.jobId, name });
    else await chrome.storage.local.set({ dlPending: { name, at: Date.now() } });
    await run(pageClickDownload);
    if (cat) {
      cat.downloaded = cat.downloaded || [];
      if (!cat.downloaded.includes(info.promptId)) cat.downloaded.push(info.promptId);
      save();
      render();
    }
    st.textContent =
      `Matched prompt #${info.promptId ?? "-"}. Saving as “${name}”.` +
      (info.jobId ? `\nJob: ${info.jobId}` : "\nNo job id found on this page, so only one download at a time is safe.");
  } catch (e) {
    st.textContent = "Download failed: " + e.message;
  }
}
$("dlBtn").onclick = downloadResult;
$("dlTemplate").onchange = () => chrome.storage.local.set({ dlTemplate: $("dlTemplate").value });
chrome.storage.local.get("dlTemplate", (d) => {
  if (d.dlTemplate) $("dlTemplate").value = d.dlTemplate;
});
chrome.storage.onChanged.addListener((ch) => {
  if (ch.lastDownload) $("dlStatus").textContent = `Saved as ${ch.lastDownload.newValue.name}`;
});

function renderDlInfo(d) {
  if (!d) return;
  $("dlInfo").style.whiteSpace = "pre-wrap";
  $("dlInfo").textContent =
    `${new Date(d.at).toLocaleTimeString()}\nURL: ${d.url}` +
    (d.finalUrl ? `\nFinal URL: ${d.finalUrl}` : "") +
    `\nType: ${d.mime || "?"}\nFile: ${d.filename}` +
    (d.jobId ? `\nJob: ${d.jobId}` : "") +
    `\nRenamed to: ${d.renamedTo || "(not renamed)"}` +
    (d.referrer ? `\nFrom page: ${d.referrer}` : "");
}
chrome.storage.local.get("lastDownloadInfo", (d) => renderDlInfo(d.lastDownloadInfo));
chrome.storage.onChanged.addListener((ch) => { if (ch.lastDownloadInfo) renderDlInfo(ch.lastDownloadInfo.newValue); });

chrome.storage.local.get(["jobMap", "genPending", "genFailed"], (d) => { jobMap = d.jobMap || {}; genPending = d.genPending || {}; genFailed = d.genFailed || {}; render(); });
chrome.storage.onChanged.addListener((ch) => {
  if (ch.genFailed) { genFailed = ch.genFailed.newValue || {}; render(); }
  if (ch.jobMap || ch.genPending) {
    if (ch.jobMap) jobMap = ch.jobMap.newValue || {};
    if (ch.genPending) genPending = ch.genPending.newValue || {};
    render();
  }
});

// ================= link results from the History list =================
// Runs inside the axcel.cloud page (MAIN world). Must be self-contained.
// Each History card shows the FULL prompt in a <p> that CSS clamps to two lines, so the text is all in the DOM.
function pageScanHistory() {
  const isPromptP = (p) => !!(p.parentElement && p.parentElement.querySelector(':scope > p[translate="no"]'));
  const cardRoot = (block) => {
    let el = block;
    while (el.parentElement && el.parentElement.querySelectorAll('p[translate="no"]').length === 1) el = el.parentElement;
    return el;
  };
  const failInfo = (card) => {
    const el = [...card.querySelectorAll("*")].find((x) => x.children.length === 0 && x.textContent.trim() === "Failed");
    const reason = el ? (el.parentElement ? el.parentElement.textContent : "").replace("Failed", "").replace(/\s+/g, " ").trim().slice(0, 200) : "";
    return { failed: !!el, reason };
  };
  const cards = [];
  for (const p of document.querySelectorAll("p")) {
    if (!/line-clamp/.test(p.className)) continue;
    const text = p.textContent.trim();
    if (text.length < 20 || !isPromptP(p)) continue;
    const card = cardRoot(p.parentElement);
    const link = p.closest("a");
    const jobId = (((link && link.href) || "") + " " + (card.outerHTML.length < 20000 ? card.outerHTML : p.parentElement.outerHTML)).match(/job_[0-9a-f]{8,}/i)?.[0] || "";
    cards.push({ text, jobId, ...failInfo(card) });
  }
  return cards;
}

const normText = (t) => t.replace(/[\s"'“”‘’]+/g, "");

// Pure matching step: cards + project -> entries to link, and a summary.
function linkHistoryCards(cards, proj, selectedCatId, jobMap, genFailed = {}) {
  const selected = proj.categories.find((c) => c.id === selectedCatId);
  const order = [selected, ...proj.categories.filter((c) => c !== selected)].filter(Boolean);
  const failedIds = new Set(cards.filter((c) => c.failed && c.jobId).map((c) => c.jobId.toLowerCase()));
  const entries = {};
  const sum = { cards: cards.length, linked: 0, kept: 0, noMatch: 0, noJob: 0, failed: 0, failedOnly: [] };
  const okKeys = new Set();
  const failedItems = [];

  for (const card of cards) {
    let hit = null;
    for (const c of order) {
      const p = c.prompts.find((x) => normText(x.text) === normText(card.text));
      if (p) { hit = { c, p }; break; }
    }
    if (!hit) { sum.noMatch++; continue; }
    const k = `${hit.c.id}:${hit.p.id}`;
    if (card.failed) {
      sum.failed++;
      failedItems.push({ k, label: `${hit.c.name} #${hit.p.id}`, jobId: card.jobId, reason: card.reason || "" });
      continue;
    }
    if (!card.jobId) { sum.noJob++; continue; }
    if (okKeys.has(k)) continue; // an older duplicate of a prompt we already linked from a newer card
    okKeys.add(k);
    const cur = jobMap[k];
    if (cur && !failedIds.has(cur.jobId.toLowerCase())) { sum.kept++; continue; }
    entries[k] = { jobId: card.jobId, at: Date.now() };
    sum.linked++;
  }
  // Prompts whose only cards failed (nothing successful to link).
  const failedOnly = failedItems.filter((f) => !okKeys.has(f.k));
  sum.failedOnly = [...new Map(failedOnly.map((f) => [f.k, f.label])).values()];
  // Marks for the red "generation failed" state: new ones, and ones a good result has since replaced.
  const fail = [...new Map(failedOnly.filter((f) => genFailed[f.k]?.jobId !== f.jobId).map((f) => [f.k, { key: f.k, jobId: f.jobId, reason: f.reason }])).values()];
  const clear = [...okKeys].filter((k) => genFailed[k]);
  return { entries, sum, fail, clear };
}

async function scanHistory() {
  const st = $("scanStatus");
  st.style.whiteSpace = "pre-wrap";
  const tab = await findTab();
  if (!tab) return (st.textContent = "Open the axcel.cloud History page first.");
  try {
    const [{ result: cards }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: pageScanHistory });
    if (!cards.length) return (st.textContent = "No History cards found on this tab. Open the History list page and scroll to load the cards.");
    const { entries, sum, fail, clear } = linkHistoryCards(cards, project(), $("dlCat").value, jobMap, genFailed);
    if (Object.keys(entries).length) await chrome.runtime.sendMessage({ type: "jobmap-merge", entries });
    if (fail.length || clear.length) await chrome.runtime.sendMessage({ type: "genfailed", fail, clear });
    st.textContent =
      `${sum.cards} cards: ${sum.linked} linked, ${sum.kept} already linked, ${sum.noMatch} not in your prompts, ` +
      `${sum.failed} failed` + (sum.noJob ? `, ${sum.noJob} without a job id found` : "") + "." +
      (sum.failedOnly.length ? `\nMarked red (failed, no good result yet): ${sum.failedOnly.join(", ")}` : "") +
      (sum.noJob && !sum.linked ? "\nThe cards carry no job id in their HTML, so they cannot be linked automatically." : "");
  } catch (e) {
    st.textContent = "Scan failed: " + e.message;
  }
}
$("scanBtn").onclick = scanHistory;

// ================= download list =================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listOp = (msg) => chrome.runtime.sendMessage({ type: "dllist", ...msg });

// Project, then category, then serial order (the order they appear in your lists).
function sortedDlList(st, list) {
  const pos = (arr, id) => { const i = arr.findIndex((x) => x.id === id); return i < 0 ? 1e9 : i; };
  return [...list].sort((a, b) => {
    const pa = pos(st.projects, a.projectId), pb = pos(st.projects, b.projectId);
    if (pa !== pb) return pa - pb;
    const cats = (st.projects[pa] || { categories: [] }).categories;
    const ca = pos(cats, a.catId), cb = pos(cats, b.catId);
    return ca !== cb ? ca - cb : (a.promptId ?? a.serial) - (b.promptId ?? b.serial);
  });
}

function describeEntry(e) {
  const pr = state.projects.find((p) => p.id === e.projectId);
  const cat = pr?.categories.find((c) => c.id === e.catId);
  if (!cat) return null;
  // A result whose prompt is not in the lists: a stand-in prompt carrying its serial and title.
  const p = e.unmatched ? { id: e.serial, title: e.title || "", text: "" } : cat.prompts.find((x) => x.id === e.promptId);
  if (!p) return null;
  const width = Math.max(2, String(Math.max(cat.prompts.length, p.id)).length);
  return { pr, cat, p, unmatched: !!e.unmatched, serial: String(p.id).padStart(width, "0") };
}

function renderDlList() {
  const box = $("dlListBox");
  box.textContent = "";
  const n = (s) => dlList.filter((e) => e.status === s).length;
  $("dlListStatus").textContent = dlList.length
    ? `${dlList.length} in list: ${n("pending")} pending, ${n("done")} done, ${n("failed")} failed` + (n("cancelled") ? `, ${n("cancelled")} cancelled` : "")
    : "Empty. Add cards from the History page.";
  let lastGroup = "";
  for (const e of sortedDlList(state, dlList)) {
    const d = describeEntry(e);
    const group = d ? `${d.pr.name} › ${d.cat.name}` : "(deleted prompt)";
    if (group !== lastGroup) {
      box.append(Object.assign(document.createElement("div"), { className: "grp", textContent: group }));
      lastGroup = group;
    }
    const row = document.createElement("div");
    row.className = "it";
    const t = Object.assign(document.createElement("span"), {
      className: "t",
      textContent: d ? `${d.serial} · ${d.p.title || "Prompt " + d.p.id}` : e.jobId,
      title: e.jobId,
    });
    const chip = Object.assign(document.createElement("span"), { className: "chip " + e.status, textContent: e.status });
    const x = Object.assign(document.createElement("button"), { className: "mini", textContent: "✕", title: "Remove" });
    x.onclick = () => listOp({ op: "remove", jobId: e.jobId });
    row.append(t, chip);
    if (["failed", "pending", "cancelled"].includes(e.status) || (e.status === "opening" && !dlRunning)) {
      const r = Object.assign(document.createElement("button"), { className: "mini", textContent: "↻ Retry", title: "Try this one again" });
      r.onclick = () => retryNow(e);
      r.title = "Go to this result now and download it";
      row.append(r);
    }
    row.append(x);
    if (e.note) box.append(row, Object.assign(document.createElement("div"), { className: "n " + e.status, textContent: e.note }));
    else box.append(row);
  }
  $("dlRun").disabled = dlRunning;
  $("dlStop").disabled = !dlRunning;
}

function waitTabComplete(tabId, ms) {
  return new Promise((resolve) => {
    const done = () => { chrome.tabs.onUpdated.removeListener(l); resolve(); };
    const l = (id, ch) => { if (id === tabId && ch.status === "complete") done(); };
    chrome.tabs.onUpdated.addListener(l);
    chrome.tabs.get(tabId).then((t) => { if (t.status === "complete") done(); }).catch(done);
    setTimeout(done, ms);
  });
}

async function waitFor(fn, ms, step = 500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(step); }
  return false;
}

// Opens one result in a background tab, names it from its prompt, clicks the site's download, waits, closes the tab.
// The site sometimes does not answer, so a tab that shows no download button (or no download) is reloaded and tried again.
const DL_ATTEMPTS = 3;
// opts.active: open the tab in front so the user sees it (manual retry); opts.waitMs: how long to wait for the button.
async function downloadEntry(e, opts = {}) {
  const d = describeEntry(e);
  if (!d) return { ok: false, note: "This prompt no longer exists." };
  const tab = await chrome.tabs.create({ url: `https://axcel.cloud/history/${e.jobId}`, active: !!opts.active });
  let finishedOk = false;
  try {
    const run = (func) => chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func });
    let name = "", lastNote = "", success = false;
    await listOp({ op: "set", jobId: e.jobId, patch: { note: "Waiting for the download button…" } });

    for (let attempt = 1; attempt <= DL_ATTEMPTS && !success; attempt++) {
      if (attempt > 1) {
        await chrome.tabs.reload(tab.id);
        await sleep(1500);
      }
      await waitTabComplete(tab.id, 30000);
      let info = null, lastMsg = "page did not finish loading";
      await waitFor(async () => {
        try {
          const [{ result }] = await run(pageReadResult);
          if (result.ok) { info = result; return true; }
          lastMsg = result.msg;
        } catch (err) { lastMsg = err.message; }
        return false;
      }, opts.waitMs || 25000);
      if (!info) { lastNote = `${lastMsg} (attempt ${attempt}/${DL_ATTEMPTS})`; continue; }

      info.serial = d.serial;
      info.promptId = d.p.id;
      info.title = d.p.title || "";
      name = folderFor(d.pr, d.cat) + makeFileName($("dlTemplate").value || "{serial} - Episode {ep}", info);
      const t0 = Date.now();
      await chrome.runtime.sendMessage({ type: "dl-register", jobId: e.jobId, name });
      await run(pageClickDownload);

      // The site first downloads the file itself (progress bar, button reads "Downloading…") and only then hands it
      // to Chrome. Keep waiting while the page is busy; only reload when nothing has happened for 30 s
      // (or the progress has not moved for 3 minutes).
      const waitEnd = Date.now() + 15 * 60000;
      let idleSince = Date.now(), lastPct = "", pctSince = Date.now(), announced = false;
      while (Date.now() < waitEnd) {
        if (((await chrome.storage.local.get("lastDownload")).lastDownload?.at || 0) >= t0) { success = true; break; }
        let st = { busy: false, pct: "" };
        try { st = (await run(pageDownloadState))[0].result; } catch {}
        if (st.busy) {
          idleSince = Date.now();
          if (st.pct !== lastPct) { lastPct = st.pct; pctSince = Date.now(); }
          if (Date.now() - pctSince > 180000) break;
          if (!announced) {
            announced = true;
            await listOp({ op: "set", jobId: e.jobId, patch: { note: "The site is downloading the file, waiting…" } });
          }
        } else if (Date.now() - idleSince > 30000) break;
        await sleep(1000);
      }
      if (!success) lastNote = `No download started (attempt ${attempt}/${DL_ATTEMPTS}).`;
    }
    if (!success) return { ok: false, note: lastNote };

    // Keep the tab open until Chrome has finished the download (it comes from a page blob).
    const finished = await waitFor(async () => {
      const [it] = await chrome.downloads.search({ orderBy: ["-startTime"], limit: 1 });
      return it && it.state !== "in_progress";
    }, 180000, 1000);
    if (!finished) return { ok: false, note: "Download did not finish within 3 minutes." };

    // The file is saved; a UI hiccup while marking it must not turn this into a failure.
    try {
      if (!d.unmatched) {
        d.cat.downloaded = d.cat.downloaded || [];
        if (!d.cat.downloaded.includes(d.p.id)) d.cat.downloaded.push(d.p.id);
        save();
        render();
      }
    } catch {}
    finishedOk = true;
    return { ok: true, note: name };
  } finally {
    // A manual retry that failed keeps its tab open so the user can look at it.
    if (!(opts.active && !finishedOk)) chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function runDlList() {
  if (dlRunning) return;
  dlRunning = true;
  dlStopFlag = false;
  renderDlList();
  const failedThisRun = new Set();
  try {
    // Pass 1: everything pending. Pass 2: whatever failed in pass 1, once more at the end.
    for (let pass = 1; pass <= 2 && !dlStopFlag; pass++) {
      const todo = sortedDlList(state, dlList).filter((x) =>
        pass === 1 ? x.status === "pending" || x.status === "opening" : failedThisRun.has(x.jobId) && x.status === "failed"
      );
      for (const e of todo) {
        if (dlStopFlag) break;
        // The list may have changed since this pass started (e.g. Cancel pending).
        const cur = dlList.find((x) => x.jobId === e.jobId);
        if (!cur || cur.status === "cancelled" || cur.status === "done") continue;
        await listOp({ op: "set", jobId: e.jobId, patch: { status: "opening", note: pass === 2 ? "Second try…" : "" } });
        let res;
        try { res = await downloadEntry(e); } catch (err) { res = { ok: false, note: err.message }; }
        if (res.ok) failedThisRun.delete(e.jobId);
        else failedThisRun.add(e.jobId);
        await listOp({ op: "set", jobId: e.jobId, patch: { status: res.ok ? "done" : "failed", note: res.ok ? "" : res.note } });
        if (!dlStopFlag) await sleep(4000); // small gap between results
      }
    }
  } finally {
    dlRunning = false;
    renderDlList();
  }
}
$("dlRun").onclick = runDlList;
$("dlCancel").onclick = () => listOp({ op: "cancel" });
$("dlRetry").onclick = async () => {
  await listOp({ op: "retry" });
  runDlList(); // starts right away on the items that were just reset
};

// Retry one result now: go to its page at once, wait for the download button, then download.
async function retryNow(e) {
  if (dlRunning) return ($("dlListStatus").textContent = "Download all is running. Press Stop first, or wait for it to finish.");
  dlRunning = true;
  dlStopFlag = false;
  renderDlList();
  try {
    await listOp({ op: "set", jobId: e.jobId, patch: { status: "opening", note: "Opening the result page…" } });
    let res;
    try { res = await downloadEntry(e, { active: true, waitMs: 90000 }); } catch (err) { res = { ok: false, note: err.message }; }
    await listOp({ op: "set", jobId: e.jobId, patch: { status: res.ok ? "done" : "failed", note: res.ok ? "" : res.note } });
  } finally {
    dlRunning = false;
    renderDlList();
  }
}
$("dlStop").onclick = () => { dlStopFlag = true; $("dlListStatus").textContent = "Stopping after the current result…"; };
$("dlClearDone").onclick = () => listOp({ op: "clear", mode: "done" });
$("dlClearAll").onclick = () => { if (confirm("Remove everything from the download list?")) listOp({ op: "clear", mode: "all" }); };

chrome.storage.local.get("dlList", (d) => { dlList = d.dlList || []; renderDlList(); });
chrome.storage.onChanged.addListener((ch) => {
  if (ch.dlList) {
    dlList = ch.dlList.newValue || [];
    // A failed item from an earlier run becomes pending again when the user re-adds it (toggle creates a fresh entry).
    renderDlList();
  }
});

// ================= edit a prompt =================
// After editing, the old job / failure / download-list entries for this prompt are dropped and its marks reset,
// so it is a fresh prompt again (Assign + setup, Generate).
function savePromptEdit(cat, id, text) {
  const t = (text || "").trim();
  if (!t) return alert("The prompt can't be empty.");
  const p = cat.prompts.find((x) => x.id === id);
  p.text = t;
  for (const k of ["copied", "assigned", "downloaded"]) if (cat[k]) cat[k] = cat[k].filter((x) => x !== id);
  const ek = `${cat.id}:${id}`;
  editing.delete(ek);
  delete drafts[ek];
  save();
  chrome.runtime.sendMessage({ type: "promptreset", catId: cat.id, promptId: id, key: ek });
  render();
}

chrome.storage.local.get("unmatchedTarget", (d) => { unmatchedTarget = d.unmatchedTarget || null; render(); });
chrome.storage.onChanged.addListener((ch) => {
  if (ch.unmatchedTarget) { unmatchedTarget = ch.unmatchedTarget.newValue || null; render(); }
});


function deletePrompt(cat, id) {
  const p = cat.prompts.find((x) => x.id === id);
  if (!p || !confirm(`Delete prompt ${id}${p.title ? " (" + p.title + ")" : ""} from "${cat.name}"?`)) return;
  cat.prompts = cat.prompts.filter((x) => x.id !== id);
  for (const k of ["copied", "assigned", "downloaded"]) if (cat[k]) cat[k] = cat[k].filter((x) => x !== id);
  const ek = `${cat.id}:${id}`;
  editing.delete(ek);
  delete drafts[ek];
  save();
  chrome.runtime.sendMessage({ type: "promptreset", catId: cat.id, promptId: id, key: ek });
  render();
}

// Per-category auto setup: global (Setup tab) or its own settings.
function catSetupPanel(cat) {
  const box = document.createElement("div");
  box.className = "catset";
  const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
  const field = (label, input) => el("label", {}, label, input);
  const mode = el("select");
  mode.add(new Option("Global setup (Setup tab)", "global"));
  mode.add(new Option("Specific setup for this category", "specific"));
  mode.value = cat.setup ? "specific" : "global";
  const form = el("div", { className: "catform" });
  const status = el("div", { className: "hint" });
  const s = { ...DEFAULT_SETUP, ...(cat.setup || SETUP) };
  const model = el("input", { type: "text", value: s.model });
  const mk = (list, v) => { const sel = el("select"); for (const [val, lab] of list) sel.add(new Option(lab, val)); sel.value = v; return sel; };
  const dur = mk(SETUP_OPTIONS.duration, s.duration);
  const res = mk(SETUP_OPTIONS.resolution, s.resolution);
  const ratio = mk(SETUP_OPTIONS.ratio, s.ratio);
  const audio = el("input", { type: "checkbox", checked: s.audio });
  const imode = el("select");
  for (const [v, l] of [["", "Don't change"], ["First frame", "First frame"], ["First + last", "First + last"], ["Reference", "Reference"]]) imode.add(new Option(l, v));
  imode.value = s.imageMode;
  const inject = el("input", { type: "checkbox", checked: s.injectRefs });
  const sel = el("input", { type: "checkbox", checked: s.selectRefs });
  let refs = (s.refs || []).slice();
  const refsBox = el("div", { className: "mono" });
  const showRefs = () => (refsBox.textContent = refs.length ? refs.map((r, i) => `Image ${i + 1}: ${r.name || r.id}`).join("\n") : "No reference images saved.");
  showRefs();
  const capture = el("button", { textContent: "Capture from page" });
  capture.onclick = async () => {
    const tab = await findTab();
    if (!tab) return (status.textContent = "Open the axcel.cloud Image to Video page first.");
    try {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: pageReadRefs });
      if (!result.length) return (status.textContent = "No reference images found on that page.");
      refs = result; showRefs(); status.textContent = `Captured ${result.length} image(s). Press Save.`;
    } catch (e) { status.textContent = "Capture failed: " + e.message; }
  };
  const clear = el("button", { textContent: "Clear", onclick: () => { refs = []; showRefs(); } });
  const chk = (box_, text) => el("label", { className: "chk" }, box_, text);
  form.append(
    field("Model", model), field("Duration", dur), field("Resolution", res), field("Ratio", ratio),
    chk(audio, " Generate Audio on"), field("Image mode", imode),
    chk(inject, " Send these reference ids with every Generate request"),
    chk(sel, " (experimental) also click them in the site's library"),
    refsBox, el("div", { className: "row" }, capture, clear)
  );
  form.hidden = mode.value !== "specific";
  mode.onchange = () => (form.hidden = mode.value !== "specific");
  const saveBtn = el("button", { className: "primary", textContent: "Save" });
  saveBtn.onclick = () => {
    if (mode.value === "global") delete cat.setup;
    else cat.setup = {
      model: model.value.trim() || DEFAULT_SETUP.model, duration: dur.value, resolution: res.value, ratio: ratio.value,
      audio: audio.checked, imageMode: imode.value, selectRefs: sel.checked, injectRefs: inject.checked, refs,
    };
    openSet.delete(cat.id);
    save();
    render();
  };
  const closeBtn = el("button", { textContent: "Cancel", onclick: () => { openSet.delete(cat.id); render(); } });
  box.append(
    el("div", { className: "title" }, `Auto setup for "${cat.name}"`),
    el("div", { className: "hint" }, "Used by “Assign + setup” on this category's prompts."),
    field("Setup to use", mode), form, el("div", { className: "row" }, saveBtn, closeBtn), status
  );
  return box;
}
