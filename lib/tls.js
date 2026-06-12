/**
 * Local HTTPS for phone PWA install.
 *
 * Android Chrome only treats a site as a "secure context" (and thus lets you
 * INSTALL it as a standalone PWA with no address bar) over trusted HTTPS. A
 * LAN http:// address — or a self-signed cert — isn't trusted, so the install
 * option never appears.
 *
 * Fix: generate our own little Certificate Authority once, and serve a leaf
 * cert signed by it whose SubjectAltNames cover this PC's LAN IPs. The user
 * installs the CA on their phone ONE time; from then on https://<lan-ip> is
 * trusted and the PWA installs cleanly. The CA is persisted and stable, so if
 * the PC's IP changes we just re-issue the leaf (no phone re-install needed).
 */
const fs = require('fs');
const path = require('path');
const forge = require('node-forge');

const CA_SUBJECT = [
  { name: 'commonName', value: 'Elegoo Slice Local CA' },
  { name: 'organizationName', value: 'Elegoo Slice' },
];

function newKeyPair() {
  return forge.pki.rsa.generateKeyPair(2048);
}

function makeCA() {
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);
  cert.setSubject(CA_SUBJECT);
  cert.setIssuer(CA_SUBJECT);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, digitalSignature: true },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { keyPem: forge.pki.privateKeyToPem(keys.privateKey), certPem: forge.pki.certificateToPem(cert) };
}

function makeLeaf(caKeyPem, caCertPem, ips, names) {
  const caKey = forge.pki.privateKeyFromPem(caKeyPem);
  const caCert = forge.pki.certificateFromPem(caCertPem);
  const keys = newKeyPair();
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = String(Date.now());
  cert.validity.notBefore = new Date(Date.now() - 24 * 3600 * 1000);
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 5);
  cert.setSubject([{ name: 'commonName', value: names[0] || ips[0] || 'localhost' }]);
  cert.setIssuer(caCert.subject.attributes);
  const altNames = [
    ...names.map((n) => ({ type: 2, value: n })), // DNS
    ...ips.map((ip) => ({ type: 7, ip })), // IP
  ];
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return { keyPem: forge.pki.privateKeyToPem(keys.privateKey), certPem: forge.pki.certificateToPem(cert) };
}

/**
 * Ensure a CA + a leaf cert covering `ips`/`names` exist under `dir`. Reuses the
 * CA across runs; regenerates the leaf only when the IP/name set changed.
 * Returns { key, cert, caPem, regenerated }.
 */
function ensureTls(dir, ips, names = ['localhost']) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  // CA (persistent).
  let caKeyPem, caCertPem;
  if (fs.existsSync(f('ca.key')) && fs.existsSync(f('ca.crt'))) {
    caKeyPem = fs.readFileSync(f('ca.key'), 'utf8');
    caCertPem = fs.readFileSync(f('ca.crt'), 'utf8');
  } else {
    const ca = makeCA();
    caKeyPem = ca.keyPem;
    caCertPem = ca.certPem;
    fs.writeFileSync(f('ca.key'), caKeyPem);
    fs.writeFileSync(f('ca.crt'), caCertPem);
  }
  // Leaf — re-issue if the SAN list changed (e.g. DHCP gave a new IP).
  const sanKey = JSON.stringify({ ips: [...ips].sort(), names: [...names].sort() });
  let regenerated = false;
  let leafKeyPem, leafCertPem;
  const haveLeaf = fs.existsSync(f('server.key')) && fs.existsSync(f('server.crt')) && fs.existsSync(f('server.san'));
  if (haveLeaf && fs.readFileSync(f('server.san'), 'utf8') === sanKey) {
    leafKeyPem = fs.readFileSync(f('server.key'), 'utf8');
    leafCertPem = fs.readFileSync(f('server.crt'), 'utf8');
  } else {
    const leaf = makeLeaf(caKeyPem, caCertPem, ips, names);
    leafKeyPem = leaf.keyPem;
    leafCertPem = leaf.certPem;
    fs.writeFileSync(f('server.key'), leafKeyPem);
    fs.writeFileSync(f('server.crt'), leafCertPem);
    fs.writeFileSync(f('server.san'), sanKey);
    regenerated = true;
  }
  return { key: leafKeyPem, cert: leafCertPem, caPem: caCertPem, regenerated };
}

module.exports = { ensureTls };
