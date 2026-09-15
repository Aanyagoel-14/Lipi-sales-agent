/*
 * Lipi AI website chat widget.
 *
 * This is the entire client half of Req 1 (autonomous website-visitor
 * engagement). It is loaded on a THIRD-PARTY origin (the operator's own
 * site), so it deliberately:
 *
 *   - never assumes cookies work (third-party/embedded contexts routinely
 *     block them) — identity is a `visitorId` this script mints itself and
 *     keeps in `localStorage`, sent explicitly on every call;
 *   - never imports anything or bundles a framework — it is a single
 *     dependency-free <script> so it cannot break the host page's own build;
 *   - fails silently rather than throwing into the host page's console/error
 *     tracking for problems that are ours to fix, not theirs.
 *
 * The workspaceId a widget talks to is read from the script tag's own
 * `data-workspace` attribute and its own `src`, so the same file is served
 * to every workspace — nothing here is workspace-specific except that one
 * attribute. See channels/view.ts `widgetSnippetFor` for the tag this
 * expects:
 *
 *   <script src=".../static/widget.js" data-workspace="wsp_xxx" async></script>
 *
 * WHY the visitorId is a trust boundary, not a login (Req 1 + Req 3 note):
 * clearing localStorage, or opening a private window, simply starts a new,
 * unrelated visitor row server-side (a fresh `VisitorSession`, and if they
 * message, a fresh `Customer`). That is an accepted, deliberate limitation
 * of an anonymous-visitor widget with no signup step — the alternative
 * (forcing an email before chat) would defeat the "autonomous engagement"
 * requirement this widget exists to satisfy.
 */
