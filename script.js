// ============================================
// VIGILBOARD — PRODUCTION JS
// Fixes: BT stability, UI sync, simplicity
// ============================================

'use strict';

// ============================================
// STATE
// ============================================
const state = {
  sidebar: false,
  btDevice: null,
  btServer: null,
  btTx: null,
  btNotifyChar: null,
  btConnected: false,
  btReconnecting: false,
  btReconnectAttempts: 0,
  btMaxReconnectAttempts: 5,
  btReconnectTimer: null,
  uartBuffer: '',
  currentAlertId: null,
  currentGmailId: null,
  alertCount: 0,
  eventHistory: [],
  alerts: [{
    id: 1, icon: '✅', lvl: 'info',
    title: 'App Ready', src: 'VigilBoard',
    time: '--:--', urgency: 'l', unread: false,
    body: 'Connect Bluetooth and configure sources to start receiving alerts on your micro:bit.'
  }],
  sources: { email: true, call: true, message: true, notif: false },
  gmailToken: null, gmailEmail: null,
  gmailMessages: [], gmailKnownIds: new Set(),
  gmailBaselineCaptured: false,
  gmailPollingTimer: null,
};

// ============================================
// CONSTANTS
// ============================================
const NUS_SERVICE    = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_RX_CHAR    = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const NUS_TX_CHAR    = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const GOOGLE_CLIENT_ID = '768854227704-2mc6bip356pa56ejomb9lss8noc1b82c.apps.googleusercontent.com';
const GMAIL_SCOPE    = 'https://www.googleapis.com/auth/gmail.readonly';

const SOURCE_CONFIG = {
  call:    { icon: '📞', title: 'Incoming Call',   urgency: 'h', cmd: 'CALL:HIGH' },
  message: { icon: '💬', title: 'New Message',     urgency: 'm', cmd: 'MSG:MED' },
  email:   { icon: '✉️', title: 'Email Received',  urgency: 'l', cmd: 'EMAIL:LOW' },
  notif:   { icon: '🔔', title: 'Notification',    urgency: 'l', cmd: 'NOTIF:LOW' },
};

const PAGE_META = {
  dashboard: ['Dashboard', 'PHONE ALERTS → MICRO:BIT'],
  bluetooth: ['Bluetooth', 'DEVICE CONFIGURATION'],
  sources:   ['Sources',   'CONFIGURE INPUT SOURCES'],
  settings:  ['Settings',  'PREFERENCES & DEVICE'],
};

// ============================================
// UTILS
// ============================================
const nowTime = () => new Date().toLocaleTimeString('en-SG', { hour12: false });

function $(id) { return document.getElementById(id); }

