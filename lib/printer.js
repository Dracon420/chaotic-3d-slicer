/**
 * Elegoo SDCP (a.k.a. "ElegooLink") network client for the Centauri Carbon.
 *
 * Two steps to print over the network:
 *   1. UPLOAD  — HTTP POST the .gcode in 1 MB chunks to
 *                http://<ip>:3030/uploadFile/upload  (whole-file MD5 verify).
 *   2. START   — WebSocket ws://<ip>:3030/websocket, send Cmd 128 referencing
 *                the uploaded file as /local/<name>.
 *
 * Only the documented Cmd 0 (status, read-only) and Cmd 128 (start print) are
 * ever sent — the protocol docs warn that unknown command codes can crash the
 * printer's daemon. Printer IPs + MainboardIDs come from ElegooSlicer's own
 * printer_list.json, so no UDP discovery is required.
 *
 * Protocol references: docs.opencentauri.cc, cbd-tech/SDCP-V3.0.0, bjan/pycentauri.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const crypto = require('crypto');
const WebSocket = require('ws');
const mqtt = require('mqtt');

const CHUNK = 1024 * 1024; // 1 MB packets, per SDCP spec
const SDCP_PORT = 3030;

/** Read the printers the user already configured in the ElegooSlicer GUI. */
function readConfiguredPrinters(presetRoot) {
  const file = path.join(presetRoot, 'user', 'printer_list.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  return Object.values(raw)
    .filter((e) => e && e.host && /elegoo/i.test(e.hostType || ''))
    .map((e) => ({
      name: e.printerName || e.printerModel || e.host,
      model: e.printerModel || '',
      host: e.host,
      mainboardId: e.mainboardId || '',
      firmware: e.firmwareVersion || '',
      protocol: detectProtocol(e.printerModel || '', e.firmwareVersion || ''),
      lastActive: e.lastActiveTime || 0,
    }))
    .sort((a, b) => b.lastActive - a.lastActive);
}

/**
 * Which network protocol a printer speaks:
 *   'mqtt' — Centauri Carbon 2 / firmware 02.x (MQTT broker on :1883)
 *   'sdcp' — original Centauri Carbon / firmware V1.x (SDCP WebSocket on :3030)
 */
function detectProtocol(model, firmware) {
  if (/centauri carbon 2|cc2/i.test(model) || /^0?2\./.test(firmware)) return 'mqtt';
  return 'sdcp';
}

/** HTTP-upload a file to the printer in 1 MB chunks (CC1 uploads on port 80). */
async function uploadFile({ host, filePath, fileName, onLog = () => {} }) {
  const buf = fs.readFileSync(filePath);
  const total = buf.length;
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  const uuid = crypto.randomUUID().replace(/-/g, '');
  const url = `http://${host}/uploadFile/upload`;

  onLog(`Uploading ${fileName} (${(total / 1024 / 1024).toFixed(2)} MB) to ${host}…`);

  for (let offset = 0; offset < total || offset === 0; offset += CHUNK) {
    const chunk = buf.subarray(offset, Math.min(offset + CHUNK, total));
    const form = new FormData();
    form.append('S-File-MD5', md5);
    form.append('Check', '1');
    form.append('Offset', String(offset));
    form.append('Uuid', uuid);
    form.append('TotalSize', String(total));
    form.append('File', new Blob([chunk]), fileName);

    let res;
    try {
      res = await fetch(url, { method: 'POST', body: form });
    } catch (err) {
      throw new Error(
        `Could not reach printer at ${host}:${SDCP_PORT} — make sure it's powered on ` +
          `and awake (it drops the network service when idle/asleep). [${err.message}]`
      );
    }
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    if (!res.ok || (json && json.success === false)) {
      throw new Error(`Upload rejected at offset ${offset}: ${text.slice(0, 200)}`);
    }
    onLog(`  …${Math.min(offset + CHUNK, total)}/${total} bytes`);
    if (offset + CHUNK >= total) break;
  }
  return { md5, fileName };
}

/**
 * Open the SDCP WebSocket, send one command, and resolve with the printer's
 * first matching response. Used for Cmd 0 (status) and Cmd 128 (start print).
 */
function sendCommand({ host, mainboardId, cmd, data = {}, onLog = () => {}, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID().replace(/-/g, '');
    let ws;
    try {
      ws = new WebSocket(`ws://${host}:${SDCP_PORT}/websocket`, { maxPayload: 0 });
    } catch (err) {
      return reject(err);
    }

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Printer did not respond in time')),
      timeoutMs
    );

    ws.on('open', () => {
      const envelope = {
        Id: '',
        Data: {
          Cmd: cmd,
          Data: data,
          RequestID: requestId,
          MainboardID: mainboardId || '',
          TimeStamp: Date.now(),
          From: 1,
        },
        Topic: `sdcp/request/${mainboardId}`,
      };
      ws.send(JSON.stringify(envelope));
    });

    ws.on('message', (raw) => {
      let s = raw.toString();
      const brace = s.indexOf('{'); // strip any numeric length prefix
      if (brace > 0) s = s.slice(brace);
      let msg;
      try {
        msg = JSON.parse(s);
      } catch {
        return;
      }
      const d = msg.Data || {};
      // Only react to the response to *our* request (ignore status pushes).
      if (d.RequestID && d.RequestID !== requestId) return;
      const ack = d.Data && (d.Data.Ack ?? d.Data.ack);
      onLog(`printer ◂ ${s.slice(0, 200)}`);
      if (ack !== undefined && ack !== 0) {
        finish(reject, new Error(`Printer returned Ack ${ack}`));
      } else {
        finish(resolve, { ack: ack ?? 0, response: msg });
      }
    });

    ws.on('error', (err) => finish(reject, new Error(`WebSocket error: ${err.message}`)));
  });
}

