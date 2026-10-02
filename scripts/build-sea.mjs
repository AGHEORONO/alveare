// Builds a standalone Alveare executable for the current OS/arch with Node's Single Executable
// Applications (SEA): bundle → blob (with the dashboard + client files as assets) → inject into a
// copy of the running node binary. Output: release/alveare-<os>-<arch>[.exe]
//   node scripts/build-sea.mjs
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { inject } from 'postject';

const root = fileURLToPath(new URL('..', import.meta.url));
const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const asset = `alveare-${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}${os === 'windows' ? '.exe' : ''}`;
const buildDir = join(root, 'build');
const outDir = join(root, 'release');
const out = join(outDir, asset);
const sh = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });

rmSync(buildDir, { recursive: true, force: true });
mkdirSync(buildDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

console.log('1/4 bundling');
await build({
  entryPoints: [join(root, 'src', 'cli.ts')],
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  outfile: join(buildDir, 'alveare.cjs'),
  // ESM's import.meta.url has no CJS equivalent; derive it from __filename.
  banner: { js: "const __import_meta_url = require('url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__import_meta_url' },
  logLevel: 'warning',
});

console.log('2/4 preparing blob');
const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : [p];
});
const assets = {};
for (const f of [...files(join(root, 'public')), ...['join.mjs', 'hook.mjs', 'snippet.md', 'install.sh', 'install.ps1'].map((f) => join(root, 'client', f))]) {
  assets[relative(root, f).split('\\').join('/')] = f;
}
const seaConfig = join(buildDir, 'sea-config.json');
writeFileSync(seaConfig, JSON.stringify({
  main: join(buildDir, 'alveare.cjs'),
  output: join(buildDir, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
}, null, 2));
sh(process.execPath, ['--experimental-sea-config', seaConfig]);

console.log(`3/4 copying node → ${asset}`);
rmSync(out, { force: true });
copyFileSync(process.execPath, out);
chmodSync(out, 0o755);
if (os === 'macos') sh('codesign', ['--remove-signature', out]);

console.log('4/4 injecting');
await inject(out, 'NODE_SEA_BLOB', readFileSync(join(buildDir, 'sea-prep.blob')), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(os === 'macos' ? { machoSegmentName: 'NODE_SEA' } : {}),
});
if (os === 'macos') sh('codesign', ['--sign', '-', out]);

console.log(`✓ ${out} (${(statSync(out).size / 1e6).toFixed(0)} MB)`);