function escapeHtml(t = '') {
  return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
          .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// CLOCK
// ============================================
function tickClock() {
  const el = $('clock');
  if (el) el.textContent = nowTime();
}
setInterval(tickClock, 1000);
tickClock();

// ============================================
// SIDEBAR
// ============================================
function toggleSidebar() {
  state.sidebar = !state.sidebar;
  $('sidebar').classList.toggle('collapsed', state.sidebar);
}

// ============================================
// NAVIGATION
// ============================================
function switchPage(name, navEl) {
  // Update nav items
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const target = navEl || document.querySelector(`[data-page="${name}"]`);
  if (target) target.classList.add('active');

  // Update pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const page = $('page-' + name);
  if (page) page.classList.add('active');

  // Update topbar
  const [title, sub] = PAGE_META[name] || ['', ''];
  if ($('pageTitle')) $('pageTitle').textContent = title;
  if ($('pageSub'))   $('pageSub').textContent = sub;
}

// ============================================
// ALERT MANAGEMENT
// ============================================
function renderAlerts() {
  const el = $('alertList');
  if (!el) return;

  if (!state.alerts.length) {
    el.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
            <line x1="1" y1="1" x2="23" y2="23" stroke="currentColor"/>
          </svg>
        </div>
        <p>No alerts yet</p>
        <span>Alerts will appear here</span>
      </div>`;
    updateCounts();
    return;
  }

  el.innerHTML = state.alerts.map(a => `
    <div class="alert-item ${a.unread ? 'unread' : ''}" onclick="modalOpen(${JSON.stringify(a.id)})">
      <div class="a-icon">${a.icon}</div>
      <div class="a-body">
        <div class="a-title">${escapeHtml(a.title)}</div>
        <div class="a-meta">${escapeHtml(a.src)} · ${a.time}</div>
      </div>
      <div class="a-badge ${a.urgency === 'h' ? 'badge-h' : a.urgency === 'm' ? 'badge-m' : 'badge-l'}">
        ${a.urgency === 'h' ? 'HIGH' : a.urgency === 'm' ? 'MED' : 'LOW'}
      </div>
      <button type="button" class="ack-btn" onclick="ackAlert(${JSON.stringify(a.id)}, event)">Ack</button>
    </div>
  `).join('');

  updateCounts();
}

function updateCounts() {
  const unreadCount = state.alerts.filter(a => a.unread).length;
  if ($('totalAlerts'))  $('totalAlerts').textContent  = state.alertCount;
  if ($('unreadAlerts')) $('unreadAlerts').textContent = unreadCount;
  if ($('critAlerts'))   $('critAlerts').textContent   = state.btConnected ? 1 : 0;

  const badge = $('navBadge');
  if (badge) badge.style.display = unreadCount > 0 ? '' : 'none';
}

function addAlert(a) {
  state.alertCount++;
  state.alerts.unshift({ id: a.id || Date.now(), time: nowTime(), ...a });
  state.eventHistory.push(Date.now());
  // Trim old events
  const cutoff = Date.now() - 3600000;
  state.eventHistory = state.eventHistory.filter(t => t >= cutoff);
  renderAlerts();
  buildChart();
}

function clearAlerts() {
  state.alerts = [];
  state.alertCount = 0;
  state.eventHistory = [];
  renderAlerts();
  buildChart();
}

function ackAlert(id, event) {
  if (event) event.stopPropagation();
  state.alerts = state.alerts.map(a => a.id === id ? { ...a, unread: false } : a);
  renderAlerts();
}

// ============================================
// MODAL
// ============================================
function modalOpen(id) {
  const a = state.alerts.find(x => x.id === id);
  if (!a) return;
  state.currentAlertId = id;
  $('mIcon').textContent   = a.icon;
  $('mTitle').textContent  = a.title;
  $('mSub').textContent    = `${a.src} · Today at ${a.time}`;
  $('mBody').textContent   = a.body;
  $('alertModal').classList.add('open');
}

function modalClose(e) {
  if (!e || e.target.id === 'alertModal' || e.currentTarget === e.target) {
    $('alertModal').classList.remove('open');
    state.currentAlertId = null;
    state.currentGmailId = null;
  }
}

function modalAck() {
  const id = state.currentAlertId || state.currentGmailId;
  if (id) {
    state.alerts = state.alerts.map(a => a.id === id ? { ...a, unread: false } : a);
    renderAlerts();
  }
  $('alertModal').classList.remove('open');
  state.currentAlertId = null;
  state.currentGmailId = null;
}

// ============================================
// MICRO:BIT DISPLAY
// ============================================
function buildMicroGrid() {
  const el = $('ledMatrix');
  if (!el) return;
  const labels = ['BT', 'RX', 'TX', 'OK'];
  el.innerHTML = labels.map((x, i) =>
    `<div class="led-cell" id="led-${x.toLowerCase()}">${x}</div>`
  ).join('');
}

function setLedActive(id, active) {
  const el = document.getElementById('led-' + id);
  if (el) el.classList.toggle('active', active);
}

function testFlash() {
  screenFlash('#c084fc');
  sendCmd('TEST:ALL');
}

function screenFlash(color = '#c084fc') {
  const f = $('flashOverlay');
  if (!f) return;
  f.style.background = color;
  f.classList.remove('go');
  void f.offsetWidth;
  f.classList.add('go');
  setTimeout(() => f.classList.remove('go'), 700);
}

// ============================================
// ACTIVITY CHART
// ============================================
function buildChart() {
  const el = $('miniChart');
  if (!el) return;
  const now = Date.now();
  const bucketSize = 3600000 / 8;
  const cutoff = now - 3600000;
  const buckets = Array.from({ length: 8 }, () => 0);
  state.eventHistory.forEach(ts => {
    if (ts >= cutoff) {
      const i = Math.min(7, Math.floor((ts - cutoff) / bucketSize));
      buckets[i]++;
    }
  });
  const max = Math.max(...buckets, 1);
  el.innerHTML = buckets.map(c =>
    `<div class="bar ${c > 0 ? 'hi' : ''}" style="height:${Math.max(4, Math.round(c / max * 100))}%"></div>`
  ).join('');
}
setInterval(buildChart, 60000);

// ============================================
// BLUETOOTH LOGGING
// ============================================
function btLog(msg, cls = '') {
  const log = $('btLog');
  if (!log) return;
  const line = document.createElement('div');
  line.className = 'log-line' + (cls ? ' ' + cls : '');
  line.innerHTML = `<span class="log-time">${nowTime()}</span>${escapeHtml(String(msg))}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  // Keep log trim to avoid memory leaks
  while (log.children.length > 200) log.removeChild(log.firstChild);
}

function clearLog() {
  const log = $('btLog');
  if (!log) return;
  log.innerHTML = '';
  btLog('Log cleared.', 'info');
}

// ============================================
// BLUETOOTH UART
// ============================================
function handleUartNotification(event) {
  const value = event.target.value;
  if (!value) return;
  state.uartBuffer += new TextDecoder().decode(value);
  let idx;
  while ((idx = state.uartBuffer.indexOf('\n')) !== -1) {
    const line = state.uartBuffer.slice(0, idx).trim();
    state.uartBuffer = state.uartBuffer.slice(idx + 1);
    if (line) btLog(`RX ← ${line}`, 'info');
  }
}

// ============================================
// BLUETOOTH SCANNING & CONNECTION
// ============================================
async function btScan() {
  btLog('Scanning for Bluetooth devices…', 'info');
  setBtUI('scanning');

  if (!navigator.bluetooth) {
    btLog('Web Bluetooth is not supported in this browser.', 'err');
    setBtUI('unsupported');
    addAlert({ icon: '⚠️', lvl: 'warn', title: 'Bluetooth Unavailable', src: 'System', urgency: 'm', unread: false, body: 'Use Chrome or Edge with Web Bluetooth support.' });
    return;
  }

  let dev = null;
  try {
    dev = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: 'BBC micro:bit' },
        { namePrefix: 'micro:bit' },
        { namePrefix: 'AlertBridge' }
      ],
      optionalServices: [NUS_SERVICE]
    });
  } catch (e) {
    if (e.name === 'NotFoundError') {
      // Try accepting all devices as fallback
      try {
        dev = await navigator.bluetooth.requestDevice({
          acceptAllDevices: true,
          optionalServices: [NUS_SERVICE]
        });
      } catch (e2) {
        btLog(`Scan cancelled or failed: ${e2.message}`, 'err');
        setBtUI('disconnected');
        return;
      }
    } else {
      btLog(`Scan cancelled: ${e.message}`, 'err');
      setBtUI('disconnected');
      return;
    }
  }

  if (dev) {
    window.__btLastDevice = dev;
    btLog(`Found: ${dev.name || 'Unknown'}`, 'ok');
    renderAvailableDevice(dev);
    await btConnectDevice(dev);
  }
}

