import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.glb': 'model/gltf-binary',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.map': 'application/json; charset=utf-8',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
};

/**
 * Creates a simple static file handler serving files under `rootDir`.
 * `/` (and any path resolving outside rootDir) is guarded; `/` maps to
 * `index.html`. Unknown extensions fall back to application/octet-stream.
 */
export function createStaticHandler(rootDir: string) {
  const root = resolve(rootDir);
  // Resolve the root's real path once so symlink-escape checks below compare
  // against the true on-disk location (handles cases where rootDir itself
  // contains a symlinked path component).
  const realRoot = realpathSync(root);

  return (req: IncomingMessage, res: ServerResponse): void => {
    const rawUrlPath = (req.url ?? '/').split('?')[0];
    let urlPath: string;
    try {
      urlPath = decodeURIComponent(rawUrlPath);
    } catch {
      // decodeURIComponent throws URIError on malformed percent-encoding
      // (e.g. `GET /%`). Fail fast with 400 rather than crashing the process.
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return;
    }
    const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = resolve(join(root, relPath));

    if (filePath !== root && !filePath.startsWith(root + '/')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }

    // Re-verify after resolving symlinks: the lexical check above can be
    // bypassed by a symlink inside rootDir that points outside of it.
    let realFilePath: string;
    try {
      realFilePath = realpathSync(filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
      return;
    }
    if (realFilePath !== realRoot && !realFilePath.startsWith(realRoot + '/')) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const headers: Record<string, string> = { 'Content-Type': type };
    if (urlPath.startsWith('/assets/')) {
      headers['Cache-Control'] = 'public, max-age=31536000, immutable';
    } else if (urlPath === '/' || urlPath === '/index.html') {
      headers['Cache-Control'] = 'no-cache';
    } else if (urlPath.startsWith('/models/') || urlPath.startsWith('/audio/')) {
      headers['Cache-Control'] = 'public, max-age=86400';
    }
    res.writeHead(200, headers);
    createReadStream(filePath).pipe(res);
  };
}