(function () {
  "use strict";

  var CURRENT_SCRIPT = document.currentScript;
  if (!CURRENT_SCRIPT) return;

  var WORKSPACE_ID = CURRENT_SCRIPT.getAttribute("data-workspace");
  if (!WORKSPACE_ID) {
    console.warn("[lipi-widget] missing data-workspace attribute, widget not started");
    return;
  }

  // Derive the API origin from the script's own src, so this file works
  // identically in local dev, staging and production without a build step.
  var API_ORIGIN;
  try {
    API_ORIGIN = new URL(CURRENT_SCRIPT.src).origin;
  } catch {
    return;
  }

  var STORAGE_KEY = "lipi_visitor_id";
  var CONVO_KEY = "lipi_conversation_id_" + WORKSPACE_ID;
  var POLL_MS = 4000;

  // ---------------------------------------------------------- visitor id
  function mintId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    // Fallback for older embedded webviews without crypto.randomUUID.
    return "vis-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function getVisitorId() {
    try {
      var existing = window.localStorage.getItem(STORAGE_KEY);
      if (existing) return existing;
      var fresh = mintId();
      window.localStorage.setItem(STORAGE_KEY, fresh);
      return fresh;
    } catch {
      // Storage blocked (private mode, embedded iframe policy, etc): fall
      // back to an in-memory id for this page view only. Attribution and
      // history simply do not persist across reloads in that case.
      return mintId();
    }
  }

  var visitorId = getVisitorId();

  function getConversationId() {
    try { return window.sessionStorage.getItem(CONVO_KEY); } catch { return null; }
  }
  function setConversationId(id) {
    try { window.sessionStorage.setItem(CONVO_KEY, id); } catch { /* non-fatal */ }
  }

  // -------------------------------------------------------- first touch
  // Read once, at load, because this is the only moment these query
  // parameters are still on the URL (Req 3: first-touch attribution).
  function readTouch() {
    var params = new URLSearchParams(window.location.search);
    return {
      utmSource: params.get("utm_source"),
      utmMedium: params.get("utm_medium"),
      utmCampaign: params.get("utm_campaign"),
      utmTerm: params.get("utm_term"),
      utmContent: params.get("utm_content"),
      // First non-null ad click id across the three networks this app
      // recognises. A page can only have arrived from one paid click, so
      // taking the first present one is correct rather than lossy.
      adClickId: params.get("gclid") || params.get("fbclid") || params.get("msclkid") || null,
      landingPage: window.location.href,
      referrer: document.referrer || null,
    };
  }

  // -------------------------------------------------------------- fetch
  function api(path, options) {
    return fetch(API_ORIGIN + path, Object.assign({
      headers: { "Content-Type": "application/json" },
    }, options)).then(function (res) {
      if (!res.ok) throw new Error("request failed: " + res.status);
      return res.json();
    });
  }

  // ------------------------------------------------------------ styles
  var STYLE = ""
    + "#lipi-widget-launcher{position:fixed;bottom:20px;right:20px;width:56px;height:56px;"
    + "border-radius:50%;background:#6b3fd4;color:#fff;border:none;cursor:pointer;"
    + "box-shadow:0 6px 20px rgba(0,0,0,.2);z-index:2147483000;font-size:24px;line-height:56px;"
    + "text-align:center;padding:0}"
    + "#lipi-widget-panel{position:fixed;bottom:88px;right:20px;width:340px;max-width:92vw;"
    + "height:460px;max-height:75vh;background:#fff;border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.25);"
    + "display:none;flex-direction:column;overflow:hidden;z-index:2147483000;"
    + "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}"
    + "#lipi-widget-panel.lipi-open{display:flex}"
    + "#lipi-widget-header{background:#6b3fd4;color:#fff;padding:14px 16px;font-size:14px;font-weight:600}"
    + "#lipi-widget-messages{flex:1;overflow-y:auto;padding:12px;background:#f7f6fb}"
    + "#lipi-widget-messages .lipi-msg{max-width:80%;margin:6px 0;padding:8px 12px;border-radius:12px;"
    + "font-size:13px;line-height:1.4;white-space:pre-wrap;word-break:break-word}"
    + "#lipi-widget-messages .lipi-visitor{margin-left:auto;background:#6b3fd4;color:#fff;"
    + "border-bottom-right-radius:2px}"
    + "#lipi-widget-messages .lipi-agent{margin-right:auto;background:#eee;color:#1a1a1a;"
    + "border-bottom-left-radius:2px}"
    + "#lipi-widget-form{display:flex;border-top:1px solid #eee;padding:8px}"
    + "#lipi-widget-input{flex:1;border:none;outline:none;font-size:13px;padding:8px}"
    + "#lipi-widget-send{border:none;background:#6b3fd4;color:#fff;border-radius:8px;padding:0 14px;"
    + "font-size:13px;cursor:pointer}"
    + "#lipi-widget-send:disabled{opacity:.5;cursor:default}";

  function injectStyle() {
    var tag = document.createElement("style");
    tag.textContent = STYLE;
    document.head.appendChild(tag);
  }

  // --------------------------------------------------------------- DOM
  var launcher, panel, messagesEl, form, input, sendBtn;

  function buildDom() {
    launcher = document.createElement("button");
    launcher.id = "lipi-widget-launcher";
    launcher.setAttribute("aria-label", "Open chat");
    launcher.textContent = "💬";

    panel = document.createElement("div");
    panel.id = "lipi-widget-panel";

    var header = document.createElement("div");
    header.id = "lipi-widget-header";
    header.textContent = "Chat with us";

    messagesEl = document.createElement("div");
    messagesEl.id = "lipi-widget-messages";

    form = document.createElement("form");
    form.id = "lipi-widget-form";

    input = document.createElement("input");
    input.id = "lipi-widget-input";
    input.type = "text";
    input.placeholder = "Type a message…";
    input.autocomplete = "off";

    sendBtn = document.createElement("button");
    sendBtn.id = "lipi-widget-send";
    sendBtn.type = "submit";
    sendBtn.textContent = "Send";

    form.appendChild(input);
    form.appendChild(sendBtn);
    panel.appendChild(header);
    panel.appendChild(messagesEl);
    panel.appendChild(form);

    document.body.appendChild(launcher);
    document.body.appendChild(panel);
  }

  function appendMessage(text, from) {
    var el = document.createElement("div");
    el.className = "lipi-msg " + (from === "visitor" ? "lipi-visitor" : "lipi-agent");
    el.textContent = text;
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  // ------------------------------------------------------------- state
  var opened = false;
  var lastPollIso = null;
  var pollTimer = null;

  function openPanel() {
    if (opened) return;
    opened = true;
    panel.classList.add("lipi-open");
    ensureSession();
    startPolling();
  }

  function toggle() {
    if (panel.classList.contains("lipi-open")) {
      panel.classList.remove("lipi-open");
    } else {
      openPanel();
    }
  }

  var sessionStarted = false;
  function ensureSession() {
    if (sessionStarted) return;
    sessionStarted = true;
    api("/v1/webchat/" + WORKSPACE_ID + "/session", {
      method: "POST",
      body: JSON.stringify({ visitorId: visitorId, touch: readTouch() }),
    }).then(function (data) {
      if (data && data.greeting) appendMessage(data.greeting, "agent");
    }).catch(function () {
      appendMessage("Sorry, chat isn't available right now.", "agent");
    });
  }

  function sendMessage(text) {
    appendMessage(text, "visitor");
    sendBtn.disabled = true;
    api("/v1/webchat/" + WORKSPACE_ID + "/message", {
      method: "POST",
      body: JSON.stringify({ visitorId: visitorId, text: text }),
    }).then(function (data) {
      if (data.conversationId) setConversationId(data.conversationId);
      if (data.reply) {
        appendMessage(data.reply, "agent");
        lastPollIso = new Date().toISOString();
      }
    }).catch(function () {
      appendMessage("That didn't send. Please try again.", "agent");
    }).finally(function () {
      sendBtn.disabled = false;
    });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(function () {
      var conversationId = getConversationId();
      if (!conversationId) return;
      var params = new URLSearchParams({ visitorId: visitorId, conversationId: conversationId });
      if (lastPollIso) params.set("sinceIso", lastPollIso);
      api("/v1/webchat/" + WORKSPACE_ID + "/updates?" + params.toString(), { method: "GET" })
        .then(function (data) {
          if (data && data.messages && data.messages.length) {
            data.messages.forEach(function (m) { appendMessage(m.text, "agent"); });
            lastPollIso = data.messages[data.messages.length - 1].sentIso;
          }
        })
        .catch(function () { /* a missed poll just retries next tick */ });
    }, POLL_MS);
  }

  function init() {
    injectStyle();
    buildDom();
    launcher.addEventListener("click", toggle);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var text = input.value.trim();
      if (!text) return;
      input.value = "";
      sendMessage(text);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