async function btConnectDevice(dev) {
  if (!dev) return;
  btLog(`Connecting to ${dev.name || 'device'}…`, 'info');
  setBtUI('connecting');

  // Retry helper for service discovery
  async function getService(server, retries = 8, delay = 250) {
    for (let i = 0; i < retries; i++) {
      try {
        return await server.getPrimaryService(NUS_SERVICE);
      } catch {
        if (i < retries - 1) await wait(delay);
      }
    }
    throw new Error('UART service unavailable after retries');
  }

  try {
    const server = await dev.gatt.connect();
    state.btServer = server;

    const service = await getService(server);
    const tx      = await service.getCharacteristic(NUS_RX_CHAR);
    const rx      = await service.getCharacteristic(NUS_TX_CHAR);

    state.btTx         = tx;
    state.btNotifyChar = rx;
    state.btDevice     = dev;
    state.btConnected  = true;
    state.btReconnecting = false;
    state.btReconnectAttempts = 0;
    if (state.btReconnectTimer) { clearTimeout(state.btReconnectTimer); state.btReconnectTimer = null; }

    await state.btNotifyChar.startNotifications();
    state.btNotifyChar.addEventListener('characteristicvaluechanged', handleUartNotification);

    // Disconnect handler with auto-reconnect
    dev.addEventListener('gattserverdisconnected', onBtDisconnected);

    setBtUI('connected', dev.name || 'micro:bit');
    btLog('Connected ✓', 'ok');
    setLedActive('bt', true);
    await sendCmd('PING');

  } catch (e) {
    btLog(`Connection failed: ${e.message}`, 'err');
    addAlert({ icon: '❌', lvl: 'crit', title: 'Connection Failed', src: 'Bluetooth', urgency: 'h', unread: false, body: e.message });
    setBtUI('disconnected');
  }
}

