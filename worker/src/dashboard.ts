const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>X Automation — Relays</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
  table { border-collapse: collapse; width: 100%; max-width: 720px; }
  th, td { border: 1px solid #ccc; padding: .5rem; text-align: left; }
  .online { color: #0a7d2a; }
  .offline { color: #b00; }
  form { margin: 1rem 0; }
  button.send { font: inherit; padding: .2rem .5rem; }
</style>
</head>
<body>
<h1>X Automation — Relays</h1>
<form id="create">
  <label>Relay name <input id="name" placeholder="laptop" required></label>
  <button type="submit">Create relay</button>
</form>
<pre id="pair" hidden></pre>
<table>
  <thead><tr><th>Name</th><th>Status</th><th>Online</th><th>Queued</th><th>Done</th><th>Failed</th><th></th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<script>
  const rows = document.getElementById("rows");
  const pairBox = document.getElementById("pair");
  const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
  async function sendEcho(id) {
    await fetch("/api/relays/" + id + "/commands", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "echo", payload: { message: "ping" } }) });
    refresh();
  }
  async function refresh() {
    const res = await fetch("/api/relays/dashboard");
    const data = await res.json();
    rows.innerHTML = "";
    for (const r of data.relays) {
      const tr = document.createElement("tr");
      tr.innerHTML = \`<td>\${esc(r.name)}</td><td>\${r.status}</td>
        <td class="\${r.online ? "online" : "offline"}">\${r.online ? "online" : "offline"}</td>
        <td>\${r.queued}</td><td>\${r.done}</td><td>\${r.failed}</td>
        <td><button class="send" data-id="\${r.id}">Echo</button></td>\`;
      tr.querySelector("button").addEventListener("click", () => sendEcho(r.id));
      rows.appendChild(tr);
    }
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
  refresh();
  setInterval(refresh, 10000);
</script>
</body>
</html>`;

export { PAGE };