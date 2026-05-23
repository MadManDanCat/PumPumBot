// PumPumBot Chat — slim renderer: connection, status, live log.

const $ = (id) => document.getElementById(id);
const els = {
  channel: $('channel'), connectBtn: $('connectBtn'),
  status: $('status'), statusText: $('statusText'),
  econStatus: $('econStatus'), betStrip: $('betStrip'),
  botToken: $('botToken'), saveBtn: $('saveBtn'), log: $('log'),
};

let cfg = {};
let connected = false;
const MAX_LOG = 250;

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function setStatus(state, label) {
  els.status.classList.remove('connected','disconnected','connecting');
  els.status.classList.add(state);
  els.statusText.textContent = label;
  connected = state === 'connected';
  els.connectBtn.textContent = connected ? 'Disconnect'
    : state === 'connecting' ? 'Connecting…' : 'Connect';
}
function logLine({ kind, text, ts }) {
  const empty = els.log.querySelector('.empty');
  if (empty) empty.remove();
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  const ss = String(d.getSeconds()).padStart(2,'0');
  const arrow = kind === 'IN' ? '«' : kind === 'OUT' ? '»' : '·';
  const row = document.createElement('div');
  row.className = 'l';
  row.innerHTML = `<span class="t">${hh}:${mm}:${ss}</span> ` +
    `<span class="${kind}">${arrow} ${esc(text)}</span>`;
  const atBottom = els.log.scrollTop + els.log.clientHeight >= els.log.scrollHeight - 30;
  els.log.appendChild(row);
  while (els.log.childElementCount > MAX_LOG) els.log.removeChild(els.log.firstChild);
  if (atBottom) els.log.scrollTop = els.log.scrollHeight;
}

async function refreshEcon() {
  try {
    const ok = await window.api.dbOk();
    els.econStatus.textContent = ok ? 'ECONOMY: ONLINE' : 'ECONOMY: OFFLINE';
    els.econStatus.classList.toggle('off', !ok);
  } catch {}
}
async function pollBets() {
  try {
    const st = await window.api.betStatus();
    if (st && st.state && st.state !== 'idle') {
      els.betStrip.hidden = false;
      els.betStrip.textContent = st.msg || '';
    } else els.betStrip.hidden = true;
  } catch {}
}

async function connect() {
  const ch = (els.channel.value || '').trim().toLowerCase().replace(/^#/, '');
  if (!ch) { setStatus('disconnected', 'Type a channel first'); return; }
  cfg.channel = ch;
  await window.api.setConfig(cfg);
  await window.api.botConnect();
}
async function disconnect() { await window.api.botDisconnect(); }

els.connectBtn.addEventListener('click', () => connected ? disconnect() : connect());
els.channel.addEventListener('keydown', (e) => { if (e.key === 'Enter') connect(); });
els.saveBtn.addEventListener('click', async () => {
  cfg.botToken = (els.botToken.value || '').trim();
  cfg.writeEnabled = true;
  await window.api.setConfig(cfg);
  await window.api.botDisconnect();
  await window.api.botConnect();
  els.saveBtn.textContent = 'Saved ✓';
  setTimeout(() => els.saveBtn.textContent = 'Save & Reconnect', 1500);
});

window.api.onStatus((d) => setStatus(d.state, d.label));
window.api.onLog((d) => logLine(d));
window.api.onDbOk(() => refreshEcon());

(async () => {
  cfg = await window.api.getConfig();
  els.channel.value = cfg.channel || '';
  els.botToken.value = cfg.botToken || '';
  els.log.innerHTML = '<div class="empty">Waiting for activity…</div>';
  setStatus('disconnected', 'Not connected');
  refreshEcon();
  pollBets();
  setInterval(pollBets, 4000);
})();
