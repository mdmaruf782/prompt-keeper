chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

const store = (k) => chrome.storage.local.get(k);

// ---- messages ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "genfailed" || msg.type === "promptreset") {
    jobChain = jobChain.then(() => handleMarks(msg)).catch(() => {});
    return;
  }
  if (msg.type === "dllist") {
    listOp(msg).then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "jobmap-merge") {
    jobChain = jobChain
      .then(async () => {
        const { jobMap = {} } = await store("jobMap");
        Object.assign(jobMap, msg.entries);
        await chrome.storage.local.set({ jobMap });
      })
      .catch(() => {})
      .then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "dl-register") {
    // Answer only after the name is stored, so the page's download can't beat it.
    dlLock(() => registerDownload(msg.jobId, msg.name)).then(() => sendResponse(true));
    return true;
  }
  if (msg.type === "jobs-seen") onJobsSeen(msg);
  if (msg.type === "gen-sent") { jobChain = jobChain.then(() => handleGenSent(msg)).catch(() => {}); }
  if (msg.type === "gen-seen") { jobChain = jobChain.then(() => handleGen(msg)).catch(() => {}); }
  if (msg.type === "diag") setDiag({ [msg.key]: Date.now(), ...(msg.n != null ? { injectN: msg.n } : {}) });
});

// ---- job tracking ----
const safeJson = (t) => { try { return JSON.parse(t); } catch { return null; } };
function findJobId(o) {
  if (!o || typeof o !== "object") return null;
  for (const [k, v] of Object.entries(o)) {
    if (typeof v === "string" && (/^job_?id$/i.test(k) || (k === "id" && v.startsWith("job_")))) return v;
  }
  for (const v of Object.values(o)) { const r = findJobId(v); if (r) return r; }
  return null;
}
// Passive only: reads what the page itself received from /api/jobs*. Sends nothing.
async function setDiag(patch) {
  const { diag } = await store("diag");
  await chrome.storage.local.set({ diag: { ...diag, ...patch } });
}

async function onJobsSeen(m) {
  const data = safeJson(m.text);
  const n = Array.isArray(data?.items) ? data.items.length : null;
  await setDiag({ jobsAt: Date.now(), jobsUrl: new URL(m.url).pathname, jobsCount: n, jobsParsed: !!data });

}

// ---- downloads: rename each axcel.cloud download by its job id ----
// The site's file is named "axcel-job_<id>.mp4", so the job id in the filename tells us which result it is,
// even with several result tabs downloading at once.
let dlChain = Promise.resolve();
const dlLock = (fn) => (dlChain = dlChain.then(fn, fn));
const JOB_RE = /job_[0-9a-f]+/i;

async function registerDownload(jobId, name) {
  const { dlJobs = {} } = await store("dlJobs");
  const now = Date.now();
  for (const k of Object.keys(dlJobs)) if (now - dlJobs[k].at > 600000) delete dlJobs[k];
  dlJobs[jobId.toLowerCase()] = { name, at: now };
  await chrome.storage.local.set({ dlJobs });
}

// Describes a download URL (kind, host, type) with the query string hidden.
function describeUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "blob:" || x.protocol === "data:"
      ? `${x.protocol}${x.protocol === "blob:" ? x.pathname.split("/").slice(0, 3).join("/") : ""} (not a normal URL)`
      : `${x.origin}${x.pathname}${x.search ? ` ?(${x.search.length - 1} chars hidden)` : ""}`;
  } catch { return String(u).slice(0, 60); }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  let answered = false;
  const answer = (arg) => { if (!answered) { answered = true; arg ? suggest(arg) : suggest(); } };
  dlLock(async () => {
    const { dlJobs = {}, dlPending } = await store(["dlJobs", "dlPending"]);
    const jobId = (item.filename.match(JOB_RE) || [])[0]?.toLowerCase();
    let name = null;
    if (jobId && dlJobs[jobId]) {
      name = dlJobs[jobId].name;
      delete dlJobs[jobId];
      await chrome.storage.local.set({ dlJobs });
    } else if (!jobId && dlPending && Date.now() - dlPending.at < 30000) {
      // No job id in the file name: fall back to the single "next download" slot.
      name = dlPending.name;
      await chrome.storage.local.remove("dlPending");
    }
    const ext = (item.filename.match(/\.[A-Za-z0-9]{1,5}$/) || [".mp4"])[0];
    const filename = name ? name + ext : null;
    await chrome.storage.local.set({
      lastDownloadInfo: {
        at: Date.now(),
        url: describeUrl(item.url),
        finalUrl: item.finalUrl && item.finalUrl !== item.url ? describeUrl(item.finalUrl) : "",
        mime: item.mime || "",
        filename: item.filename,
        jobId: jobId || "",
        renamedTo: filename || "",
      },
    });
    if (filename) {
      await chrome.storage.local.set({ lastDownload: { name: filename, at: Date.now() } });
      answer({ filename, conflictAction: "uniquify" });
    } else answer();
  }).catch(() => answer());
  return true;
});

