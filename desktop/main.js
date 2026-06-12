/**
 * Chaotic 3D Slicer — desktop launcher (Electron).
 *
 * On launch it: (1) auto-finds ElegooSlicer + its presets on this PC and imports
 * them, (2) starts the existing Express server in-process, (3) shows a small
 * window telling the user how to reach it from their phone (URL + QR), and
 * (4) lives in the system tray (Docker-Desktop style) — closing the window hides
 * it to the tray instead of quitting; quit only from the tray menu.
 */
const { app, BrowserWindow, Tray, Menu, shell, ipcMain, nativeImage } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { detect, applyToEnv } = require('./detect');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 3443;
let tray = null;
let win = null;
let info = { detect: null, urls: [], httpsUrls: [], caUrl: '', port: PORT, httpsPort: HTTPS_PORT };

// Only one instance — second launch just reveals the existing window/tray.
if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());

// Private-LAN IPv4 addresses (what the phone can reach), Tailscale excluded,
// home Wi-Fi (192.168.*) first.
function isTailscale(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 100 && p[1] >= 64 && p[1] <= 127;
}
function lanIps() {
  const lan = [], ts = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      (isTailscale(ni.address) ? ts : lan).push(ni.address);
    }
  }
  lan.sort((a, b) => (b.startsWith('192.168.') ? 1 : 0) - (a.startsWith('192.168.') ? 1 : 0));
  return { lan, ts };
}

async function startServer() {
  // The packaged app bundle is read-only — keep uploads/output/certs in a
  // user-writable folder.
  if (!process.env.DATA_DIR) process.env.DATA_DIR = app.getPath('userData');
  const d = detect();
  info.detect = d;
  if (d.ok) applyToEnv(d); // feed the detected slicer + presets to the server
  // Start the bundled Express backend (server.js auto-listens on require).
  try {
    require(path.join(__dirname, '..', 'server.js'));
  } catch (e) {
    info.serverError = e.message;
  }
  const { lan, ts } = lanIps();
  info.urls = lan.map((ip) => `http://${ip}:${info.port}`);
  info.httpsUrls = lan.map((ip) => `https://${ip}:${info.httpsPort}`);
  info.remoteUrls = ts.map((ip) => `https://${ip}:${info.httpsPort}`); // Tailscale
  info.caUrl = lan[0] ? `http://${lan[0]}:${info.port}/rootCA.crt` : '';
}

function showWindow() {
  if (win) { win.show(); win.focus(); return; }
  win = new BrowserWindow({
    width: 460,
    height: 600,
    resizable: false,
    title: 'Chaotic 3D Slicer',
    autoHideMenuBar: true,
    icon: trayIconPath(),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
  });
  win.loadFile(path.join(__dirname, 'window.html'));
  // Close → hide to tray instead of quitting.
  win.on('close', (e) => {
    if (!app.isQuitting) { e.preventDefault(); win.hide(); }
  });
}

function trayIconPath() {
  const p = path.join(__dirname, '..', 'client', 'public', 'icons', 'icon-192.png');
  return fs.existsSync(p) ? p : undefined;
}

function buildTray() {
  const img = trayIconPath();
  tray = new Tray(img ? nativeImage.createFromPath(img).resize({ width: 16, height: 16 }) : nativeImage.createEmpty());
  tray.setToolTip('Chaotic 3D Slicer — running');
  const menu = Menu.buildFromTemplate([
    { label: 'Open dashboard', click: showWindow },
    { label: 'Open in browser', click: () => shell.openExternal(`http://localhost:${info.port}`) },
    { type: 'separator' },
    { label: 'Quit Chaotic 3D Slicer', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', showWindow);
}

// IPC: the window asks for the connection info (URLs, detection, QR).
ipcMain.handle('get-info', async () => {
  let qr = null, caQr = null;
  try {
    const QRCode = require('qrcode');
    const target = info.httpsUrls[0] || info.urls[0];
    if (target) qr = await QRCode.toDataURL(target, { margin: 1, width: 220 });
    if (info.caUrl) caQr = await QRCode.toDataURL(info.caUrl, { margin: 1, width: 150 });
  } catch { /* qrcode optional */ }
  return { ...info, qr, caQr };
});
ipcMain.handle('open-external', (_e, url) => shell.openExternal(url));

// `--tray` / `--hidden` (used by the "start with Windows" autostart entry) boots
// straight to the tray without popping the window.
const startHidden = process.argv.includes('--tray') || process.argv.includes('--hidden');

app.whenReady().then(async () => {
  await startServer();
  buildTray();
  if (!startHidden) showWindow();
});

app.on('window-all-closed', (e) => { /* keep running in tray */ });
app.on('before-quit', () => { app.isQuitting = true; });