/** Read-only connectivity check (Cmd 0 = get status). Safe at any time. */
function testConnection({ host, mainboardId, onLog }) {
  return sendCommand({ host, mainboardId, cmd: 0, data: {}, onLog, timeoutMs: 8000 });
}

/**
 * Start printing an already-uploaded file (Cmd 128). Matches ElegooSlicer's
 * own request, captured from the wire: the Filename is the BARE name (no
 * /local/ prefix), and Calibration/Tlp switches are on.
 */
function startPrint({ host, mainboardId, fileName, onLog }) {
  return sendCommand({
    host,
    mainboardId,
    cmd: 128,
    data: {
      Filename: fileName,
      StartLayer: 0,
      Calibration_switch: 1,
      PrintPlatformType: 0,
      Tlp_Switch: 1,
      slot_map: [],
    },
    onLog,
    timeoutMs: 20000,
  });
}

// ─────────────────────────────────────────────────────────────
//  CC2 (firmware 02.x) — MQTT protocol
// ─────────────────────────────────────────────────────────────

/**
 * Run one MQTT JSON-RPC command against a CC2: connect, register, publish
 * { id, method, params } to .../api_request, and resolve with the matching
 * result from .../api_response. error_code 0 = success.
 */
function mqttRequest({ host, mainboardId, method, params = {}, onLog = () => {}, timeoutMs = 15000 }) {
  return new Promise((resolve, reject) => {
    const clientId = `1_PC_${Math.floor(1000 + Math.random() * 9000)}`;
    const reqTopic = `elegoo/${mainboardId}/${clientId}/api_request`;
    const respTopic = `elegoo/${mainboardId}/${clientId}/api_response`;
    const regReqTopic = `elegoo/${mainboardId}/api_register`;
    const regRespTopic = `elegoo/${mainboardId}/${clientId}_req/register_response`;
    const id = 100000 + Math.floor(Math.random() * 899999);

    const client = mqtt.connect(`mqtt://${host}:1883`, {
      username: 'elegoo',
      password: '123456',
      clientId,
      connectTimeout: timeoutMs,
      reconnectPeriod: 0,
    });

    let settled = false;
    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.end(true); } catch { /* ignore */ }
      fn(arg);
    };
    const timer = setTimeout(
      () => finish(reject, new Error(`Printer at ${host} did not respond (MQTT timeout) — is it awake?`)),
      timeoutMs
    );

    client.on('error', (e) => finish(reject, new Error(`MQTT error: ${e.message}`)));
    client.on('connect', () => {
      client.subscribe([respTopic, regRespTopic, `elegoo/${mainboardId}/api_status`], () => {
        client.publish(regReqTopic, JSON.stringify({ client_id: clientId, request_id: `${clientId}_req` }));
      });
    });

    let sent = false;
    client.on('message', (topic, payload) => {
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { return; }
      if (topic === regRespTopic && !sent) {
        if (msg.error === 'ok') {
          sent = true;
          onLog(`registered with ${host} as ${clientId}`);
          client.publish(reqTopic, JSON.stringify({ id, method, params }));
        }
        return;
      }
      if (topic === respTopic && msg.id === id) {
        const code = msg.result && msg.result.error_code;
        if (code === 0 || code === undefined) finish(resolve, msg.result || {});
        else finish(reject, new Error(`Printer rejected method ${method} (error_code ${code})`));
      }
    });
  });
}

