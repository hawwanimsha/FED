const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// Railway injects PORT - we MUST use it
const PORT = parseInt(process.env.PORT) || 3579;

console.log('=== Seenu Atoll School Lesson Planner ===');
console.log('NODE_ENV:', process.env.NODE_ENV || 'not set');
console.log('PORT env var:', process.env.PORT || 'not set, using 3579');
console.log('Listening on port:', PORT);

function proxyAnthropic(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': req.headers['x-api-key'] || '',
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const proxy = https.request(options, apiRes => {
      res.writeHead(apiRes.statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      apiRes.pipe(res);
    });
    proxy.on('error', e => {
      console.error('Proxy error:', e.message);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: e.message } }));
    });
    proxy.write(body);
    proxy.end();
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.json': 'application/json',
  '.txt':  'text/plain'
};

function serveStatic(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const filePath = path.join(__dirname, urlPath);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      res.writeHead(404); res.end('Not found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key, anthropic-version',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
    });
    res.end();
    return;
  }
  if (req.method === 'POST' && req.url === '/api/messages') {
    proxyAnthropic(req, res);
    return;
  }
  serveStatic(req, res);
});

server.on('error', e => {
  console.error('FATAL server error:', e.code, e.message);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('Server ready at http://0.0.0.0:' + PORT);
});
