/**
 * Tiny JSON store for app-level state that doesn't live in the slicer's own
 * config: user-added printers (incl. Bambu, which ElegooSlicer doesn't know
 * about), hidden auto-detected printers, and saved settings profiles.
 *
 * Persisted as one file in the writable data dir:
 *   { printers: [...], hiddenHosts: [...], profiles: { name: {…settings} } }
 */
const fs = require('fs');
const path = require('path');

function load(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { printers: [], hiddenHosts: [], profiles: {} };
  }
}

function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function createStore(file) {
  const data = load(file);
  data.printers = Array.isArray(data.printers) ? data.printers : [];
  data.hiddenHosts = Array.isArray(data.hiddenHosts) ? data.hiddenHosts : [];
  data.profiles = data.profiles && typeof data.profiles === 'object' ? data.profiles : {};

  return {
    // ── Printers ─────────────────────────────────────────────
    customPrinters: () => data.printers.map((p) => ({ ...p, custom: true })),
    addPrinter(p) {
      // One entry per host — re-adding a host updates it.
      data.printers = data.printers.filter((x) => x.host !== p.host);
      data.printers.push(p);
      data.hiddenHosts = data.hiddenHosts.filter((h) => h !== p.host); // un-hide
      save(file, data);
    },
    removePrinter(host) {
      const before = data.printers.length;
      data.printers = data.printers.filter((x) => x.host !== host);
      const wasCustom = data.printers.length < before;
      if (!wasCustom && !data.hiddenHosts.includes(host)) data.hiddenHosts.push(host); // hide a detected one
      save(file, data);
      return wasCustom ? 'deleted' : 'hidden';
    },
    isHidden: (host) => data.hiddenHosts.includes(host),

    // ── Settings profiles ────────────────────────────────────
    profiles: () => Object.keys(data.profiles).sort(),
    getProfile: (name) => data.profiles[name] || null,
    saveProfile(name, settings) {
      data.profiles[name] = settings;
      save(file, data);
    },
    deleteProfile(name) {
      delete data.profiles[name];
      save(file, data);
    },
  };
}

module.exports = { createStore };
