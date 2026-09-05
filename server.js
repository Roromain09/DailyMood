const http = require('http');
const fs = require('fs');
const path = require('path');
const https = require('https');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const INDEX_FILE = path.join(ROOT, 'index.html');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('⚠  SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
}

// ── SUPABASE HELPERS ──
function supabaseRequest(method, endpoint, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${SUPABASE_URL}/rest/v1/${endpoint}`);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
        ...extraHeaders,
      },
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data || 'null') }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function verifyToken(token) {
  return new Promise((resolve) => {
    const url = new URL(`${SUPABASE_URL}/auth/v1/user`);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'GET',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${token}`,
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed && parsed.id ? parsed.id : null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// ── HTTP HELPERS ──
function send(res, statusCode, body, contentType = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath)) return send(res, 404, '"Not found"');
  const ext = path.extname(filePath).toLowerCase();
  const ct = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
  }[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-store' });
  fs.createReadStream(filePath).pipe(res);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > 2 * 1024 * 1024) { reject(new Error('Too large')); req.destroy(); }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function extractToken(req) {
  const auth = req.headers['authorization'] || '';
  return auth.startsWith('Bearer ') ? auth.slice(7) : null;
}

// ── ROUTES ──
async function handleGetEntries(req, res) {
  const token = extractToken(req);
  if (!token) return send(res, 401, { error: 'Missing token' });
  const userId = await verifyToken(token);
  if (!userId) return send(res, 401, { error: 'Invalid token' });

  const result = await supabaseRequest(
    'GET',
    `mood_entries?user_id=eq.${userId}&order=date.desc&select=date,good,why,starred,ts`,
  );
  if (result.status !== 200) return send(res, 502, { error: 'Database error' });
  return send(res, 200, Array.isArray(result.body) ? result.body : []);
}

async function handlePostEntry(req, res) {
  const token = extractToken(req);
  if (!token) return send(res, 401, { error: 'Missing token' });
  const userId = await verifyToken(token);
  if (!userId) return send(res, 401, { error: 'Invalid token' });

  let body;
  try { body = JSON.parse(await parseBody(req)); }
  catch { return send(res, 400, { error: 'Invalid JSON' }); }

  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) {
    return send(res, 400, { error: 'Invalid date' });
  }

  const record = {
    user_id: userId,
    date: body.date,
    good: body.good,
    why: body.why || '',
    starred: !!body.starred,
    ts: body.ts || Date.now(),
  };

  const result = await supabaseRequest(
    'POST',
    'mood_entries',
    record,
    { 'Prefer': 'resolution=merge-duplicates,return=representation' },
  );

  if (result.status >= 400) return send(res, 502, { error: 'Database error', detail: result.body });
  return send(res, 200, { ok: true });
}

// ── SERVER ──
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' });
      return res.end();
    }

    if (url.pathname === '/api/entries') {
      if (req.method === 'GET') return await handleGetEntries(req, res);
      if (req.method === 'POST') return await handlePostEntry(req, res);
    }

    if (url.pathname === '/health') return send(res, 200, { ok: true });

    if (req.method === 'GET') {
      if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, INDEX_FILE);
      const candidate = path.join(ROOT, decodeURIComponent(url.pathname));
      if (candidate.startsWith(ROOT) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return serveStatic(res, candidate);
      }
    }

    return send(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(err);
    return send(res, 500, { error: 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Daily Mood running at http://localhost:${PORT}`);
});
