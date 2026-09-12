// Copies only the files that should ship into dist/. No bundling, no transforms.
import { cpSync, mkdirSync, rmSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, 'dist');

// Clear dist/ contents rather than the folder itself: a running `wrangler dev`
// holds the folder open on Windows, and files are overwritten below anyway.
mkdirSync(dist, { recursive: true });
for (const entry of readdirSync(dist)) {
  try { rmSync(join(dist, entry), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
  catch (e) { console.warn(`Could not remove dist/${entry} (${e.code}); overwriting in place.`); }
}

for (const f of ['index.html', 'admin.html', 'manifest.webmanifest', 'assets']) {
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
/assets/js/*
  Cache-Control: public, max-age=0, must-revalidate
/assets/css/*
  Cache-Control: public, max-age=0, must-revalidate
/assets/icon.svg
  Cache-Control: public, max-age=86400
`);

console.log('Built dist/');
