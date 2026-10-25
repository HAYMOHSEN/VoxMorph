// Tiny static server for tests: serves the repo and (optionally) maps vendor/ort/ to the mock runtime.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] || 8765);
const mockOrt = process.argv.includes('--mock-ort');
const hideArg = process.argv.find((a) => a.startsWith('--hide='));
const hide = hideArg ? new RegExp(hideArg.slice(7)) : null; // e.g. --hide=ort-wasm-simd-threaded\.wasm$ → 404 for matching paths (tests a build fallback)
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.onnx': 'application/octet-stream', '.wasm': 'application/wasm', '.md': 'text/markdown' };
http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (mockOrt && p.startsWith('/vendor/ort/')) p = '/test/mock-ort/' + p.slice('/vendor/ort/'.length);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || (hide && hide.test(p))) { res.writeHead(404); res.end('not found'); return; }
  const data = fs.readFileSync(file);
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-store' });
  res.end(data);
}).listen(port, () => console.log(`serving ${root} on ${port}${mockOrt ? ' (mock ORT)' : ''}`));
