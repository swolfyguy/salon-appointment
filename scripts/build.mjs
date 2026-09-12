// Copies only the files that should ship into dist/. No bundling, no transforms.
import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

for (const f of ['index.html', 'manifest.webmanifest', 'assets']) {
  const from = join(root, f);
  if (!existsSync(from)) throw new Error(`Missing ${f}`);
  cpSync(from, join(dist, f), { recursive: true });
}

// Security headers served with every response. Cloudflare reads this file.
writeFileSync(join(dist, '_headers'), `/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()
/assets/*
  Cache-Control: public, max-age=3600
`);

console.log('Built dist/');
