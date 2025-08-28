'use strict';

const net = require('net');
const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ---- Config ----
const TCP_PORT = Number(process.env.PORT || 5093);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8080);
const DATA_FILE = process.env.DATA_FILE || path.join(process.cwd(), 'positions.log');

const FORWARD_URL = process.env.FORWARD_URL || 'https://backend.sps-global.com.mx/api/osmand';
const FORWARD_ENABLED = /^true|1|yes|on$/i.test(String(process.env.FORWARD_ENABLED ?? 'true'));
const FORWARD_TIMEOUT_MS = Number(process.env.FORWARD_TIMEOUT_MS || 8000);
const FORWARD_ONLY_VALID = /^true|1|yes|on$/i.test(String(process.env.FORWARD_ONLY_VALID ?? 'true'));
const FORWARD_ALLOW_ZERO_COORDS = /^true|1|yes|on$/i.test(String(process.env.FORWARD_ALLOW_ZERO_COORDS ?? 'false'));

// Ensure output folder exists
fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });

// ---- In-memory last positions ----
const lastPositions = Object.create(null);

// ---- Helpers ----
function extractFrames(buf) {
  const frames = [];
  let start = buf.indexOf('[');
  while (start !== -1) {
    const end = buf.indexOf(']', start + 1);
    if (end === -1) break;
    frames.push(buf.slice(start, end + 1));
    start = buf.indexOf('[', end + 1);
  }
  const remainderIdx = buf.lastIndexOf(']');
  return { frames, remainder: remainderIdx === -1 ? buf : buf.slice(remainderIdx + 1) };
}

function signedCoord(v, hemi) {
  const n = Number(v);
  if (Number.isNaN(n)) return null;
  return (hemi === 'S' || hemi === 'W') ? -Math.abs(n) : Math.abs(n);
}

function toIso(dmy, hms) {
  if (!/^\d{6}$/.test(dmy) || !/^\d{6}$/.test(hms)) return null;
  const d = Number(dmy.slice(0, 2));
  const m = Number(dmy.slice(2, 4)) - 1;
  const y = Number(dmy.slice(4, 6)) + 2000;
  const H = Number(hms.slice(0, 2));
  const M = Number(hms.slice(2, 4));
  const S = Number(hms.slice(4, 6));
  const dt = new Date(Date.UTC(y, m, d, H, M, S));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

function parseFrame(frame) {
  const body = frame.slice(1, -1);
  const parts = body.split('*');
  if (parts.length < 4) return null;

  const vendor = parts[0];
  const deviceId = parts[1];
  const payload = parts.slice(3).join('*');

  const [cmd, ...csv] = payload.split(',');
  if (csv.length < 9) return { deviceId, vendor, cmd, raw: payload }; // non-GPS event

  // ddmmyy,hhmmss,valid(A/V),lat,NS,lon,EW,speedKph,course,...
  const time = toIso(csv[0], csv[1]);
  const valid = csv[2] === 'A';
  const lat = signedCoord(csv[3], csv[4]);
  const lon = signedCoord(csv[5], csv[6]);
  const speedKph = Number(csv[7]);
  const course = Number(csv[8]);

  return {
    deviceId, vendor, cmd, time, valid, lat, lon,
    speedKph: Number.isFinite(speedKph) ? speedKph : null,
    course: Number.isFinite(course) ? course : null,
    raw: payload,
    receivedAt: new Date().toISOString(),
  };
}

function kphToKnots(kph) {
  return kph * 0.539956803;
}

async function forwardPosition(pos) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FORWARD_TIMEOUT_MS);
  try {
    const params = new URLSearchParams();
    params.set('id', String(pos.deviceId));
    params.set('lat', String(pos.lat));
    params.set('lon', String(pos.lon));
    if (pos.time) params.set('timestamp', pos.time); // ISO 8601
    if (typeof pos.valid === 'boolean') params.set('valid', pos.valid ? 'true' : 'false');
    if (pos.speedKph != null) params.set('speed', kphToKnots(pos.speedKph).toFixed(2)); // knots
    if (pos.course != null) params.set('bearing', String(pos.course));

    const url = `${FORWARD_URL}?${params.toString()}`;
    const r = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'tk905-forwarder/1.0' }, signal: controller.signal });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      console.error('[FWD] HTTP', r.status, body.slice(0, 200));
    } else {
      console.log('[FWD] OK', url);
    }
  } catch (e) {
    console.error('[FWD] Error:', e.message);
  } finally {
    clearTimeout(t);
  }
}

