const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const port = 8791;

http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/darkroom-app.html';
  const file = path.join(root, decodeURIComponent(p));
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log('listening on ' + port));
