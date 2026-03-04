#!/usr/bin/env node
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// === CONFIG (env vars or defaults) ===
const PORT = parseInt(process.env.PORT || '8899', 10);
const BIND = process.env.BIND || '127.0.0.1';
const STORE_ID = process.env.STORE_ID || '';
const QUERY_SCRIPT = process.env.QUERY_SCRIPT || path.join(__dirname, 'query.py');
const METRICS_FILE = process.env.METRICS_FILE || path.join(__dirname, 'metrics.jsonl');
const PYTHON = process.env.PYTHON || 'python3';
const MAX_BODY = 16 * 1024; // 16KB

// === RATE LIMITER (token bucket) ===
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT || '10', 10); // requests per minute
const rateBucket = { tokens: RATE_LIMIT, last: Date.now() };

function checkRate() {
  const now = Date.now();
  const elapsed = (now - rateBucket.last) / 60000; // minutes
  rateBucket.tokens = Math.min(RATE_LIMIT, rateBucket.tokens + elapsed * RATE_LIMIT);
  rateBucket.last = now;
  if (rateBucket.tokens < 1) return false;
  rateBucket.tokens -= 1;
  return true;
}

// === INPUT VALIDATION ===
const SAFE_QUERY = /^[\p{L}\p{N}\p{P}\p{Z}]{1,500}$/u;
const SAFE_DOMAIN = /^[a-z]{1,20}$/;
const SAFE_MODEL = /^[a-z0-9._-]{1,60}$/;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// === CACHED HTML ===
let cachedHtml = null;
function getHtml() {
  if (!cachedHtml) {
    cachedHtml = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  }
  return cachedHtml;
}
// Reload on file change (dev mode)
if (process.env.NODE_ENV !== 'production') {
  fs.watchFile(path.join(__dirname, 'index.html'), () => { cachedHtml = null; });
}

// === HELPERS ===
function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}

function readBody(req, cb) {
  let body = '';
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    body += c;
  });
  req.on('end', () => cb(body));
}

// === SERVER ===
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // CORS (restrict in production)
  const origin = process.env.CORS_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // --- Serve HTML ---
  if ((pathname === '/' || pathname === '/index.html') && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getHtml());
    return;
  }

  // --- Query API ---
  if (pathname === '/api/query' && req.method === 'POST') {
    if (!checkRate()) return json(res, 429, { error: 'Rate limit exceeded. Try again in a minute.' });

    readBody(req, (body) => {
      try {
        const { query, domain, model } = JSON.parse(body);

        // Validate
        if (!query || !SAFE_QUERY.test(query)) return json(res, 400, { error: 'Invalid query (1-500 chars, no shell metacharacters)' });
        if (domain && !SAFE_DOMAIN.test(domain)) return json(res, 400, { error: 'Invalid domain' });
        if (model && !SAFE_MODEL.test(model)) return json(res, 400, { error: 'Invalid model' });

        // Build args (execFile — no shell injection possible)
        const args = [QUERY_SCRIPT, query];
        if (domain) args.push('--domain', domain);
        if (model) args.push('--model', model);

        const t0 = Date.now();
        execFile(PYTHON, args, {
          timeout: 60000,
          maxBuffer: 512 * 1024,
          env: { ...process.env, PYTHONUNBUFFERED: '1' }
        }, (err, stdout, stderr) => {
          const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
          json(res, 200, {
            ok: !err,
            output: stdout ? stdout.trim() : null,
            error: err ? (stderr || err.message) : null,
            elapsed_s: parseFloat(elapsed),
            domain: domain || null,
            model: model || 'gemini-3-flash-preview'
          });
        });
      } catch (e) {
        json(res, 400, { error: 'Invalid JSON body' });
      }
    });
    return;
  }

  // --- Metrics API ---
  if (pathname === '/api/metrics' && req.method === 'GET') {
    try {
      const raw = fs.readFileSync(METRICS_FILE, 'utf8').trim();
      if (!raw) return json(res, 200, { total: 0, success: 0, avgLatency: '0', domainCount: 0, domains: {}, byDay: {}, recent: [] });

      const metrics = raw.split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const total = metrics.length;
      const success = metrics.filter(m => m.success).length;
      const avgLatency = total ? (metrics.reduce((s, m) => s + (m.elapsed_s || 0), 0) / total).toFixed(1) : '0';

      const domains = {};
      metrics.forEach(m => { const d = m.domain || 'none'; domains[d] = (domains[d] || 0) + 1; });

      const byDay = {};
      metrics.forEach(m => { const d = m.ts?.slice(0, 10); if (d) byDay[d] = (byDay[d] || 0) + 1; });

      const recent = metrics.slice(-20).reverse().map(m => ({
        time: m.ts?.slice(5, 16).replace('T', ' '),
        query: escapeHtml((m.query || '').slice(0, 200)),
        domain: m.domain || '—',
        latency: (m.elapsed_s || 0).toFixed(1) + 's',
        ok: !!m.success
      }));

      json(res, 200, { total, success, avgLatency, domainCount: Object.keys(domains).length, domains, byDay, recent });
    } catch (e) {
      json(res, 200, { total: 0, success: 0, avgLatency: '0', domainCount: 0, domains: {}, byDay: {}, recent: [] });
    }
    return;
  }

  // --- Store Info API ---
  if (pathname === '/api/store' && req.method === 'GET') {
    if (!STORE_ID) return json(res, 200, {});

    execFile(PYTHON, ['-c', `
import os, json
from google import genai
client = genai.Client(api_key=os.environ.get('GOOGLE_API_KEY',''))
r = client.files._api_client.request('get', '${STORE_ID}', {})
print(r.body)
`], { timeout: 15000, env: process.env }, (err, stdout) => {
      if (err) return json(res, 200, {});
      try { json(res, 200, JSON.parse(stdout.trim())); } catch { json(res, 200, {}); }
    });
    return;
  }

  // --- Health ---
  if (pathname === '/api/health') {
    json(res, 200, { ok: true, uptime: process.uptime() | 0 });
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, BIND, () => {
  console.log(`Gemini File Search Dashboard running at http://${BIND}:${PORT}`);
  if (!STORE_ID) console.warn('⚠ STORE_ID not set — /api/store will return empty');
  if (!process.env.GOOGLE_API_KEY) console.warn('⚠ GOOGLE_API_KEY not set — queries will fail');
});