function hasUsableCoords(pos) {
  const ok =
    Number.isFinite(pos.lat) &&
    Number.isFinite(pos.lon) &&
    Math.abs(pos.lat) <= 90 &&
    Math.abs(pos.lon) <= 180;
  if (!ok) return false;
  if (!FORWARD_ALLOW_ZERO_COORDS && pos.lat === 0 && pos.lon === 0) return false;
  return true;
}

// ---- TCP server ----
const server = net.createServer((socket) => {
  console.log('[TCP] Connection from', socket.remoteAddress, socket.remotePort);
  socket.setEncoding('utf8');

  let buffer = '';

  socket.on('data', (chunk) => {
    buffer += chunk;
    const { frames, remainder } = extractFrames(buffer);
    buffer = remainder;

    for (const frame of frames) {
      const pos = parseFrame(frame);
      if (!pos) continue;

      // Always save to memory and file if it has coords (even if invalid)
      if (hasUsableCoords(pos)) {
        lastPositions[pos.deviceId] = pos;

        // Append JSONL
        fs.appendFile(DATA_FILE, JSON.stringify(pos) + '\n', (err) => {
          if (err) console.error('File write error:', err);
        });

        // Forwarding policy
        const policyAllows = !FORWARD_ONLY_VALID || pos.valid === true;
        if (FORWARD_ENABLED && policyAllows) {
          forwardPosition(pos); // fire-and-forget
          console.log('[POS→FWD]', pos.deviceId, pos.lat, pos.lon, pos.valid ? 'valid' : 'invalid');
        } else {
          console.log('[POS→SKIP]', pos.deviceId, pos.lat, pos.lon, `valid=${pos.valid}`);
        }
      } else {
        // keep last non-GPS or unusable event for context
        lastPositions[pos.deviceId] = { ...(lastPositions[pos.deviceId] || {}), lastEvent: pos };
        console.log('[EVT]', pos.deviceId, pos.cmd, '(no usable coords)');
      }
    }
  });

  socket.on('error', (e) => console.error('[TCP] Error:', e.message));
  socket.on('close', () => console.log('[TCP] Closed', socket.remoteAddress, socket.remotePort));
});

server.listen(TCP_PORT, () => {
  console.log(`[TCP] Listening on 0.0.0.0:${TCP_PORT}`);
  console.log(`[LOG] Appending JSON lines to: ${DATA_FILE}`);
  console.log(`[FWD] Forwarding: ${FORWARD_ENABLED ? 'ENABLED' : 'DISABLED'} → ${FORWARD_URL}`);
  console.log(`[FWD] Policy: ONLY_VALID=${FORWARD_ONLY_VALID}, ALLOW_ZERO_COORDS=${FORWARD_ALLOW_ZERO_COORDS}`);
});

// ---- REST API ----
const app = express();
app.get('/', (_req, res) => res.json({ ok: true, devices: Object.keys(lastPositions).length }));
app.get('/devices', (_req, res) => res.json(lastPositions));
app.get('/devices/:id', (req, res) => {
  const d = lastPositions[req.params.id];
  if (!d) return res.status(404).json({ error: 'unknown device' });
  res.json(d);
});
app.listen(HTTP_PORT, () => console.log(`[HTTP] API on http://localhost:${HTTP_PORT}`));
