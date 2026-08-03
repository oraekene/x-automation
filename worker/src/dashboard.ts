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
</style>
</head>
<body>
<h1>X Automation — Dashboard</h1>

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
<p class="muted">Every rule decision, newest first: Stage 2 (filter keep/reject) and Stage 4 (guardrail block).</p>
<table>
  <thead><tr><th>When</th><th>Stage</th><th>Decision</th><th>Rule</th><th>Reason</th><th>Score</th></tr></thead>
  <tbody id="decisionRows"></tbody>
</table>

<script>
  const rows = document.getElementById("rows");
  const pairBox = document.getElementById("pair");
  const autoRows = document.getElementById("autoRows");
  const candRows = document.getElementById("candRows");
  const decisionRows = document.getElementById("decisionRows");
  const relaySelect = document.getElementById("aRelay");
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  async function sendEcho(id) {
    await fetch("/api/relays/" + id + "/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "echo", payload: { message: "ping" } }) });
    refresh();
  }
  async function toggleEnabled(id, enabled) {
    await fetch("/api/relays/" + id + "/enabled", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: !enabled }) });
    refresh();
  }
  async function refresh() {
    const res = await fetch("/api/relays/dashboard");
    const data = await res.json();
    rows.innerHTML = "";
    relaySelect.innerHTML = "";
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
    }
  }
  async function refreshAutomations() {
    const res = await fetch("/api/automations", { headers: { "accept": "application/json" } });
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
    const res = await fetch("/api/candidates", { headers: { "accept": "application/json" } });
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
    const res = await fetch("/api/funnel/decisions", { headers: { "accept": "application/json" } });
    const data = await res.json();
    decisionRows.innerHTML = "";
    for (const d of data.decisions) {
      const tr = document.createElement("tr");
      tr.innerHTML = \`<td>\${new Date(d.acted_at * 1000).toISOString()}</td><td>\${esc(d.stage)}</td>
        <td>\${esc(d.decision)}</td><td>\${esc(d.rule)}</td><td>\${esc(d.reason)}</td><td>\${d.score.toFixed(2)}</td>\`;
      decisionRows.appendChild(tr);
    }
  }
  async function runFilter() {
    await fetch("/api/funnel/filter", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    refreshDecisions();
  }
  document.getElementById("create").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = document.getElementById("name").value;
    const res = await fetch("/api/relays", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) });
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
      interval_minutes: parseInt(document.getElementById("aInterval").value, 10) * 60,
      timezone: document.getElementById("aTz").value || "UTC",
    };
    const res = await fetch("/api/automations", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (!res.ok) { alert("create failed: " + (await res.text())); return; }
    refreshAutomations();
  });
  document.getElementById("runFilter").addEventListener("click", runFilter);
  refresh();
  refreshAutomations();
  refreshCandidates();
  refreshDecisions();
  setInterval(() => { refresh(); refreshAutomations(); refreshCandidates(); refreshDecisions(); }, 15000);
</script>
</body>
</html>`;

export { PAGE };