const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>X Automation — Dashboard</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
  h2 { margin-top: 2rem; }
  table { border-collapse: collapse; width: 100%; max-width: 960px; margin-top: .5rem; }
  th, td { border: 1px solid #ccc; padding: .4rem; text-align: left; vertical-align: top; }
  .online { color: #0a7d2a; }
  .offline { color: #b00; }
  form { margin: .75rem 0; }
  label { margin-right: .75rem; white-space: nowrap; }
  input, select { font: inherit; margin-left: .25rem; }
  .muted { color: #666; }
  #loginSection { max-width: 480px; margin: 4rem auto; padding: 2rem; border: 1px solid #ccc; border-radius: 8px; }
  #loginSection h2 { margin-top: 0; }
  #dashboardSection { display: none; }
  #loginError { color: #b00; margin-top: .5rem; }
  .bar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; padding: .5rem 0; border-bottom: 1px solid #eee; }
</style>
</head>
<body>

<div id="loginSection">
  <h2>X Automation — Login</h2>
  <p class="muted">Paste your JWT token to access the dashboard.</p>
  <form id="loginForm">
    <label>Token <input id="loginToken" type="password" placeholder="eyJhbGci..." required style="width:100%"></label>
    <button type="submit">Login</button>
  </form>
  <div id="loginError" hidden></div>
</div>

<div id="dashboardSection">
  <div class="bar">
    <h1 style="margin:0">X Automation — Dashboard</h1>
    <div>
      <span id="userEmail" class="muted"></span>
      <button id="logoutBtn" style="margin-left:.5rem">Logout</button>
    </div>
  </div>

<h2>Relays</h2>
<form id="create">
  <label>Relay name <input id="name" placeholder="laptop" required></label>
  <button type="submit">Create relay</button>
</form>
<pre id="pair" hidden></pre>
<table>
  <thead><tr><th>Name</th><th>Status</th><th>Online</th><th>Enabled</th><th>Queued</th><th>Done</th><th>Failed</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>

<h2>Automations</h2>
<form id="autoCreate">
  <label>Name <input id="aName" placeholder="hiring remit" required></label>
  <label>Relay <select id="aRelay" required></select></label>
  <label>Keywords <input id="aKeywords" placeholder="openai, llm" required></label>
  <label>Hashtags <input id="aHashtags" placeholder="remit"></label>
  <label>Mentions <input id="aMentions" placeholder="partner"></label>
  <label>Min faves <input id="aMinFaves" type="number" min="0"></label>
  <label>Min retweets <input id="aMinRetweets" type="number" min="0"></label>
  <label>Lang <input id="aLang" placeholder="en"></label>
  <label>Since <input id="aSince" placeholder="2026-08-01"></label>
  <label>Until <input id="aUntil" placeholder="2026-08-03"></label>
  <label>Profile keywords <input id="aProfileKeywords" placeholder="founder"></label>
  <label>Min followers <input id="aMinFollowers" type="number" min="0"></label>
  <label>Verified <input id="aVerified" type="checkbox"></label>
  <label>Location <input id="aLocation" placeholder="London"></label>
  <label>Hours between runs <input id="aInterval" type="number" min="1" value="24"></label>
  <label>Target size <input id="aTarget" type="number" min="1" value="50"></label>
  <label>Max posts/day <input id="aMaxPosts" type="number" min="0" value="10"></label>
  <label>Max replies/day <input id="aMaxReplies" type="number" min="0" value="20"></label>
  <label>Quiet start <input id="aQuietStart" placeholder="22:00"></label>
  <label>Quiet end <input id="aQuietEnd" placeholder="07:00"></label>
  <label>Allowlist <input id="aAllowlist" placeholder="alice, bob"></label>
  <label>Blocklist <input id="aBlocklist" placeholder="spammy"></label>
  <label>Timezone <input id="aTz" placeholder="UTC" value="UTC"></label>
  <label>Mode <select id="aMode">
    <option value="manual" selected>Manual (inbox only)</option>
    <option value="auto">Automatic</option>
    <option value="hybrid">Hybrid</option>
  </select></label>
  <label>Auto threshold <input id="aThreshold" type="number" min="1" max="5" value="4"></label>
  <button type="submit">Create automation</button>
</form>
<table>
  <thead><tr><th>Name</th><th>Status</th><th>Keywords</th><th>Thresholds</th><th>Interval</th><th>Next run</th></tr></thead>
  <tbody id="autoRows"></tbody>
</table>

<h2>Candidate pool</h2>
<p class="muted">Tweets found by the automation's search and profile passes, deduped per account.</p>
<table>
  <thead><tr><th>When</th><th>Source</th><th>Author</th><th>Text</th><th>Favs</th><th>RTs</th><th>Replies</th><th>Lang</th></tr></thead>
  <tbody id="candRows"></tbody>
</table>
<p class="muted">Run the heuristic filter + guardrails on the pool (POST /api/funnel/filter).</p>
<button id="runFilter">Run filter</button>

<h2>Funnel audit</h2>
<p class="muted">Every rule decision, newest first: Stage 2 (filter keep/reject), Stage 4 (guardrail block) and Stage 3 (ai draft/skip/fail).</p>
<table>
  <thead><tr><th>When</th><th>Stage</th><th>Decision</th><th>Rule</th><th>Reason</th><th>Score</th></tr></thead>
  <tbody id="decisionRows"></tbody>
</table>

<h2>AI targeting</h2>
<p class="muted">One OpenAI-compatible provider per account (key stays with you). Presets prefill the free endpoints from the spec.</p>
<form id="providerForm">
  <label>Preset <select id="pPreset"></select></label>
  <label>Base URL <input id="pBaseUrl" size="40" required></label>
  <label>Model <input id="pModel" placeholder="gpt-4o-mini" required></label>
  <label>API key <input id="pApiKey" type="password" placeholder="••••••••"></label>
  <button type="submit">Save provider</button>
</form>
<p class="muted">Run targeting on the actionable survivors (POST /api/funnel/target); failed verdicts are retried on the next run and hourly.</p>
<button id="runTarget">Run targeting</button>
<p class="muted">Inbox: approve executes the draft through the relay; reject marks it and nothing posts. Automatic/hybrid modes execute on the tick.</p>
<table>
  <thead><tr><th>When</th><th>Action</th><th>Priority</th><th>Status</th><th>Text</th><th>Automation</th><th>Author</th><th>Reason</th><th></th></tr></thead>
  <tbody id="draftRows"></tbody>
</table>

<h2>Conversations</h2>
<p class="muted">Inbound multi-turn threads. Conversations start when someone replies to your tweet; the AI generates turns and you approve replies from the inbox above.</p>
<table>
  <thead><tr><th>Peer</th><th>Status</th><th>Turns</th><th>Root tweet</th><th>Closed</th><th>Last active</th><th></th></tr></thead>
  <tbody id="convRows"></tbody>
</table>
<div id="convDetail" hidden>
  <h3>Conversation thread</h3>
  <div id="convMessages"></div>
</div>
<h3>Conversation settings</h3>
<form id="convSettingsForm">
  <label>Max turns <input id="cMaxTurns" type="number" min="1" max="8" value="5"></label>
  <label>Daily new cap <input id="cDailyCap" type="number" min="1" max="50" value="10"></label>
  <label>Lifetime cap <input id="cLifetimeCap" type="number" min="1" max="1000" value="100"></label>
  <label>Inactivity (min) <input id="cInactivity" type="number" min="1" max="10080" value="1440"></label>
  <label>Timezone <input id="cTimezone" placeholder="UTC" value="UTC"></label>
  <label>Quiet start <input id="cQuietStart" placeholder="22:00"></label>
  <label>Quiet end <input id="cQuietEnd" placeholder="07:00"></label>
  <button type="submit">Save settings</button>
</form>

<h2>Post compose</h2>
<p class="muted">Create a post directly (no candidate required). The draft is enqueued for the relay to post.</p>
<form id="postForm">
  <label>Relay <select id="pRelay" required></select></label>
  <label>Text <textarea id="pText" rows="3" cols="60" maxlength="280" placeholder="What's happening?" required></textarea></label>
  <span id="pCharCount" class="muted">0/280</span>
  <button type="submit">Create post draft</button>
</form>
<pre id="postResult" hidden></pre>

<h2>API tokens</h2>
<p class="muted">Manage API tokens for external tools (Hermes Agent, etc.). Tokens are shown once at creation and hashed in the database.</p>
<form id="tokenCreateForm">
  <label>Name <input id="tName" placeholder="my-plugin" required></label>
  <button type="submit">Create token</button>
</form>
<pre id="tokenResult" hidden></pre>
<table>
  <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th></th></tr></thead>
  <tbody id="tokenRows"></tbody>
</table>
</div>

<script>
  (function() {
    const TOKEN_KEY = "x_auto_jwt";
    const loginSection = document.getElementById("loginSection");
    const dashboardSection = document.getElementById("dashboardSection");
    const loginForm = document.getElementById("loginForm");
    const loginError = document.getElementById("loginError");
    const loginToken = document.getElementById("loginToken");
    const userEmail = document.getElementById("userEmail");
    const logoutBtn = document.getElementById("logoutBtn");

    function getToken() { return localStorage.getItem(TOKEN_KEY); }
    function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
    function clearToken() { localStorage.removeItem(TOKEN_KEY); }

    function decodeEmail(token) {
      try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
        return JSON.parse(atob(b64)).email || null;
      } catch (e) { return null; }
    }

    async function authFetch(url, opts = {}) {
      const t = getToken();
      if (!t) { showLogin(); throw new Error("no token"); }
      const headers = new Headers(opts.headers || {});
      headers.set("Authorization", "Bearer " + t);
      const res = await fetch(url, { ...opts, headers });
      if (res.status === 401) { clearToken(); showLogin(); throw new Error("unauthorized"); }
      return res;
    }

    function showLogin() {
      loginSection.style.display = "block";
      dashboardSection.style.display = "none";
    }

    function showDashboard(email) {
      loginSection.style.display = "none";
      dashboardSection.style.display = "block";
      userEmail.textContent = email || "";
    }

    function initDashboard() {
      const rows = document.getElementById("rows");
      const pairBox = document.getElementById("pair");
      const autoRows = document.getElementById("autoRows");
      const candRows = document.getElementById("candRows");
      const decisionRows = document.getElementById("decisionRows");
      const draftRows = document.getElementById("draftRows");
      const convRows = document.getElementById("convRows");
      const convDetail = document.getElementById("convDetail");
      const convMessages = document.getElementById("convMessages");
      const tokenRows = document.getElementById("tokenRows");
      const tokenResult = document.getElementById("tokenResult");
      const postResult = document.getElementById("postResult");
      const relaySelect = document.getElementById("aRelay");
      const pRelaySelect = document.getElementById("pRelay");
      const presetSelect = document.getElementById("pPreset");
      const pBaseUrl = document.getElementById("pBaseUrl");
      const pModel = document.getElementById("pModel");
      const pApiKey = document.getElementById("pApiKey");
      const pText = document.getElementById("pText");
      const pCharCount = document.getElementById("pCharCount");
      const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

      async function sendEcho(id) {
        await authFetch("/api/relays/" + id + "/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "echo", payload: { message: "ping" } }) });
        refresh();
      }
      async function toggleEnabled(id, enabled) {
        await authFetch("/api/relays/" + id + "/enabled", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
        refresh();
      }
      async function refresh() {
        const res = await authFetch("/api/relays/dashboard");
        const data = await res.json();
        rows.innerHTML = "";
        relaySelect.innerHTML = "";
        pRelaySelect.innerHTML = "";
        for (const r of data.relays) {
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td>\${esc(r.name)}</td><td>\${r.status}</td>
            <td class="\${r.online ? "online" : "offline"}">\${r.online ? "online" : "offline"}</td>
            <td>\${r.enabled ? "on" : "off"}</td>
            <td>\${r.queued}</td><td>\${r.done}</td><td>\${r.failed}</td>
            <td><button class="send" data-id="\${r.id}">Echo</button>
            <button class="toggle" data-id="\${r.id}" data-enabled="\${r.enabled}">\${r.enabled ? "Kill switch" : "Enable"}</button></td>\`;
          tr.querySelector("button.send").addEventListener("click", () => sendEcho(r.id));
          tr.querySelector("button.toggle").addEventListener("click", (ev) => {
            const b = ev.currentTarget;
            toggleEnabled(b.dataset.id, b.dataset.enabled === "true");
          });
          rows.appendChild(tr);
          const opt = document.createElement("option");
          opt.value = r.id;
          opt.textContent = r.name;
          relaySelect.appendChild(opt);
          const opt2 = document.createElement("option");
          opt2.value = r.id;
          opt2.textContent = r.name;
          pRelaySelect.appendChild(opt2);
        }
      }
      async function refreshAutomations() {
        const res = await authFetch("/api/automations", { headers: { "accept": "application/json" } });
        const data = await res.json();
        autoRows.innerHTML = "";
        for (const a of data.automations) {
          const sc = a.search_criteria || {};
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td>\${esc(a.name)}</td><td>\${esc(a.status)}</td>
            <td>\${(sc.keywords || []).join(", ")}</td>
            <td>faves&gt;=\${sc.min_faves ?? 0} rt&gt;=\${sc.min_retweets ?? 0}</td>
            <td>\${a.interval_minutes}min</td>
            <td>\${new Date(a.next_run_at * 1000).toISOString()}</td>\`;
          autoRows.appendChild(tr);
        }
      }
      async function refreshCandidates() {
        const res = await authFetch("/api/candidates", { headers: { "accept": "application/json" } });
        const data = await res.json();
        candRows.innerHTML = "";
        for (const ct of data.candidates) {
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td>\${new Date(ct.found_at * 1000).toISOString()}</td><td>\${esc(ct.source)}</td>
            <td>@\${esc(ct.author)}</td><td>\${esc(ct.text.slice(0, 80))}</td>
            <td>\${ct.favorite_count}</td><td>\${ct.retweet_count}</td><td>\${ct.reply_count}</td><td>\${esc(ct.lang)}</td>\`;
          candRows.appendChild(tr);
        }
      }
      async function refreshDecisions() {
        const res = await authFetch("/api/funnel/decisions", { headers: { "accept": "application/json" } });
        const data = await res.json();
        decisionRows.innerHTML = "";
        for (const d of data.decisions) {
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td>\${new Date(d.acted_at * 1000).toISOString()}</td><td>\${esc(d.stage)}</td>
            <td>\${esc(d.decision)}</td><td>\${esc(d.rule)}</td><td>\${esc(d.reason)}</td><td>\${d.score.toFixed(2)}</td>\`;
          decisionRows.appendChild(tr);
        }
      }
      async function refreshProvider() {
        const res = await authFetch("/api/provider", { headers: { "accept": "application/json" } });
        const data = await res.json();
        pApiKey.placeholder = data.provider ? (data.provider.key_masked || "••••••••") : "sk-...";
        if (data.provider) {
          pBaseUrl.value = data.provider.base_url;
          pModel.value = data.provider.model;
        }
      }
      async function refreshPresets() {
        const res = await authFetch("/api/provider/presets", { headers: { "accept": "application/json" } });
        const data = await res.json();
        presetSelect.innerHTML = "";
        const blank = document.createElement("option");
        blank.value = "";
        blank.textContent = "(custom)";
        presetSelect.appendChild(blank);
        for (const p of data.presets) {
          const opt = document.createElement("option");
          opt.value = p.base_url;
          opt.textContent = p.name;
          presetSelect.appendChild(opt);
        }
      }
      async function refreshDrafts() {
        const res = await authFetch("/api/drafts", { headers: { "accept": "application/json" } });
        const data = await res.json();
        draftRows.innerHTML = "";
        for (const d of data.drafts) {
          const tr = document.createElement("tr");
          const decidable = d.status === "ready" || d.status === "content_failed";
          tr.innerHTML = \`<td>\${new Date(d.created_at * 1000).toISOString()}</td><td>\${esc(d.action)}</td>
            <td>\${d.priority}</td><td>\${esc(d.status)}</td><td>\${esc((d.text || "(no text)").slice(0, 60))}</td>
            <td>\${esc(d.automation_name)}</td><td>@\${esc(d.author)}</td><td>\${esc(d.reason)}</td>
            <td>\${decidable ? \`<button class="approve" data-id="\${d.id}">Approve</button>
            <button class="reject" data-id="\${d.id}">Reject</button>\` : ""}</td>\`;
          if (decidable) {
            tr.querySelector("button.approve").addEventListener("click", async () => {
              const text = prompt("Approve — edit text (blank keeps draft text)", d.text || "");
              const body = text === null ? null : JSON.stringify(text.trim() ? { text: text.trim() } : {});
              if (body === null) return;
              const r = await authFetch("/api/drafts/" + d.id + "/approve", { method: "POST", headers: { "content-type": "application/json" }, body });
              if (!r.ok) { alert("approve failed: " + (await r.text())); return; }
              refreshDrafts();
              refresh();
            });
            tr.querySelector("button.reject").addEventListener("click", async () => {
              await authFetch("/api/drafts/" + d.id + "/reject", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
              refreshDrafts();
            });
          }
          draftRows.appendChild(tr);
        }
      }
      async function refreshConversations() {
        const res = await authFetch("/api/conversations", { headers: { "accept": "application/json" } });
        const data = await res.json();
        convRows.innerHTML = "";
        for (const c of data.conversations) {
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td>@\${esc(c.peer)}</td><td>\${esc(c.status)}</td>
            <td>\${c.turn_count}</td><td>\${esc(c.root_tweet_id)}</td>
            <td>\${c.closed_reason ? esc(c.closed_reason) : "-"}</td>
            <td>\${new Date(c.last_turn_at * 1000).toISOString()}</td>
            <td><button class="viewConv" data-id="\${c.id}">View</button></td>\`;
          tr.querySelector("button.viewConv").addEventListener("click", () => viewConversation(c.id));
          convRows.appendChild(tr);
        }
      }
      async function viewConversation(id) {
        const res = await authFetch("/api/conversations/" + id, { headers: { "accept": "application/json" } });
        const data = await res.json();
        convDetail.hidden = false;
        convMessages.innerHTML = "";
        for (const m of data.messages) {
          const div = document.createElement("div");
          div.style.cssText = "margin:.25rem 0;padding:.25rem;border-left:3px solid " + (m.role === "inbound" ? "#0a7d2a" : "#0057b7") + ";";
          div.innerHTML = \`<strong>\${m.role === "inbound" ? "@" + esc(m.author) : "Bot"}</strong> <span class="muted">\${new Date(m.created_at * 1000).toLocaleTimeString()}</span><br>\${esc(m.text)}\`;
          convMessages.appendChild(div);
        }
      }
      async function refreshConvSettings() {
        const res = await authFetch("/api/conversations/settings/meta", { headers: { "accept": "application/json" } });
        const data = await res.json();
        const s = data.settings;
        document.getElementById("cMaxTurns").value = s.max_turns;
        document.getElementById("cDailyCap").value = s.daily_new_cap;
        document.getElementById("cLifetimeCap").value = s.max_lifetime_conversations;
        document.getElementById("cInactivity").value = s.inactivity_minutes;
        document.getElementById("cTimezone").value = s.timezone || "UTC";
        if (s.quiet_hours) {
          document.getElementById("cQuietStart").value = s.quiet_hours.start;
          document.getElementById("cQuietEnd").value = s.quiet_hours.end;
        }
      }
      async function refreshTokens() {
        const res = await authFetch("/api/tokens", { headers: { "accept": "application/json" } });
        const data = await res.json();
        tokenRows.innerHTML = "";
        for (const t of data.tokens) {
          const tr = document.createElement("tr");
          tr.innerHTML = \`<td>\${esc(t.name)}</td>
            <td>\${esc(t.prefix)}…</td>
            <td>\${new Date(t.created_at * 1000).toISOString()}</td>
            <td>\${t.revoked ? '<span class="muted">revoked</span>' : \`<button class="revokeToken" data-id="\${t.id}">Revoke</button>\`}</td>\`;
          tr.querySelector("button.revokeToken")?.addEventListener("click", async () => {
            if (!confirm("Revoke this token?")) return;
            await authFetch("/api/tokens/" + t.id, { method: "DELETE" });
            refreshTokens();
          });
          tokenRows.appendChild(tr);
        }
      }
      async function runTargeting() {
        const res = await authFetch("/api/funnel/target", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const data = await res.json();
        if (data.error) { alert("targeting failed: " + data.error); return; }
        const failed = (data.automations || []).reduce((n, a) => n + (a.failures || 0), 0);
        if (failed > 0) alert("Targeting ran but " + failed + " verdicts failed — they will be retried.");
        refreshDecisions();
        refreshDrafts();
      }
      async function runFilter() {
        await authFetch("/api/funnel/filter", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        refreshDecisions();
      }
      document.getElementById("create").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("name").value;
        const res = await authFetch("/api/relays", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
        const data = await res.json();
        pairBox.hidden = false;
        pairBox.textContent = "Pair from the host: relay.py pair --code " + data.pairing_code + " --relay-id " + data.relay_id;
        document.getElementById("name").value = "";
        refresh();
      });
      document.getElementById("autoCreate").addEventListener("submit", async (e) => {
        e.preventDefault();
        const split = (id) => document.getElementById(id).value.split(",").map((s) => s.trim()).filter(Boolean);
        const body = {
          relay_id: relaySelect.value,
          name: document.getElementById("aName").value,
          search_criteria: {
            keywords: split("aKeywords"),
            hashtags: split("aHashtags"),
            mentions: split("aMentions"),
            min_faves: parseInt(document.getElementById("aMinFaves").value, 10) || undefined,
            min_retweets: parseInt(document.getElementById("aMinRetweets").value, 10) || undefined,
            lang: document.getElementById("aLang").value || undefined,
            since: document.getElementById("aSince").value || undefined,
            until: document.getElementById("aUntil").value || undefined,
          },
          targeting: {
            profile: {
              keywords: split("aProfileKeywords"),
              min_followers: parseInt(document.getElementById("aMinFollowers").value, 10) || undefined,
              verified: document.getElementById("aVerified").checked || undefined,
              location: document.getElementById("aLocation").value || undefined,
            },
          },
          rules: {
            target_size: parseInt(document.getElementById("aTarget").value, 10) || 50,
            allowlist: split("aAllowlist"),
            blocklist: split("aBlocklist"),
          },
          budgets: {
            max_posts_per_day: parseInt(document.getElementById("aMaxPosts").value, 10) || 10,
            max_replies_per_day: parseInt(document.getElementById("aMaxReplies").value, 10) || 20,
            quiet_hours: (document.getElementById("aQuietStart").value && document.getElementById("aQuietEnd").value)
              ? { start: document.getElementById("aQuietStart").value, end: document.getElementById("aQuietEnd").value }
              : undefined,
          },
          mode: {
            mode: document.getElementById("aMode").value,
            auto_threshold: parseInt(document.getElementById("aThreshold").value, 10) || 4,
          },
          interval_minutes: parseInt(document.getElementById("aInterval").value, 10) * 60,
          timezone: document.getElementById("aTz").value || "UTC",
        };
        const res = await authFetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) { alert("create failed: " + (await res.text())); return; }
        refreshAutomations();
      });
      document.getElementById("runFilter").addEventListener("click", runFilter);
      document.getElementById("runTarget").addEventListener("click", runTargeting);
      presetSelect.addEventListener("change", () => { if (presetSelect.value) pBaseUrl.value = presetSelect.value; });
      document.getElementById("providerForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = { base_url: pBaseUrl.value.trim(), model: pModel.value.trim() };
        if (pApiKey.value.trim()) body.api_key = pApiKey.value.trim();
        await authFetch("/api/provider", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        pApiKey.value = "";
        refreshProvider();
      });
      document.getElementById("convSettingsForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const body = {
          max_turns: parseInt(document.getElementById("cMaxTurns").value, 10) || 5,
          daily_new_cap: parseInt(document.getElementById("cDailyCap").value, 10) || 10,
          max_lifetime_conversations: parseInt(document.getElementById("cLifetimeCap").value, 10) || 100,
          inactivity_minutes: parseInt(document.getElementById("cInactivity").value, 10) || 1440,
          timezone: document.getElementById("cTimezone").value || "UTC",
        };
        const qs = document.getElementById("cQuietStart").value;
        const qe = document.getElementById("cQuietEnd").value;
        if (qs && qe) body.quiet_hours = { start: qs, end: qe };
        await authFetch("/api/conversations/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        refreshConvSettings();
      });
      document.getElementById("postForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const res = await authFetch("/api/content", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ relay_id: pRelaySelect.value, text: pText.value.trim() }) });
        const data = await res.json();
        if (!res.ok) { postResult.hidden = false; postResult.textContent = "Error: " + (data.error || "failed"); return; }
        postResult.hidden = false;
        postResult.textContent = "Draft #" + data.draft_id + " created (action: " + data.action + "). Approve from the inbox above.";
        pText.value = "";
        pCharCount.textContent = "0/280";
        refreshDrafts();
      });
      pText.addEventListener("input", () => { pCharCount.textContent = pText.value.length + "/280"; });
      document.getElementById("tokenCreateForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const res = await authFetch("/api/tokens", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: document.getElementById("tName").value }) });
        const data = await res.json();
        if (!res.ok) { tokenResult.hidden = false; tokenResult.textContent = "Error: " + (data.error || "failed"); return; }
        tokenResult.hidden = false;
        tokenResult.textContent = "Token created! Save this — it won't be shown again:\\n\\n" + data.token + "\\n\\nToken ID: " + data.token_id;
        document.getElementById("tName").value = "";
        refreshTokens();
      });
      refresh();
      refreshAutomations();
      refreshCandidates();
      refreshDecisions();
      refreshPresets();
      refreshProvider();
      refreshDrafts();
      refreshConversations();
      refreshConvSettings();
      refreshTokens();
      setInterval(() => { refresh(); refreshAutomations(); refreshCandidates(); refreshDecisions(); refreshDrafts(); refreshConversations(); }, 15000);
    }

    loginForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const token = loginToken.value.trim();
      loginError.hidden = true;
      if (!token) return;
      const email = decodeEmail(token);
      if (!email) {
        loginError.hidden = false;
        loginError.textContent = "Invalid token: must be a JWT with an email claim.";
        return;
      }
      setToken(token);
      showDashboard(email);
      initDashboard();
    });

    logoutBtn.addEventListener("click", () => {
      clearToken();
      showLogin();
    });

    const existing = getToken();
    if (existing) {
      const email = decodeEmail(existing);
      if (email) {
        showDashboard(email);
        initDashboard();
      } else {
        clearToken();
        showLogin();
      }
    } else {
      showLogin();
    }
  })();
</script>
</body>
</html>`;

export { PAGE };
