/**
 * Self-contained single-page dashboard. Vanilla HTML/CSS/JS — no framework,
 * no CDN, no telemetry. Auth is the same X-Pebble-Token used by /ingest;
 * the user types it once and it's kept in localStorage on this device.
 */
export function dashboardHtml(): string {
  return HTML;
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="referrer" content="no-referrer" />
  <title>Pebble</title>
  <style>
    :root {
      --bg: #0f1115;
      --panel: #161922;
      --panel-2: #1d2230;
      --text: #e6e9ef;
      --muted: #9aa3b2;
      --accent: #7aa2f7;
      --accent-2: #9ece6a;
      --warn: #e0af68;
      --danger: #f7768e;
      --border: #262b38;
    }
    @media (prefers-color-scheme: light) {
      :root {
        --bg: #fafbfc; --panel: #fff; --panel-2: #f3f5f8;
        --text: #1c2230; --muted: #5d6675; --accent: #2c5cff;
        --accent-2: #2ea043; --warn: #b76b00; --danger: #cf222e;
        --border: #e3e6ec;
      }
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; }
    a { color: var(--accent); text-decoration: none; }
    button, input, textarea, select {
      font: inherit; color: inherit; background: var(--panel-2);
      border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px;
    }
    button { cursor: pointer; }
    button.primary { background: var(--accent); color: white; border-color: transparent; }
    button.ghost { background: transparent; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    header { padding: 14px 22px; border-bottom: 1px solid var(--border); display: flex; align-items: center; gap: 16px; }
    header h1 { font-size: 16px; margin: 0; letter-spacing: 0.4px; }
    header .meta { color: var(--muted); font-size: 12px; }
    nav { display: flex; gap: 4px; margin-left: auto; }
    nav button { background: transparent; border: 0; padding: 6px 10px; border-radius: 6px; color: var(--muted); }
    nav button.active { background: var(--panel-2); color: var(--text); }

    main { max-width: 1100px; margin: 0 auto; padding: 22px; display: grid; gap: 16px; }
    .card { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 16px; }
    .card h2 { margin: 0 0 8px; font-size: 14px; color: var(--muted); font-weight: 500; letter-spacing: 0.5px; text-transform: uppercase; }

    .row { display: grid; grid-template-columns: 110px 1fr auto; gap: 12px; align-items: center; padding: 10px 8px; border-bottom: 1px solid var(--border); cursor: pointer; }
    .row:last-child { border-bottom: 0; }
    .row:hover { background: var(--panel-2); }
    .row .who { color: var(--muted); font-size: 12px; }
    .row .preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pill { display: inline-block; padding: 2px 8px; font-size: 11px; border-radius: 999px; background: var(--panel-2); color: var(--muted); border: 1px solid var(--border); }
    .pill.raw { color: var(--muted); }
    .pill.triaged { color: var(--warn); border-color: var(--warn); }
    .pill.filed { color: var(--accent-2); border-color: var(--accent-2); }
    .pill.linked { color: var(--accent); border-color: var(--accent); }

    details { background: var(--panel-2); border-radius: 8px; padding: 8px 12px; margin: 6px 0; }
    details > summary { cursor: pointer; outline: none; }
    .detail { display: grid; gap: 8px; padding: 8px 0; }
    .detail .actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .kv { display: grid; grid-template-columns: 130px 1fr; gap: 4px 12px; font-size: 13px; }
    .kv .k { color: var(--muted); }
    pre { background: var(--bg); border: 1px solid var(--border); padding: 8px 10px; border-radius: 6px; overflow-x: auto; font-size: 12.5px; }
    .toolbar { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .toolbar input[type=text] { flex: 1; min-width: 160px; }
    .toast { position: fixed; bottom: 20px; right: 20px; background: var(--panel); border: 1px solid var(--border); padding: 10px 14px; border-radius: 8px; box-shadow: 0 4px 18px rgba(0,0,0,0.25); }
    .toast.err { border-color: var(--danger); color: var(--danger); }
    .login { max-width: 420px; margin: 80px auto; }
    .login p { color: var(--muted); }
  </style>
</head>
<body>
<div id="root"></div>

<script>
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const h = (tag, attrs = {}, ...children) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k === "html") el.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
};

const TOKEN_KEY = "pebble_token";
let token = localStorage.getItem(TOKEN_KEY) || "";
let view = "inbox"; // inbox | search | send

function toast(msg, kind = "ok") {
  const t = h("div", { class: "toast " + (kind === "err" ? "err" : "") }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

async function api(path, init = {}) {
  init.headers = Object.assign({ "x-pebble-token": token }, init.headers || {});
  if (init.body && typeof init.body !== "string") {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(init.body);
  }
  const res = await fetch(path, init);
  if (res.status === 401) {
    token = "";
    localStorage.removeItem(TOKEN_KEY);
    render();
    throw new Error("unauthorized");
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || res.statusText);
  }
  const ct = res.headers.get("content-type") || "";
  return ct.includes("json") ? res.json() : res.text();
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleString();
}

function preview(s, n = 100) {
  const t = (s || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// --- Login screen ------------------------------------------------------
function renderLogin() {
  const root = $("#root");
  root.innerHTML = "";
  const input = h("input", { type: "password", placeholder: "X-Pebble-Token", style: "width:100%;padding:10px" });
  const btn = h("button", { class: "primary", onclick: async () => {
    token = input.value.trim();
    if (!token) return;
    try {
      await api("/api/config");
      localStorage.setItem(TOKEN_KEY, token);
      render();
    } catch (e) {
      toast("Invalid token", "err");
    }
  }}, "Open dashboard");
  root.append(
    h("div", { class: "login card" },
      h("h1", {}, "Pebble"),
      h("p", {}, "Enter the same token you set as PEBBLE_INGEST_SECRET. It is stored only in this browser."),
      input,
      h("div", { style: "margin-top:12px" }, btn),
    ),
  );
  input.focus();
}

// --- App shell ---------------------------------------------------------
function renderShell(content, cfg) {
  const root = $("#root");
  root.innerHTML = "";
  root.append(
    h("header", {},
      h("h1", {}, "Pebble"),
      h("span", { class: "meta" }, "vault: ", cfg.vault_path),
      h("span", { class: "meta" }, " · provider: ", cfg.triage_provider),
      h("nav", {},
        navBtn("inbox", "Inbox"),
        navBtn("search", "Search"),
        navBtn("send", "Send"),
        h("button", { onclick: () => { localStorage.removeItem(TOKEN_KEY); token = ""; render(); }, title: "Forget token on this device" }, "Sign out"),
      ),
    ),
    h("main", {}, content),
  );
}

function navBtn(name, label) {
  return h("button", {
    class: view === name ? "active" : "",
    onclick: () => { view = name; render(); },
  }, label);
}

// --- Inbox -------------------------------------------------------------
async function renderInbox() {
  const cfg = await api("/api/config");
  const data = await api("/api/recent?limit=50");
  const list = h("div", { class: "card" }, h("h2", {}, "Recent ingestions"));
  if (!data.items.length) list.append(h("p", { style: "color:var(--muted)" }, "(nothing yet — send a message)"));
  for (const it of data.items) list.append(rowFor(it));
  renderShell(list, cfg);
}

function rowFor(item) {
  const summary = h("div", { class: "row" },
    h("div", { class: "who" }, fmtDate(item.received_at)),
    h("div", {},
      h("div", { class: "preview" }, item.sender + ": ", preview(item.text, 90)),
      h("div", { style: "margin-top:4px" }, h("span", { class: "pill " + item.status }, item.status), " ",
        item.triage ? h("span", { class: "pill" }, item.triage.type + " · " + item.triage.urgency) : null),
    ),
    h("div", { class: "who" }, item.source),
  );
  const details = h("details", {});
  const body = h("div", { class: "detail" });
  details.append(h("summary", { html: "&nbsp;" }, ));
  // expand on click anywhere in the row
  summary.addEventListener("click", (ev) => {
    ev.stopPropagation();
    details.open = !details.open;
    if (details.open) populateDetail(item, body);
  });
  details.append(body);
  const wrap = h("div", {}, summary, details);
  return wrap;
}

async function populateDetail(item, body) {
  body.innerHTML = "";
  body.append(
    h("div", { class: "kv" },
      h("div", { class: "k" }, "id"), h("div", {}, item.id),
      h("div", { class: "k" }, "thread"), h("div", {}, item.thread_id),
      h("div", { class: "k" }, "received"), h("div", {}, fmtDate(item.received_at)),
      h("div", { class: "k" }, "status"), h("div", {}, item.status),
    ),
    h("h3", { style: "margin:8px 0 4px;font-size:13px;color:var(--muted)" }, "TEXT"),
    h("pre", {}, item.text || "(empty)"),
  );

  if (item.triage) body.append(triagePanel(item));

  const actions = h("div", { class: "actions" });
  if (item.status === "raw") {
    actions.append(actBtn("Triage", async () => {
      const r = await api("/api/ingestions/" + encodeURIComponent(item.id) + "/triage", { method: "POST" });
      item.status = "triaged"; item.triage = r.triage; populateDetail(item, body); toast("Triaged");
    }));
  }
  if (item.status === "triaged" && item.triage) {
    const folderInput = h("input", { type: "text", value: item.triage.suggested_folder, style: "width:160px" });
    actions.append(folderInput);
    actions.append(actBtn("File here", async () => {
      const r = await api("/api/ingestions/" + encodeURIComponent(item.id) + "/file", {
        method: "POST",
        body: { folder: folderInput.value.trim() || item.triage.suggested_folder },
      });
      item.status = "filed"; populateDetail(item, body); toast("Filed → " + r.filed_path);
    }));
  }
  if (item.status !== "raw") {
    actions.append(actBtn("Re-triage", async () => {
      const r = await api("/api/ingestions/" + encodeURIComponent(item.id) + "/triage", { method: "POST" });
      item.triage = r.triage; populateDetail(item, body); toast("Re-triaged");
    }, "ghost"));
  }
  body.append(actions);
}

function triagePanel(item) {
  const t = item.triage;
  return h("div", { class: "card", style: "background:var(--panel-2)" },
    h("h2", {}, "Triage"),
    h("div", { class: "kv" },
      h("div", { class: "k" }, "type"), h("div", {}, t.type),
      h("div", { class: "k" }, "urgency"), h("div", {}, t.urgency),
      h("div", { class: "k" }, "folder"), h("div", {}, t.suggested_folder),
      h("div", { class: "k" }, "tags"), h("div", {}, (t.suggested_tags || []).join(" · ") || "—"),
      h("div", { class: "k" }, "is_task"), h("div", {}, String(t.is_task)),
      h("div", { class: "k" }, "confidence"), h("div", {}, String(t.agent_confidence)),
      t.rationale ? h("div", { class: "k" }, "rationale") : null,
      t.rationale ? h("div", {}, t.rationale) : null,
    ),
  );
}

function actBtn(label, fn, cls = "primary") {
  return h("button", { class: cls, onclick: async (ev) => {
    ev.target.disabled = true;
    try { await fn(); }
    catch (e) { toast(e.message, "err"); }
    finally { ev.target.disabled = false; }
  }}, label);
}

// --- Search ------------------------------------------------------------
async function renderSearch() {
  const cfg = await api("/api/config");
  const input = h("input", { type: "text", placeholder: "FTS5 query (e.g., domain OR \"renew\")" });
  const results = h("div", {});
  const submit = async () => {
    results.innerHTML = "";
    const q = input.value.trim();
    if (!q) return;
    try {
      const data = await api("/api/search?q=" + encodeURIComponent(q));
      if (!data.hits.length) results.append(h("p", { style: "color:var(--muted)" }, "(no hits)"));
      for (const hit of data.hits) {
        results.append(
          h("div", { class: "row" },
            h("div", { class: "who" }, hit.title || ""),
            h("div", { html: hit.snippet || "" }),
            h("div", { class: "who" }, hit.path.split("/").slice(-2).join("/")),
          ),
        );
      }
    } catch (e) { toast(e.message, "err"); }
  };
  input.addEventListener("keydown", (ev) => { if (ev.key === "Enter") submit(); });
  const btn = h("button", { class: "primary", onclick: submit }, "Search");
  const card = h("div", { class: "card" },
    h("h2", {}, "Search vault (FTS5)"),
    h("div", { class: "toolbar" }, input, btn),
    results,
  );
  renderShell(card, cfg);
  input.focus();
}

// --- Send --------------------------------------------------------------
async function renderSend() {
  const cfg = await api("/api/config");
  const text = h("textarea", { rows: 6, style: "width:100%" });
  const sender = h("input", { type: "text", placeholder: "sender", value: "self" });
  const thread = h("input", { type: "text", placeholder: "thread_id", value: "manual" });
  const source = h("select", {},
    h("option", { value: "manual" }, "manual"),
    h("option", { value: "imessage" }, "imessage"),
    h("option", { value: "sms" }, "sms"),
    h("option", { value: "shortcut" }, "shortcut"),
  );
  const submit = async () => {
    const t = text.value.trim();
    if (!t) return toast("nothing to send", "err");
    try {
      const r = await api("/ingest", {
        method: "POST",
        body: {
          source: source.value,
          sender: sender.value || "self",
          thread_id: thread.value || "manual",
          text: t,
          timestamp: new Date().toISOString(),
        },
      });
      toast("Ingested " + r.id);
      text.value = "";
      view = "inbox";
      render();
    } catch (e) { toast(e.message, "err"); }
  };
  const card = h("div", { class: "card" },
    h("h2", {}, "Send to Pebble"),
    h("div", { style: "display:grid;gap:8px" },
      h("div", { class: "toolbar" }, sender, thread, source),
      text,
      h("div", {}, h("button", { class: "primary", onclick: submit }, "Send")),
    ),
  );
  renderShell(card, cfg);
  text.focus();
}

// --- Router ------------------------------------------------------------
async function render() {
  if (!token) { renderLogin(); return; }
  try {
    if (view === "inbox") return await renderInbox();
    if (view === "search") return await renderSearch();
    if (view === "send") return await renderSend();
  } catch (e) {
    if (e.message !== "unauthorized") toast(e.message, "err");
  }
}

render();
</script>
</body>
</html>`;
