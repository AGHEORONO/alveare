import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Package root (works from src/ under tsx and from dist/ after build). */
export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const PUBLIC_DIR = join(ROOT, 'public');
export const CLIENT_DIR = join(ROOT, 'client');
