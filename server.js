const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const busboy = require('busboy');

const PORT = parseInt(process.env.PORT) || 3579;
// Store API key as environment variable - teachers never see it
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

console.log('=== Hiyaa Lesson Planner ===');
console.log('Port:', PORT);
console.log('API Key configured:', ANTHROPIC_KEY ? 'YES' : 'NO (set ANTHROPIC_API_KEY env var)');

// ── MIME types ────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json',
  '.txt':  'text/plain'
};

// ── Read body helper ──────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ── Parse multipart upload ────────────────────────────────────────
function parseUpload(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({ headers: req.headers, limits: { fileSize: 10 * 1024 * 1024 } });
    const fields = {};
    let fileBuffer = null;
    let fileName = '';
    let fileMime = '';

    bb.on('field', (name, val) => { fields[name] = val; });
    bb.on('file', (name, file, info) => {
      fileName = info.filename;
      fileMime = info.mimeType;
      const chunks = [];
      file.on('data', c => chunks.push(c));
      file.on('end', () => { fileBuffer = Buffer.concat(chunks); });
    });
    bb.on('close', () => resolve({ fields, fileBuffer, fileName, fileMime }));
    bb.on('error', reject);
    req.pipe(bb);
  });
}

// ── Extract text from docx ────────────────────────────────────────
async function extractDocx(buffer) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
}

// ── Extract text from PDF ─────────────────────────────────────────
async function extractPdf(buffer) {
  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer);
  return result.text;
}

// ── Proxy to Anthropic API ────────────────────────────────────────
function callAnthropic(body, apiKey) {
  return new Promise((resolve, reject) => {
    const key = apiKey || ANTHROPIC_KEY;
    if (!key) return reject(new Error('No API key configured. Set ANTHROPIC_API_KEY on the server.'));

    const payload = JSON.stringify(body);
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const chunks = [];
    const req = https.request(options, res => {
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch(e) { reject(new Error('Invalid JSON from Anthropic')); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── Serve static files ────────────────────────────────────────────
function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ── JSON response helper ──────────────────────────────────────────
function jsonRes(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ── Main router ───────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, anthropic-version');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {

    // ── POST /api/messages — AI proxy ───────────────────────────
    if (req.method === 'POST' && req.url === '/api/messages') {
      const body = await readBody(req);
      const parsed = JSON.parse(body.toString());
      // Use server key if available, else fall back to client-provided key
      const apiKey = ANTHROPIC_KEY || req.headers['x-api-key'] || '';
      const result = await callAnthropic(parsed, apiKey);
      return jsonRes(res, result.error ? 400 : 200, result);
    }

    // ── POST /api/parse-template — upload + extract text ────────
    if (req.method === 'POST' && req.url === '/api/parse-template') {
      const { fileBuffer, fileName, fileMime } = await parseUpload(req);
      if (!fileBuffer) return jsonRes(res, 400, { error: 'No file uploaded' });

      let text = '';
      const ext = path.extname(fileName).toLowerCase();

      if (ext === '.docx' || fileMime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
        text = await extractDocx(fileBuffer);
      } else if (ext === '.pdf' || fileMime === 'application/pdf') {
        text = await extractPdf(fileBuffer);
      } else {
        return jsonRes(res, 400, { error: 'Unsupported file type. Please upload .docx or .pdf' });
      }

      if (!text || text.trim().length < 20) {
        return jsonRes(res, 400, { error: 'Could not extract text from file. Make sure the file is not scanned/image-only.' });
      }

      // Use Claude to analyse the template structure
      const analysisPrompt = `Analyse this lesson plan template and extract its structure.
Return ONLY valid JSON with these fields:
{
  "sections": ["section name 1", "section name 2", ...],
  "fields": {"section name": ["field1", "field2"]},
  "format": "brief description of the template style",
  "preview": "first 300 chars of template content"
}

Template text:
${text.slice(0, 3000)}`;

      const apiKey = ANTHROPIC_KEY || req.headers['x-api-key'] || '';
      let structure = { sections: [], fields: {}, format: 'Custom template', preview: text.slice(0, 300) };

      if (apiKey) {
        try {
          const aiRes = await callAnthropic({
            model: 'claude-sonnet-4-5',
            max_tokens: 1000,
            messages: [{ role: 'user', content: analysisPrompt }]
          }, apiKey);
          const raw = aiRes.content[0].text.replace(/```json|```/g, '').trim();
          structure = JSON.parse(raw);
        } catch(e) {
          console.error('Template analysis error:', e.message);
        }
      }

      return jsonRes(res, 200, {
        success: true,
        fileName,
        textLength: text.length,
        templateText: text.slice(0, 5000), // store first 5000 chars
        structure
      });
    }

    // ── GET /api/has-key — check if server key is configured ────
    if (req.method === 'GET' && req.url === '/api/has-key') {
      return jsonRes(res, 200, { hasKey: !!ANTHROPIC_KEY });
    }

    // ── Static files ─────────────────────────────────────────────
    serveStatic(req, res);

  } catch(e) {
    console.error('Request error:', e.message);
    jsonRes(res, 500, { error: { message: e.message } });
  }
});

server.on('error', e => { console.error('FATAL:', e.message); process.exit(1); });
server.listen(PORT, '0.0.0.0', () => {
  console.log('Hiyaa Lesson Planner ready at http://0.0.0.0:' + PORT);
});
