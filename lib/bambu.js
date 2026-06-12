/**
 * Bambu Lab LAN-mode support (A1 mini / A1 / P1 / X1) — send a sliced job to
 * the printer over the local network. No cloud account needed; the printer
 * must have LAN mode enabled and you need its:
 *   - IP address
 *   - Serial number (printer screen: Settings → Device)
 *   - LAN access code (printer screen: Settings → WLAN)
 *
 * Protocol (same one Bambu Studio / OrcaSlicer use in LAN mode):
 *   1. Upload the file to the SD card over implicit FTPS (port 990,
 *      user "bblp", password = access code, self-signed cert).
 *   2. Publish a `project_file` print command over MQTT-TLS (port 8883,
 *      same credentials) to topic device/<serial>/request.
 *
 * Bambu printers print ".gcode.3mf" packages, not bare gcode — so we wrap the
 * sliced gcode in the minimal 3MF the firmware expects (gcode + md5 under
 * Metadata/, plus the container boilerplate).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');
const JSZip = require('jszip');
const ftp = require('basic-ftp');

// ── .gcode.3mf wrapper ───────────────────────────────────────
async function makeGcode3mf(gcodePath, plate = 1) {
  const gcode = fs.readFileSync(gcodePath);
  const md5 = crypto.createHash('md5').update(gcode).digest('hex').toUpperCase();
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>' +
      '<Default Extension="gcode" ContentType="text/x.gcode"/>' +
      '</Types>'
  );
  zip.folder('_rels').file(
    '.rels',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel-1" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>' +
      '</Relationships>'
  );
  // Stub model — the firmware only reads Metadata/plate_N.gcode for printing.
  zip.folder('3D').file(
    '3dmodel.model',
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">' +
      '<resources/><build/></model>'
  );
  const meta = zip.folder('Metadata');
  meta.file(`plate_${plate}.gcode`, gcode);
  meta.file(`plate_${plate}.gcode.md5`, md5);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 4 } });
}

// ── FTPS upload (implicit TLS :990) ──────────────────────────
async function uploadFile({ host, accessCode, filePath, fileName, onLog = () => {} }) {
  const client = new ftp.Client(30000);
  try {
    onLog(`Connecting to ${host}:990 (FTPS)…`);
    await client.access({
      host,
      port: 990,
      user: 'bblp',
      password: accessCode,
      secure: 'implicit',
      secureOptions: { rejectUnauthorized: false }, // printer uses a self-signed cert
    });
    const size = fs.statSync(filePath).size;
    onLog(`Uploading ${fileName} (${(size / 1024 / 1024).toFixed(2)} MB) to the SD card…`);
    await client.uploadFrom(filePath, fileName);
    onLog('Upload complete.');
  } finally {
    client.close();
  }
}

// ── MQTT print start ─────────────────────────────────────────
function startPrint({ host, serial, accessCode, fileName, plate = 1, onLog = () => {}, timeoutMs = 20000 }) {
  return new Promise((resolve, reject) => {
    const client = mqtt.connect(`mqtts://${host}:8883`, {
      username: 'bblp',
      password: accessCode,
      rejectUnauthorized: false,
      reconnectPeriod: 0,
      connectTimeout: 10000,
    });
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { client.end(true); } catch { /* ignore */ }
      fn(v);
    };
    const timer = setTimeout(
      () => finish(reject, new Error('Printer did not acknowledge the print command (check serial + access code).')),
      timeoutMs
    );

    client.on('error', (e) => finish(reject, new Error(`MQTT: ${e.message} (is LAN mode on and the access code right?)`)));
    client.on('connect', () => {
      onLog(`Connected to ${host}:8883 — starting print…`);
      client.subscribe(`device/${serial}/report`);
      const cmd = {
        print: {
          sequence_id: '0',
          command: 'project_file',
          param: `Metadata/plate_${plate}.gcode`,
          url: `file:///sdcard/${fileName}`,
          subtask_name: fileName.replace(/\.gcode\.3mf$/i, ''),
          project_id: '0',
          profile_id: '0',
          task_id: '0',
          subtask_id: '0',
          use_ams: false,
          timelapse: false,
          bed_type: 'auto',
          // Both spellings seen across firmwares — extras are ignored.
          bed_leveling: true,
          bed_levelling: true,
          flow_cali: false,
          vibration_cali: true,
          layer_inspect: false,
        },
      };
      client.publish(`device/${serial}/request`, JSON.stringify(cmd));
    });
    client.on('message', (_topic, payload) => {
      let msg;
      try { msg = JSON.parse(payload.toString()); } catch { return; }
      const p = msg.print || {};
      if (p.command === 'project_file') {
        if (p.result === 'success' || p.result === 'SUCCESS') {
          onLog('Printer accepted the job.');
          finish(resolve, { ok: true });
        } else if (p.result) {
          finish(reject, new Error(`Printer rejected the job: ${p.result} ${p.reason || ''}`));
        }
      } else if (p.gcode_state === 'RUNNING' || p.gcode_state === 'PREPARE') {
        // Some firmwares don't ack project_file directly — a state flip to
        // PREPARE/RUNNING right after the command also means it started.
        onLog(`Print state: ${p.gcode_state}.`);
        finish(resolve, { ok: true, state: p.gcode_state });
      }
    });
  });
}

/** True if TCP :8883 answers (cheap online check for the printer list). */
function online(host, timeout = 1200) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.connect({ host, port: 8883, timeout });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
}

module.exports = { makeGcode3mf, uploadFile, startPrint, online };
