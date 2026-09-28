import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../public/', import.meta.url));
const port = Number(process.argv[2] || 8788);
if (!Number.isInteger(port) || port < 1 || port > 65535 || [8000,8080].includes(port)) throw Error('Invalid deployment port');
http.createServer(async (req,res) => {
  res.setHeader('Cross-Origin-Opener-Policy','same-origin');
  res.setHeader('Cross-Origin-Embedder-Policy','require-corp');
  res.setHeader('Cross-Origin-Resource-Policy','same-origin');
  res.setHeader('Cache-Control','no-store');
  try {
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const path=resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if (!path.startsWith(resolve(root)+sep)) {res.writeHead(403);res.end();return;}
    const data=await readFile(path);
    res.setHeader('Content-Type',({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.wasm':'application/wasm','.css':'text/css; charset=utf-8'})[extname(path)]||'application/octet-stream');
    res.writeHead(200);res.end(data);
  } catch {res.writeHead(404);res.end('Not found');}
}).listen(port,'0.0.0.0',()=>console.log(`melonDS server :${port}`));