// ============================================
// AUTO-RECONNECT
// ============================================
function onBtDisconnected() {
  const wasConnected = state.btConnected;
  state.btConnected  = false;
  state.btTx         = null;
  state.btNotifyChar = null;
  state.uartBuffer   = '';

  setLedActive('bt', false);

  if (wasConnected) {
    btLog('Connection lost.', 'err');
    addAlert({ icon: '⚠️', lvl: 'warn', title: 'Bluetooth Disconnected', src: 'Bluetooth', urgency: 'm', unread: false, body: 'Device disconnected. Attempting to reconnect…' });
    showReconnectBanner(true);
    updateAutoReconnectStatus('Attempting reconnect…');
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (!window.__btLastDevice || state.btReconnectAttempts >= state.btMaxReconnectAttempts) {
    if (state.btReconnectAttempts >= state.btMaxReconnectAttempts) {
      btLog('Max reconnect attempts reached. Please scan manually.', 'err');
      updateAutoReconnectStatus('Failed — scan manually');
      showReconnectBanner(false);
      setBtUI('disconnected');
    }
    return;
  }
  state.btReconnecting = true;
  state.btReconnectAttempts++;
  const delay = Math.min(1000 * state.btReconnectAttempts, 10000);
  btLog(`Reconnect attempt ${state.btReconnectAttempts}/${state.btMaxReconnectAttempts} in ${delay/1000}s…`, 'info');
  updateAutoReconnectStatus(`Attempt ${state.btReconnectAttempts}/${state.btMaxReconnectAttempts}…`);
  state.btReconnectTimer = setTimeout(() => btReconnect(), delay);
}

async function btReconnect() {
  if (!window.__btLastDevice) { setBtUI('disconnected'); return; }
  btLog('Reconnecting…', 'info');
  try {
    await btConnectDevice(window.__btLastDevice);
    showReconnectBanner(false);
  } catch {
    scheduleReconnect();
  }
}

function showReconnectBanner(show) {
  const b = $('reconnectBanner');
  if (b) b.style.display = show ? 'flex' : 'none';
}

function updateAutoReconnectStatus(text) {
  const el = $('btAutoReconnectStatus');
  if (el) el.textContent = text;
}

// ============================================
// BLUETOOTH UI STATE — single source of truth
// ============================================
function setBtUI(state_str, deviceName = '') {
  const scanBtn     = $('btScanBtn');
  const discBtn     = $('btDisconnectBtn');
  const iconWrap    = $('btIconWrap');
  const aura        = $('btAura');
  const stateTitle  = $('btStateTitle');
  const stateSub    = $('btStateSub');
  const btInfoStat  = $('btInfoStatus');
  const connInd     = $('connIndicator');
  const connLabel   = $('connLabel');
  const connSub     = $('connSublabel');
  const btChip      = $('btChip');
  const btChipLabel = $('btChipLabel');
  const settingsSub = $('settingsBtStatus');
  const cmdNote     = $('btCmdNote');
  const btNavDot    = $('btNavDot');

  const configs = {
    disconnected: {
      title: 'No Device Connected', sub: 'Scan to find your micro:bit',
      iconClass: '', auraClass: '',
      scanVisible: true, discVisible: false,
      infoStatus: 'Disconnected', infoColor: 'var(--red)',
      connClass: 'disconnected', connLabelText: 'No Device', connSubText: 'Bluetooth inactive',
      chipClass: 'status-pill', chipLabel: 'NO DEVICE',
      settingsText: 'No device connected', cmdNoteVisible: true, navDot: false,
      autoReconnect: 'Standby',
    },
    scanning: {
      title: 'Scanning…', sub: 'Looking for nearby devices',
      iconClass: '', auraClass: '',
      scanVisible: false, discVisible: false,
      infoStatus: 'Scanning…', infoColor: 'var(--amber)',
      connClass: 'disconnected', connLabelText: 'Scanning', connSubText: 'Looking for devices',
      chipClass: 'status-pill', chipLabel: 'SCANNING',
      settingsText: 'Scanning…', cmdNoteVisible: true, navDot: false,
      autoReconnect: 'Standby',
    },
    connecting: {
      title: 'Connecting…', sub: 'Establishing connection',
      iconClass: '', auraClass: '',
      scanVisible: false, discVisible: false,
      infoStatus: 'Connecting…', infoColor: 'var(--amber)',
      connClass: 'disconnected', connLabelText: 'Connecting', connSubText: 'Please wait',
      chipClass: 'status-pill', chipLabel: 'CONNECTING',
      settingsText: 'Connecting…', cmdNoteVisible: true, navDot: false,
      autoReconnect: 'Connecting…',
    },
    connected: {
      title: 'Connected', sub: deviceName,
      iconClass: 'connected', auraClass: 'connected',
      scanVisible: false, discVisible: true,
      infoStatus: 'Connected ✓', infoColor: 'var(--green)',
      connClass: '', connLabelText: 'Connected', connSubText: deviceName || 'micro:bit',
      chipClass: 'status-pill connected', chipLabel: 'BT ACTIVE',
      settingsText: deviceName || 'micro:bit', cmdNoteVisible: false, navDot: true,
      autoReconnect: 'Active',
    },
    unsupported: {
      title: 'Bluetooth Unavailable', sub: 'Use Chrome or Edge',
      iconClass: '', auraClass: '',
      scanVisible: false, discVisible: false,
      infoStatus: 'Not supported', infoColor: 'var(--red)',
      connClass: 'disconnected', connLabelText: 'Unavailable', connSubText: 'Browser incompatible',
      chipClass: 'status-pill', chipLabel: 'UNSUPPORTED',
      settingsText: 'Bluetooth unavailable', cmdNoteVisible: true, navDot: false,
      autoReconnect: 'N/A',
    }
  };

  const cfg = configs[state_str] || configs.disconnected;

  if (stateTitle)  stateTitle.textContent  = cfg.title;
  if (stateSub)    stateSub.textContent    = cfg.sub;
  if (iconWrap)    { iconWrap.className = 'bt-hero-icon'; if (cfg.iconClass) iconWrap.classList.add(cfg.iconClass); }
  if (aura)        { aura.className = 'bt-aura'; if (cfg.auraClass) aura.classList.add(cfg.auraClass); }
  if (scanBtn)     scanBtn.style.display  = cfg.scanVisible  ? '' : 'none';
  if (discBtn)     discBtn.style.display  = cfg.discVisible  ? '' : 'none';
  if (btInfoStat)  { btInfoStat.textContent = cfg.infoStatus; btInfoStat.style.color = cfg.infoColor; }
  if (connInd)     { connInd.className = 'conn-indicator'; if (cfg.connClass) connInd.classList.add(cfg.connClass); }
  if (connLabel)   connLabel.textContent   = cfg.connLabelText;
  if (connSub)     connSub.textContent     = cfg.connSubText;
  if (btChip)      btChip.className        = cfg.chipClass;
  if (btChipLabel) btChipLabel.textContent = cfg.chipLabel;
  if (settingsSub) settingsSub.textContent = cfg.settingsText;
  if (cmdNote)     cmdNote.style.display   = cfg.cmdNoteVisible ? '' : 'none';
  if (btNavDot)    { btNavDot.classList.toggle('visible', cfg.navDot); }
  updateAutoReconnectStatus(cfg.autoReconnect);
  updateCounts();
}

// ============================================
// DISCONNECT
// ============================================
async function btDisconnect() {
  // Cancel auto-reconnect
  state.btReconnectAttempts = state.btMaxReconnectAttempts; // prevent further reconnects
  if (state.btReconnectTimer) { clearTimeout(state.btReconnectTimer); state.btReconnectTimer = null; }
  state.btReconnecting = false;
  showReconnectBanner(false);

  if (state.btNotifyChar) {
    try { state.btNotifyChar.removeEventListener('characteristicvaluechanged', handleUartNotification); } catch {}
    state.btNotifyChar = null;
  }
  if (state.btDevice) {
    try { if (state.btDevice.gatt.connected) state.btDevice.gatt.disconnect(); } catch {}
    state.btDevice.removeEventListener('gattserverdisconnected', onBtDisconnected);
    state.btDevice = null;
  }

  state.btConnected = false;
  state.btTx = null;
  state.uartBuffer = '';
  state.btReconnectAttempts = 0;
  setLedActive('bt', false);
  setBtUI('disconnected');
  btLog('Manually disconnected.', 'info');
  renderDeviceEmptyState('No device connected');
}

// ============================================
// SEND COMMANDS
// ============================================
async function sendCmd(cmd) {
  btLog(`TX → ${cmd}`, 'info');

  if (!state.btConnected || !state.btTx) {
    btLog('Not connected — cannot send.', 'err');
    // Still trigger visual alert in demo mode for test buttons
    const [type, urg, src] = cmd.split(':');
    if (type && type !== 'PING' && type !== 'FIND') {
      triggerAlert(type.toLowerCase(), urg || 'l', src || 'DEMO');
    }
    return;
  }

  // Check GATT connection health before writing
  if (!state.btDevice || !state.btDevice.gatt.connected) {
    btLog('GATT disconnected — triggering reconnect.', 'err');
    onBtDisconnected();
    return;
  }

  try {
    const encoded = new TextEncoder().encode(cmd + '\n');
    await state.btTx.writeValue(encoded);
    btLog(`Sent ✓`, 'ok');
    setLedActive('tx', true);
    setTimeout(() => setLedActive('tx', false), 400);
  } catch (e) {
    btLog(`Send failed: ${e.message}`, 'err');
    if (e.message.includes('GATT') || e.message.includes('disconnected')) {
      onBtDisconnected();
    }
    return;
  }

  const [type, urg, src] = cmd.split(':');
  if (type === 'TEST') { screenFlash('#c084fc'); return; }
  if (type === 'PING' || type === 'FIND') return;
  if (type) triggerAlert(type.toLowerCase(), urg || 'l', src || 'PHONE');
}

function sendCustomCmd() {
  const v = $('customCmd')?.value?.trim();
  if (v) { sendCmd(v); $('customCmd').value = ''; }
}

// ============================================
// ALERT TRIGGERING
// ============================================
function triggerAlert(type, urgency = 'l', src = 'PHONE') {
  const cfg = SOURCE_CONFIG[type] || { icon: '🔔', title: 'Alert', urgency: 'l' };
  addAlert({
    icon: cfg.icon,
    lvl: urgency === 'h' ? 'crit' : urgency === 'm' ? 'warn' : 'info',
    title: cfg.title,
    src,
    urgency,
    unread: true,
    body: `${cfg.title} from ${src}. Command: ${type.toUpperCase()}:${urgency.toUpperCase()}`
  });
  screenFlash(urgency === 'h' ? '#fb7185' : urgency === 'm' ? '#fbbf24' : '#c084fc');
}

// ============================================
// DEVICE LIST RENDERING
// ============================================
function renderDeviceEmptyState(msg = 'No devices found') {
  const list = $('btDeviceList');
  if (!list) return;
  list.innerHTML = `
    <div class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="22" height="22">
          <polyline points="6.5 6.5 17.5 17.5 12 23 12 1 17.5 6.5 6.5 17.5"/>
        </svg>
      </div>
      <p>${escapeHtml(msg)}</p>
      <span>Turn on Bluetooth and scan again</span>
    </div>`;
}

function renderAvailableDevice(dev) {
  const list = $('btDeviceList');
  if (!list) return;
  list.innerHTML = `
    <div class="bt-device-item paired" onclick="btConnectDevice(window.__btLastDevice)">
      <div class="bt-dev-icon">📟</div>
      <div>
        <div class="bt-dev-name">${escapeHtml(dev.name || 'Unknown device')}</div>
        <div class="bt-dev-sub">Available — tap to connect</div>
      </div>
      <div class="bt-signal"><span></span><span></span><span></span></div>
    </div>`;
}

// ============================================
// SETTINGS
// ============================================
function resetSettings() {
  if (confirm('Reset all settings to defaults?')) location.reload();
}

// ============================================
// GMAIL INTEGRATION
// ============================================
let tokenClient;

function initGmail() {
  const signInBtn  = $('googleSignInBtn');
  const signOutBtn = $('googleSignOutBtn');
  if (!signInBtn || !signOutBtn) return;

  signInBtn.onclick = () => {
    if (typeof google === 'undefined') {
      alert('Google API not loaded. Check your connection.');
      return;
    }
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID,
      scope: GMAIL_SCOPE,
      callback: (res) => {
        if (res.access_token) {
          state.gmailToken = res.access_token;
          $('gmailStatus').textContent = 'Connected';
          fetchGmailProfile();
          fetchGmail();
          if (state.gmailPollingTimer) clearInterval(state.gmailPollingTimer);
          state.gmailPollingTimer = setInterval(fetchGmail, 15000);
        }
      }
    });
    tokenClient.requestAccessToken();
  };

  signOutBtn.onclick = () => {
    state.gmailToken = null;
    state.gmailEmail = null;
    state.gmailKnownIds.clear();
    state.gmailBaselineCaptured = false;
    state.gmailMessages = [];
    if (state.gmailPollingTimer) { clearInterval(state.gmailPollingTimer); state.gmailPollingTimer = null; }

    if ($('gmailStatus'))     $('gmailStatus').textContent  = 'Not connected';
    if ($('connectedEmail'))  $('connectedEmail').textContent = '—';
    signInBtn.style.display  = '';
    signOutBtn.style.display = 'none';
    const feed = $('gmailFeed');
    if (feed) feed.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
        </div>
        <p>Not connected</p>
        <span>Sign in to load emails</span>
      </div>`;
  };
}

async function fetchGmailProfile() {
  if (!state.gmailToken) return;
  try {
    const res  = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${state.gmailToken}` }
    });
    const data = await res.json();
    state.gmailEmail = data.emailAddress;
    if ($('connectedEmail')) $('connectedEmail').textContent = state.gmailEmail || '—';
    $('googleSignInBtn').style.display  = 'none';
    $('googleSignOutBtn').style.display = '';
  } catch (e) {
    console.error('Gmail profile error', e);
  }
}