/** CC2: read the 4 Canvas filament slots (method 2005). Read-only. */
async function getCanvasFilaments({ host, mainboardId, onLog }) {
  const result = await mqttRequest({ host, mainboardId, method: 2005, onLog, timeoutMs: 10000 });
  const list = result?.canvas_info?.canvas_list || [];
  const trays = [];
  for (const canvas of list) {
    for (const t of canvas.tray_list || []) {
      trays.push({
        canvasId: canvas.canvas_id,
        trayId: t.tray_id,
        name: t.filament_name,
        type: t.filament_type,
        color: t.filament_color,
        brand: t.brand,
        minTemp: t.min_nozzle_temp,
        maxTemp: t.max_nozzle_temp,
        loaded: t.status === 1,
      });
    }
  }
  return trays;
}

/**
 * CC2: read live status — used to diagnose why a print didn't start. Connects,
 * queries method 1002 (machine status) + 2005 (canvas), and listens to the
 * api_status broadcast for a few seconds. Returns a digest of the useful fields.
 */
function getStatus({ host, mainboardId, onLog = () => {}, durationMs = 8000 }) {
  return new Promise((resolve) => {
    const clientId = `1_PC_${Math.floor(1000 + Math.random() * 9000)}`;
    const reqTopic = `elegoo/${mainboardId}/${clientId}/api_request`;
    const respTopic = `elegoo/${mainboardId}/${clientId}/api_response`;
    const regReqTopic = `elegoo/${mainboardId}/api_register`;
    const regRespTopic = `elegoo/${mainboardId}/${clientId}_req/register_response`;
    const statusTopic = `elegoo/${mainboardId}/api_status`;

    let client;
    try {
      client = mqtt.connect(`mqtt://${host}:1883`, {
        username: 'elegoo', password: '123456', clientId,
        connectTimeout: durationMs, reconnectPeriod: 0,
      });
    } catch (e) {
      return resolve({ reachable: false, error: e.message });
    }

    const responses = {};
    const statuses = [];
    let registered = false;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.end(true); } catch { /* ignore */ }
      resolve(digestStatus(responses, statuses));
    };
    const timer = setTimeout(finish, durationMs);

    client.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.end(true); } catch { /* ignore */ }
      resolve({ reachable: false, error: e.message });
    });
    client.on('connect', () => {
      client.subscribe([respTopic, regRespTopic, statusTopic], () => {
        client.publish(regReqTopic, JSON.stringify({ client_id: clientId, request_id: `${clientId}_req` }));
      });
    });
    client.on('message', (topic, payload) => {
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { return; }
      if (topic === regRespTopic && !registered) {
        registered = true;
        onLog(`status: registered with ${host}`);
        client.publish(reqTopic, JSON.stringify({ id: 1, method: 1002, params: {} }));
        client.publish(reqTopic, JSON.stringify({ id: 2, method: 2005, params: {} }));
        return;
      }
      if (topic === respTopic && msg.result) responses[msg.method] = msg.result;
      else if (topic === statusTopic) statuses.push(msg);
    });
  });
}

function digestStatus(responses, statuses) {
  const s1002 = responses[1002] || {};
  const canvas = (responses[2005] || {}).canvas_info || {};
  const last = statuses[statuses.length - 1] || {};
  const pi = last.PrintInfo || (last.Status && last.Status.PrintInfo) || {};
  const ex = s1002.extruder || {};
  const bed = s1002.heater_bed || {};
  return {
    reachable: true,
    printStatus: pi.Status,
    printError: pi.ErrorCode ?? pi.error ?? last.ErrorCode,
    errorCode: s1002.error_code,
    nozzle: { temp: ex.temperature, target: ex.target },
    bed: { temp: bed.temperature, target: bed.target },
    filamentDetected: ex.filament_detected === 1 || ex.filament_detected === true,
    activeTray: canvas.active_tray_id,
    activeCanvas: canvas.active_canvas_id,
    statusCount: statuses.length,
  };
}

