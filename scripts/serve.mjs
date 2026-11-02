// Serves dist/ on http://localhost:8080 for trying the app. Plain Node, no packages.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const dir = new URL('../dist/', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };
const port = Number(process.env.PORT || 8080);
createServer(async (req, res) => {
  let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  if (p.endsWith('/')) p += 'index.html';
  try { const body = await readFile(join(dir, p)); res.writeHead(200, { 'Content-Type': types[extname(p)] || 'application/octet-stream' }); res.end(body); }
  catch { res.writeHead(404); res.end('Not found'); }
}).listen(port, () => console.log(`Serving dist/ at http://localhost:${port}`));