async function fetchGmail() {
  if (!state.gmailToken) return;
  try {
    const res = await fetch('https://www.googleapis.com/gmail/v1/users/me/messages?q=is:unread&maxResults=15', {
      headers: { Authorization: `Bearer ${state.gmailToken}` }
    });
    if (!res.ok) throw new Error('Gmail API error ' + res.status);
    const data = await res.json();
    const messages = data.messages || [];

    const newIds = new Set();
    if (!state.gmailBaselineCaptured) {
      messages.forEach(m => state.gmailKnownIds.add(m.id));
      state.gmailBaselineCaptured = true;
    } else {
      messages.forEach(m => {
        if (!state.gmailKnownIds.has(m.id)) {
          state.gmailKnownIds.add(m.id);
          newIds.add(m.id);
        }
      });
    }

    if (!messages.length) {
      const feed = $('gmailFeed');
      if (feed) feed.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div><p>Inbox zero</p><span>No unread emails</span></div>`;
      return;
    }

    const details = await Promise.all(
      messages.slice(0, 10).map(m =>
        fetch(`https://www.googleapis.com/gmail/v1/users/me/messages/${m.id}`, {
          headers: { Authorization: `Bearer ${state.gmailToken}` }
        }).then(r => r.json())
      )
    );

    state.gmailMessages = details.map(msg => {
      const headers  = msg.payload?.headers || [];
      const subject  = headers.find(h => h.name === 'Subject')?.value || '(No subject)';
      const from     = headers.find(h => h.name === 'From')?.value    || 'Unknown';
      const sentAt   = msg.internalDate
        ? new Date(parseInt(msg.internalDate)).toLocaleString('en-SG', { hour12: false })
        : '';
      const content  = getMessageBody(msg.payload) || msg.snippet || '(No preview)';
      const isNew    = newIds.has(msg.id);

      if (isNew) {
        if (state.btConnected) sendCmd('EMAIL:LOW');
        else addAlert({ id: msg.id, icon: '✉️', lvl: 'warn', title: 'New Email', src: 'Gmail', urgency: 'l', unread: true, body: `From: ${from}` });
      }

      return { id: msg.id, subject, from, sentAt, content };
    });

    const feed = $('gmailFeed');
    if (feed) {
      feed.innerHTML = state.gmailMessages.map(m => `
        <div class="gmail-item" onclick="openGmailMessage(${JSON.stringify(m.id)})">
          <div class="gmail-subject">${escapeHtml(m.subject)}</div>
          <div class="gmail-meta">${escapeHtml(m.from)}</div>
          <div class="gmail-snippet">${escapeHtml(m.sentAt)}</div>
        </div>`).join('');
    }
  } catch (e) {
    console.error('Gmail fetch error', e);
    btLog('Gmail fetch error: ' + e.message, 'err');
  }
}

