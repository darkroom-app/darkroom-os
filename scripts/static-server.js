const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = 8791;

// Real content-types per extension — needed once this server started
// serving more than darkroom-app.html: navigator.serviceWorker.register()
// flat-out refuses a script served as text/html, and manifest/icon fetches
// used to be silently mis-typed the same way (GitHub Pages, the real
// deployment target, already gets this right automatically).
const MIME_TYPES = {
  '.html': 'text/html',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/darkroom-app.html';
  const file = path.join(root, decodeURIComponent(p));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const contentType = MIME_TYPES[path.extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