/** CC2: HTTP PUT the raw G-code to the printer's /upload. */
async function uploadFileCC2({ host, filePath, fileName, onLog = () => {} }) {
  const buf = fs.readFileSync(filePath);
  const md5 = crypto.createHash('md5').update(buf).digest('hex');
  onLog(`Uploading ${fileName} (${(buf.length / 1024 / 1024).toFixed(2)} MB) to ${host}…`);
  let res;
  try {
    res = await fetch(`http://${host}/upload`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Range': `bytes 0-${buf.length - 1}/${buf.length}`,
        'X-File-Name': fileName,
        'X-File-MD5': md5,
        'X-Token': '123456',
        Accept: 'application/json',
      },
      body: buf,
    });
  } catch (err) {
    throw new Error(`Could not reach printer at ${host} — is it powered on and awake? [${err.message}]`);
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`Upload rejected: ${res.status} ${text.slice(0, 200)}`);
  onLog(`Upload complete (${res.status}).`);
  return { md5 };
}

/**
 * CC2: start printing an uploaded file. This replicates ElegooSlicer's EXACT
 * print-start handshake, captured live from its MQTT traffic — the Canvas only
 * engages if we match it:
 *   1. method 2004 {auto_refill:false}  — Canvas setup, sent right before start.
 *   2. method 1020 with config.delay_video:false and a FULL slot_map covering
 *      all 4 trays (identity: gcode filament index t -> physical tray t). Sending
 *      only the single used tray (what we did before) left the Canvas unmapped
 *      so it never fed — even with ElegooSlicer's own gcode.
 * slotMap may be supplied; otherwise we send the 4-entry identity map.
 */
async function startPrintCC2({ host, mainboardId, fileName, slotMap, onLog = () => {} }) {
  const fullMap =
    slotMap && slotMap.length
      ? slotMap
      : [0, 1, 2, 3].map((i) => ({ canvas_id: 0, t: i, tray_id: i }));

  // 1) Disable auto-refill first, exactly as ElegooSlicer does (non-fatal).
  try {
    await mqttRequest({ host, mainboardId, method: 2004, params: { auto_refill: false }, onLog, timeoutMs: 10000 });
  } catch (e) {
    onLog(`auto_refill setup skipped: ${e.message}`);
  }

  // 2) Start the print.
  return mqttRequest({
    host,
    mainboardId,
    method: 1020,
    params: {
      config: {
        bedlevel_force: false,
        delay_video: false,
        print_layout: 'A',
        printer_check: true,
        slot_map: fullMap,
      },
      filename: fileName,
      storage_media: 'local',
    },
    onLog,
    timeoutMs: 20000,
  });
}

// ─────────────────────────────────────────────────────────────
//  Network discovery
// ─────────────────────────────────────────────────────────────

/** Resolve with true if a TCP port is open within `timeout` ms. */
function tcpOpen(host, port, timeout = 1200) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    s.setTimeout(timeout);
    s.on('connect', () => fin(true));
    s.on('timeout', () => fin(false));
    s.on('error', () => fin(false));
  });
}

/** CC2 (MQTT) device info via method 1001 — returns name/model/sn or null. */
async function getDeviceInfoCC2(host, mainboardId) {
  try {
    const r = await mqttRequest({ host, mainboardId, method: 1001, timeoutMs: 6000 });
    return { name: r.hostname, model: r.machine_model, sn: r.sn };
  } catch {
    return null;
  }
}

/** Connect to a printer's MQTT broker and read its MainboardID from the topic
 *  tree (elegoo/<MainboardID>/...). Returns the id or null. */
function discoverMqttMainboard(host, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let client;
    try {
      client = mqtt.connect(`mqtt://${host}:1883`, {
        username: 'elegoo', password: '123456',
        clientId: `1_PC_${Math.floor(1000 + Math.random() * 9000)}`,
        connectTimeout: timeoutMs, reconnectPeriod: 0,
      });
    } catch {
      return resolve(null);
    }
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      clearTimeout(t);
      try { client.end(true); } catch { /* ignore */ }
      resolve(v);
    };
    const t = setTimeout(() => fin(null), timeoutMs);
    client.on('error', () => fin(null));
    client.on('connect', () => client.subscribe('elegoo/#'));
    client.on('message', (topic) => {
      const m = topic.match(/^elegoo\/([^/]+)\//);
      if (m && m[1] && m[1].length > 4) fin(m[1]);
    });
  });
}

