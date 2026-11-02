// Isolated world: forwards page-reported data to the background.
try { chrome.runtime.sendMessage({ type: "diag", key: "relayAt" }); } catch {}
window.addEventListener("message", (e) => {
  if (e.source !== window) return;
  const d = e.data;
  try {
    if (d?.__pscap === 5) {
      chrome.runtime.sendMessage({ type: "gen-seen", rid: d.rid, body: d.body, status: d.status, text: d.text });
    } else if (d?.__pscap === 6) {
      chrome.runtime.sendMessage({ type: "gen-sent", rid: d.rid, body: d.body });
    } else if (d?.__pscap === 4) {
      chrome.runtime.sendMessage({ type: "diag", key: "injectAt", n: d.n });
    } else if (d?.__pscap === 3) {
      chrome.runtime.sendMessage({ type: "diag", key: "hookAt" });
    } else if (d?.__pscap === 2) {
      chrome.runtime.sendMessage({ type: "jobs-seen", url: d.url, headers: d.headers, text: d.text });
    }
  } catch {}
});

// Expose the saved reference ids to the page-side hook via a DOM attribute.
function pushRefs(setup) {
  const el = document.documentElement;
  if (setup && setup.injectRefs && setup.refs?.length)
    el.setAttribute("data-ps-refs", JSON.stringify({ ids: setup.refs.map((x) => x.id), mode: setup.imageMode }));
  else el.removeAttribute("data-ps-refs");
}
try {
  // activeSetup = the setup last applied on the page (global or a category's own); else the global one.
  const refresh = () => chrome.storage.local.get(["setup", "activeSetup"], (d) => pushRefs(d.activeSetup || d.setup));
  refresh();
  chrome.storage.onChanged.addListener((ch) => { if (ch.setup || ch.activeSetup) refresh(); });
} catch {}