function clearGmailFeed() {
  state.gmailMessages = [];
  const feed = $('gmailFeed');
  if (feed) feed.innerHTML = `<div class="empty-state"><div class="empty-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="24" height="24"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg></div><p>Feed cleared</p></div>`;
}

function openGmailMessage(id) {
  const msg = state.gmailMessages.find(m => m.id === id);
  if (!msg) return;
  state.currentGmailId = id;
  state.currentAlertId = null;
  $('mIcon').textContent  = '✉️';
  $('mTitle').textContent = msg.subject;
  $('mSub').textContent   = `${msg.from} · ${msg.sentAt}`;
  $('mBody').innerHTML = `
    <div style="display:flex;flex-direction:column;gap:8px;font-family:var(--mono);font-size:11px;">
      <div><strong>From:</strong> ${escapeHtml(msg.from)}</div>
      <div><strong>Sent:</strong> ${escapeHtml(msg.sentAt)}</div>
      <div style="padding-top:8px;border-top:1px solid rgba(255,255,255,0.06);white-space:pre-wrap;color:var(--text-dim);">${escapeHtml(msg.content.slice(0, 500))}</div>
    </div>`;
  $('alertModal').classList.add('open');
}

// ============================================
// GMAIL HELPERS
// ============================================
function getMessageBody(payload) {
  if (!payload) return '';
  if (payload.parts) {
    for (const p of payload.parts) {
      const t = getMessageBody(p);
      if (t) return t;
    }
  }
  if (['text/plain', 'text/html'].includes(payload.mimeType) && payload.body?.data) {
    const decoded = decodeGmailBase64(payload.body.data);
    return payload.mimeType === 'text/html' ? decoded.replace(/<[^>]+>/g, '') : decoded;
  }
  if (payload.body?.data) return decodeGmailBase64(payload.body.data);
  return '';
}

function decodeGmailBase64(data) {
  try {
    const raw = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
    return decodeURIComponent(raw.split('').map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)).join(''));
  } catch {
    try { return atob(data.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; }
  }
}

// ============================================
// INITIALIZATION
// ============================================
document.addEventListener('DOMContentLoaded', () => {
  buildMicroGrid();
  buildChart();
  renderAlerts();
  setBtUI('disconnected');
  renderDeviceEmptyState('No devices found');
  switchPage('dashboard');
  initGmail();
});