/** SDCP (CC1) reachability + MainboardID. The board id lives in
 *  Data.MainboardID — NOT the top-level `Id`, which is a per-connection
 *  session token. (Storing the session token as the MainboardID made Cmd 128
 *  start requests fail with Ack 2.) */
async function discoverSdcp(host) {
  try {
    const r = await testConnection({ host, mainboardId: '', onLog: () => {} });
    return r.response?.Data?.MainboardID || r.response?.Id || '';
  } catch {
    return null;
  }
}

/**
 * Scan the local subnet(s) for Elegoo printers. Looks for the MQTT broker
 * (:1883 → CC2-style, fw 02.x) and the SDCP WebSocket (:3030 → CC1-style,
 * fw V1.x), then identifies each. Returns [{ host, protocol, name, model,
 * mainboardId, online }]. Slow-ish (a few seconds) — meant for a manual button.
 */
async function scanNetwork({ onLog = () => {} } = {}) {
  const bases = new Set();
  const selfIps = new Set();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      const [a, b] = ni.address.split('.').map(Number);
      // Skip Tailscale / carrier-grade NAT (100.64.0.0/10) and link-local.
      if (a === 100 && b >= 64 && b <= 127) continue;
      if (a === 169 && b === 254) continue;
      selfIps.add(ni.address);
      bases.add(ni.address.split('.').slice(0, 3).join('.'));
    }
  }
  onLog(`Scanning ${bases.size} subnet(s) for printers…`);

  const hits = {}; // host -> { mqtt, sdcp }
  const jobs = [];
  for (const base of bases) {
    for (let i = 1; i <= 254; i++) {
      const host = `${base}.${i}`;
      if (selfIps.has(host)) continue; // don't scan ourselves (our own broker)
      jobs.push(
        tcpOpen(host, 1883).then((ok) => { if (ok) (hits[host] = hits[host] || {}).mqtt = true; }),
        tcpOpen(host, SDCP_PORT).then((ok) => { if (ok) (hits[host] = hits[host] || {}).sdcp = true; })
      );
    }
  }
  await Promise.all(jobs);
  onLog(`Probing ${Object.keys(hits).length} candidate(s)…`);

  // Identify candidates in parallel. An MQTT host only counts if it exposes the
  // elegoo/<MainboardID> topics (filters out unrelated brokers like Home Assistant).
  const results = await Promise.all(
    Object.entries(hits).map(async ([host, ports]) => {
      if (ports.mqtt) {
        const mainboardId = await discoverMqttMainboard(host, 3000);
        if (!mainboardId) return null; // not an Elegoo printer
        const info = await getDeviceInfoCC2(host, mainboardId);
        return { host, protocol: 'mqtt', mainboardId, name: info?.name || `Printer @ ${host}`, model: info?.model || '', online: true };
      }
      if (ports.sdcp) {
        const mainboardId = await discoverSdcp(host);
        if (mainboardId === null) return null; // didn't answer SDCP
        return { host, protocol: 'sdcp', mainboardId: mainboardId || '', name: `Printer @ ${host}`, model: '', online: true };
      }
      return null;
    })
  );

  const printers = results.filter(Boolean);
  onLog(`Found ${printers.length} printer(s).`);
  return printers;
}

/** Quick reachability check for a known printer (mqtt→:1883, sdcp→:3030). */
function printerOnline(host, protocol) {
  return tcpOpen(host, protocol === 'mqtt' ? 1883 : SDCP_PORT, 1500);
}

module.exports = {
  readConfiguredPrinters,
  detectProtocol,
  scanNetwork,
  printerOnline,
  getDeviceInfoCC2,
  // CC1 (SDCP / WebSocket)
  uploadFile,
  startPrint,
  testConnection,
  discoverSdcp,
  // CC2 (MQTT)
  getCanvasFilaments,
  getStatus,
  discoverMqttMainboard,
  uploadFileCC2,
  startPrintCC2,
};
