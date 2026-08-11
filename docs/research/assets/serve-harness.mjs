import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));

createServer(async (req, res) => {
  const name = req.url === '/' ? '/font-harness.html' : req.url.split('?')[0];
  try {
    const buf = await readFile(join(root, name));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(8791, '127.0.0.1', () => console.log('harness on http://127.0.0.1:8791'));
