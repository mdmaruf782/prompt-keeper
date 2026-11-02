// Runs in the page (MAIN world).
// 1) reports /api/jobs* responses the page itself receives (passive, for linking prompts to jobs)
(() => {
  const abs = (u) => new URL(u, location.href).href;
  const isJobs = (u) => /\/api\/jobs/.test(u);
  const post = (m) => window.postMessage(m, "*");
  const isGen = (u) => /\/api\/generate\b/.test(u);
  const rand = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  // Sent: remember which prompt this request carries. Done: its response (may arrive much later).
  const reportGenSent = (rid, body) => post({ __pscap: 6, rid, body: typeof body === "string" ? body : "" });
  const reportGen = (rid, body, status, text) => post({ __pscap: 5, rid, body: typeof body === "string" ? body : "", status, text });
  const reportJobs = (url, headers, text) => post({ __pscap: 2, url: abs(url), headers, text });
  // Saved reference ids (set by relay.js as a DOM attribute) are written into the form's own request.
  const patchBody = (url, method, body) => {
    try {
      if (typeof body !== "string" || method !== "POST" || !/\/api\/generate\b/.test(url)) return body;
      const cfg = JSON.parse(document.documentElement.getAttribute("data-ps-refs") || "null");
      if (!cfg?.ids?.length) return body;
      const o = JSON.parse(body);
      if (o.op !== "i2v") return body;
      const hasRefs = o.inputs && Array.isArray(o.inputs.refimg);
      if (!hasRefs && cfg.mode !== "Reference") return body;
      o.inputs = { ...(o.inputs || {}), refimg: cfg.ids };
      post({ __pscap: 4, n: cfg.ids.length });
      return JSON.stringify(o);
    } catch { return body; }
  };
  const toObj = (h) => {
    const o = {};
    if (!h) return o;
    if (h instanceof Headers) h.forEach((v, k) => (o[k] = v));
    else if (Array.isArray(h)) h.forEach(([k, v]) => (o[k.toLowerCase()] = v));
    else Object.keys(h).forEach((k) => (o[k.toLowerCase()] = h[k]));
    return o;
  };

  setTimeout(() => post({ __pscap: 3 }), 0); // proves the MAIN-world hook is running

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    let url = "", headers = {};
    try {
      const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
      url = input instanceof Request ? input.url : String(input);
      headers = toObj(init?.headers || (input instanceof Request ? input.headers : null));
    } catch {}
    if (init && typeof init.body === "string") init = { ...init, body: patchBody(url, (init.method || "GET").toUpperCase(), init.body) };
    let rid = null;
    if (isGen(url) && (init?.method || "GET").toUpperCase() === "POST") {
      rid = rand();
      reportGenSent(rid, init.body);
    }
    const p = origFetch.call(this, input, init);
    try {
      if (isJobs(url)) p.then((r) => r.clone().text().then((t) => reportJobs(url, headers, t))).catch(() => {});
      if (rid) p.then((r) => r.clone().text().then((t) => reportGen(rid, init.body, r.status, t))).catch(() => {});
    } catch {}
    return p;
  };

  const X = XMLHttpRequest.prototype;
  const open = X.open, setH = X.setRequestHeader, send = X.send;
  X.open = function (m, u) { this.__ps = { m: String(m).toUpperCase(), u, h: {} }; return open.apply(this, arguments); };
  X.setRequestHeader = function (k, v) { if (this.__ps) this.__ps.h[k.toLowerCase()] = v; return setH.apply(this, arguments); };
  X.send = function (body) {
    const ps = this.__ps;
    try {
      if (ps && isJobs(String(ps.u))) {
        this.addEventListener("load", () => {
          try {
            const t = this.responseType === "" || this.responseType === "text" ? this.responseText : JSON.stringify(this.response);
            reportJobs(ps.u, ps.h, t);
          } catch {}
        });
      }
    } catch {}
    const sent = ps ? patchBody(abs(ps.u), ps.m, body) : body;
    try {
      if (ps && ps.m === "POST" && isGen(abs(ps.u))) {
        const rid = rand();
        reportGenSent(rid, sent);
        this.addEventListener("load", () => {
          try {
            const t = this.responseType === "" || this.responseType === "text" ? this.responseText : JSON.stringify(this.response);
            reportGen(rid, sent, this.status, t);
          } catch {}
        });
      }
    } catch {}
    return send.call(this, sent);
  };
})();
