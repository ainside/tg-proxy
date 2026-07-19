'use strict';

// Minimalist forward-proxy for api.telegram.org.
// Zero npm dependencies — only Node core modules (http, net, crypto, fs, path).
//
// Behaviour:
//   * Handles ONLY the HTTP CONNECT method. Normal GET/POST/etc. -> 405.
//   * Requires Basic auth via the Proxy-Authorization header (PROXY_USER / PROXY_PASS).
//   * Whitelists exactly one CONNECT target: api.telegram.org:443. Anything else -> 403,
//     so the proxy can never become an open relay.
//   * On success, opens a TCP tunnel to Telegram and pipes bytes both ways.

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// --- Tiny .env loader (no dotenv dependency) --------------------------------
// Reads a .env file sitting next to this script and sets any KEY that is not
// already present in the environment. Missing file is fine (env may come from
// the shell or a process manager like pm2).
function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    const raw = fs.readFileSync(envPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      // Strip a single layer of surrounding quotes, if present.
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('Failed to read .env:', err.message);
    }
  }
}

loadEnv();

// --- Config -----------------------------------------------------------------
const PROXY_USER = process.env.PROXY_USER;
const PROXY_PASS = process.env.PROXY_PASS;
const PROXY_PORT = parseInt(process.env.PROXY_PORT, 10) || 8888;

const ALLOWED_HOST = 'api.telegram.org';
const ALLOWED_PORT = 443;
const ALLOWED_TARGET = `${ALLOWED_HOST}:${ALLOWED_PORT}`;

if (!PROXY_USER || !PROXY_PASS) {
  console.error('FATAL: PROXY_USER and PROXY_PASS must be set (via .env or environment).');
  process.exit(1);
}

// --- Logging ----------------------------------------------------------------
function log(ip, decision, reason) {
  const ts = new Date().toISOString();
  console.log(`${ts} ${ip || '-'} ${decision} ${reason}`);
}

// --- Auth helpers -----------------------------------------------------------
// Constant-time string comparison that never short-circuits on length.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison against a same-length buffer to keep timing stable.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Returns 'ok' | 'no-auth' | 'bad-auth'.
function checkAuth(req) {
  const header = req.headers['proxy-authorization'];
  if (!header) return 'no-auth';

  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match) return 'bad-auth';

  let decoded;
  try {
    decoded = Buffer.from(match[1], 'base64').toString('utf8');
  } catch {
    return 'bad-auth';
  }

  const sep = decoded.indexOf(':');
  if (sep === -1) return 'bad-auth';

  const user = decoded.slice(0, sep);
  const pass = decoded.slice(sep + 1);

  // Evaluate both to avoid leaking which field was wrong via timing.
  const userOk = safeEqual(user, PROXY_USER);
  const passOk = safeEqual(pass, PROXY_PASS);
  return userOk && passOk ? 'ok' : 'bad-auth';
}

// --- Server -----------------------------------------------------------------
const server = http.createServer();

// Any normal (non-CONNECT) request is rejected: this proxy only tunnels.
server.on('request', (req, res) => {
  const ip = req.socket.remoteAddress;
  log(ip, 'DENY', `method-not-allowed: ${req.method} ${req.url}`);
  res.writeHead(405, { 'Allow': 'CONNECT', 'Content-Type': 'text/plain' });
  res.end('405 Method Not Allowed: this proxy only supports CONNECT.\n');
});

server.on('connect', (req, clientSocket, head) => {
  const ip = clientSocket.remoteAddress;

  // Guard against errors on a client socket we may abort early.
  clientSocket.on('error', () => clientSocket.destroy());

  // 1) Authentication.
  const auth = checkAuth(req);
  if (auth !== 'ok') {
    log(ip, 'DENY', auth);
    clientSocket.write(
      'HTTP/1.1 407 Proxy Authentication Required\r\n' +
      'Proxy-Authenticate: Basic realm="tg-proxy"\r\n' +
      'Connection: close\r\n' +
      '\r\n'
    );
    clientSocket.destroy();
    return;
  }

  // 2) Host whitelist — the anti-open-relay guard.
  if (req.url !== ALLOWED_TARGET) {
    log(ip, 'DENY', `host-not-allowed: ${req.url}`);
    clientSocket.write(
      'HTTP/1.1 403 Forbidden\r\n' +
      'Connection: close\r\n' +
      '\r\n'
    );
    clientSocket.destroy();
    return;
  }

  // 3) Establish the upstream tunnel to Telegram.
  const upstream = net.connect(ALLOWED_PORT, ALLOWED_HOST, () => {
    log(ip, 'ALLOW', `tunnel-open: ${ALLOWED_TARGET}`);
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });

  upstream.on('error', (err) => {
    log(ip, 'DENY', `upstream-error: ${err.message}`);
    if (!clientSocket.destroyed) {
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    }
    clientSocket.destroy();
  });

  // Tear down each side when the other closes.
  upstream.on('close', () => clientSocket.destroy());
  clientSocket.on('close', () => upstream.destroy());
});

server.on('clientError', (err, socket) => {
  if (socket.writable) {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  }
});

server.listen(PROXY_PORT, '0.0.0.0', () => {
  console.log(
    `${new Date().toISOString()} - tg-proxy listening on 0.0.0.0:${PROXY_PORT}, ` +
    `allowed target: ${ALLOWED_TARGET}`
  );
});
