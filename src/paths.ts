// Locates static files (dashboard + client scripts). From source or dist they live next to the
// package; inside the standalone executable (Node SEA) they are embedded assets.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, normalize, sep } from 'node:path';

/** Package root (works from src/ under tsx and from dist/ after build). */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));

type Sea = { isSea(): boolean; getAsset(key: string): ArrayBuffer };
let sea: Sea | null = null;
try { sea = createRequire(import.meta.url)('node:sea') as Sea; } catch { /* Node without SEA support */ }
export const IS_SEA = !!sea?.isSea();

/**
 * Read a packaged file by its repo-relative path, e.g. "public/index.html" or "client/hook.mjs".
 * Returns null if it does not exist or the path tries to escape its folder.
 */
export function readAsset(rel: string): Buffer | null {
  const clean = normalize(rel).split(sep).join('/');
  if (clean.startsWith('..') || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean) || !/^(public|client)\//.test(clean)) return null;
  if (IS_SEA) {
    try { return Buffer.from(sea!.getAsset(clean)); } catch { return null; }
  }
  const file = join(ROOT, clean);
  if (!existsSync(file) || !statSync(file).isFile()) return null;
  return readFileSync(file);
}