// ---- tie each Generate's job id to the prompt that was sent ----
// jobMap     = { "<catId>:<promptId>": { jobId, at } }   result, own storage key so the side panel's saves can't overwrite it
// genPending = { "<rid>": { key, at } }                  requests sent, still waiting for their response (job id)
let jobChain = Promise.resolve();
const normKey = (t) => String(t || "").replace(/[\s"'“”‘’]+/g, "");

// Which stored prompt does this request body carry? Decided when the request is SENT.
async function resolvePrompt(bodyText) {
  const { state, assignedLast, jobMap = {}, genPending = {} } = await store(["state", "assignedLast", "jobMap", "genPending"]);
  const all = [];
  for (const pr of state?.projects || []) for (const c of pr.categories) for (const p of c.prompts) all.push({ cat: c, p });
  const isLast = ({ cat, p }) => assignedLast && assignedLast.catId === cat.id && assignedLast.promptId === p.id;
  const sentPrompt = safeJson(bodyText)?.prompt;
  if (sentPrompt) {
    const same = all.filter(({ p }) => normKey(p.text) === normKey(sentPrompt));
    const waiting = new Set(Object.values(genPending).map((x) => x.key));
    return same.find(isLast) || same.find(({ cat, p }) => !jobMap[`${cat.id}:${p.id}`] && !waiting.has(`${cat.id}:${p.id}`)) || same[0] || null;
  }
  // Request body not readable: trust the prompt that was assigned last, as of now.
  return (assignedLast && Date.now() - assignedLast.at < 30 * 60000 && all.find(isLast)) || null;
}

async function handleGenSent(m) {
  const hit = await resolvePrompt(m.body);
  const now = Date.now();
  if (!hit) return setDiag({ genAt: now, genNote: "Generate sent, but its prompt matches none of your prompts" });
  const { genPending = {} } = await store("genPending");
  for (const k of Object.keys(genPending)) if (now - genPending[k].at > 15 * 60000) delete genPending[k];
  genPending[m.rid] = { key: `${hit.cat.id}:${hit.p.id}`, at: now };
  await chrome.storage.local.set({ genPending });
  await setDiag({ genAt: now, genNote: `waiting for job id -> ${hit.cat.name} #${hit.p.id}` });
}

async function handleGen(m) {
  const now = Date.now();
  const { genPending = {}, jobMap = {} } = await store(["genPending", "jobMap"]);
  const pending = genPending[m.rid];
  delete genPending[m.rid];
  await chrome.storage.local.set({ genPending });

  const jobId = m.status >= 200 && m.status < 300 ? findJobId(safeJson(m.text)) : null;
  if (!jobId) return setDiag({ genAt: now, genNote: `Generate response ${m.status}, no job id found` });

  let key = pending?.key;
  if (!key) {
    // Never saw the request being sent (e.g. page loaded mid-flight): decide from the response's request body.
    const hit = await resolvePrompt(m.body);
    key = hit && `${hit.cat.id}:${hit.p.id}`;
  }
  if (!key) return setDiag({ genAt: now, genNote: `${jobId}: the sent prompt matches none of your prompts` });

  jobMap[key] = { jobId, at: now };
  await chrome.storage.local.set({ jobMap });
  await setDiag({ genAt: now, genNote: `${jobId} -> ${key}` });
}

// ---- download list: cards the user added on the History page ----
// dlList = [{ jobId, projectId, catId, promptId, at, status: pending|opening|done|failed, note }]
function listOp(msg) {
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  jobChain = jobChain
    .then(async () => {
      const { dlList = [], jobMap = {}, state } = await store(["dlList", "jobMap", "state"]);
      let list = dlList;
      if (msg.op === "toggle") {
        const e = msg.entry;
        if (list.some((x) => same(x.jobId, e.jobId))) list = list.filter((x) => !same(x.jobId, e.jobId));
        else if (e.unmatched) {
          // A result whose prompt is not in the lists: numbered by the EPISODE number in its text, else 1, 2, 3...
          if (e.serial != null) list = list.filter((x) => !(x.unmatched && x.catId === e.catId && x.serial === e.serial));
          else {
            // Start after the category's own prompts so these never share a number with one of them.
            const cat = (state?.projects || []).flatMap((p) => p.categories).find((c) => c.id === e.catId);
            e.serial = Math.max(cat ? cat.prompts.length : 0, ...list.filter((x) => x.unmatched && x.catId === e.catId).map((x) => x.serial || 0)) + 1;
          }
          list.push({ ...e, at: Date.now(), status: "pending", note: "" });
        } else {
          // One result per prompt: a newer card for the same prompt replaces the older one.
          list = list.filter((x) => !(x.catId === e.catId && x.promptId === e.promptId));
          list.push({ ...e, at: Date.now(), status: "pending", note: "" });
          jobMap[`${e.catId}:${e.promptId}`] = { jobId: e.jobId, at: Date.now() };
          await chrome.storage.local.set({ jobMap });
        }
      } else if (msg.op === "set") {
        const x = list.find((y) => same(y.jobId, msg.jobId));
        if (x) Object.assign(x, msg.patch);
      } else if (msg.op === "cancel") {
        for (const x of list) {
          if (x.status === "pending") { x.status = "cancelled"; x.note = ""; }
        }
      } else if (msg.op === "retry") {
        // One item, or every failed/cancelled one (and any left "opening" by a run that was cut off).
        for (const x of list) {
          if (msg.jobId ? same(x.jobId, msg.jobId) : ["failed", "cancelled", "opening"].includes(x.status)) {
            x.status = "pending";
            x.note = "";
          }
        }
      } else if (msg.op === "remove") {
        list = list.filter((x) => !same(x.jobId, msg.jobId));
      } else if (msg.op === "clear") {
        list = msg.mode === "done" ? list.filter((x) => x.status !== "done") : [];
      }
      await chrome.storage.local.set({ dlList: list });
    })
    .catch(() => {});
  return jobChain;
}

// ---- failed generations and edited prompts ----
// genFailed = { "<catId>:<promptId>": { jobId, reason, at } }  set from the History page, cleared when a good result shows up
async function handleMarks(msg) {
  const { genFailed = {}, jobMap = {}, dlList = [], genPending = {} } = await store(["genFailed", "jobMap", "dlList", "genPending"]);
  if (msg.type === "genfailed") {
    for (const f of msg.fail || []) genFailed[f.key] = { jobId: f.jobId, reason: f.reason, at: Date.now() };
    for (const k of msg.clear || []) delete genFailed[k];
    await chrome.storage.local.set({ genFailed });
    return;
  }
  // promptreset: the prompt text was edited, so the old job/failure/download entries no longer describe it.
  delete genFailed[msg.key];
  delete jobMap[msg.key];
  for (const k of Object.keys(genPending)) if (genPending[k].key === msg.key) delete genPending[k];
  await chrome.storage.local.set({
    genFailed, jobMap, genPending,
    dlList: dlList.filter((x) => !(x.catId === msg.catId && x.promptId === msg.promptId)),
  });
}
