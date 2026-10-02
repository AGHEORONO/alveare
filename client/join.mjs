#!/usr/bin/env node
// Hive join client. Zero dependencies, so a teammate with nothing installed can run:
//   curl -fsSL http://HOST:4747/join.mjs -o hive-join.mjs && node hive-join.mjs HOST:4747 CODE [name]
// The `hive join` CLI uses the same code (and adds mDNS discovery in front of it).
//
// It exchanges the join code for a personal token, then (in the git repo of the cwd):
//   - registers the MCP server:  claude mcp add -t http -s local hive <url> -H "Authorization: Bearer ..."
//   - writes .hive/config.json + .hive/hook.mjs   (git-excluded, holds the token)
//   - merges Hive hooks into .claude/settings.local.json (machine-local, never committed)
//   - inserts/updates the Hive section in CLAUDE.md
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join as pjoin, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';

const HOOK_MARKER = '.hive/hook.mjs';
const HOOK_EVENTS = [
  { event: 'SessionStart' },
  { event: 'SessionEnd' },
  { event: 'PreToolUse', matcher: 'Agent|Task' },
  { event: 'SubagentStart' },
  { event: 'SubagentStop' },
  { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  { event: 'Stop' },
  { event: 'TaskCompleted' },
];

const log = (msg) => console.log(msg);

export function repoRoot(cwd = process.cwd()) {
  try {
    return resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  } catch {
    return null;
  }
}

export function defaultName() {
  try {
    const n = execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split(/\s+/)[0];
    if (n) return n.replace(/[^\w.-]/g, '').slice(0, 32) || userInfo().username;
  } catch { /* fall through */ }
  return userInfo().username.slice(0, 32);
}

export function normalizeAddress(address) {
  let a = address.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(a)) a = `http://${a}`;
  const u = new URL(a);
  if (!u.port && u.protocol === 'http:') u.port = '4747';
  return u.origin;
}

async function getJson(url, init) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status} from ${url}`);
  return body;
}

async function getText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

/** Run the `claude` CLI; on Windows npm installs it as claude.cmd, which needs a shell. */
function claude(args, cwd) {
  let r = spawnSync('claude', args, { cwd, encoding: 'utf8' });
  if (r.error && process.platform === 'win32') {
    const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
    r = spawnSync(`claude ${quoted}`, { cwd, encoding: 'utf8', shell: true });
  }
  return r;
}

export function registerMcp(root, mcpUrl, token) {
  claude(['mcp', 'remove', 'hive', '-s', 'local'], root);
  const args = ['mcp', 'add', '--transport', 'http', '--scope', 'local', 'hive', mcpUrl, '--header', `Authorization: Bearer ${token}`];
  const r = claude(args, root);
  if (r.error || r.status !== 0) {
    log('  ! could not run `claude mcp add` automatically. Run this in the repo root:');
    log(`    claude mcp add --transport http --scope local hive ${mcpUrl} --header "Authorization: Bearer ${token}"`);
    return false;
  }
  return true;
}

function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix or delete it and re-run`); }
}

export function installHooks(root) {
  const dir = pjoin(root, '.claude');
  mkdirSync(dir, { recursive: true });
  const file = pjoin(dir, 'settings.local.json');
  const settings = readJsonFile(file, {});
  const hookPath = pjoin(root, '.hive', 'hook.mjs');
  settings.hooks ??= {};
  // Drop previous Hive entries, keep everything else the user has.
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !(h.args ?? []).some((a) => String(a).replace(/\\/g, '/').endsWith(HOOK_MARKER))) }))
      .filter((g) => g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  for (const { event, matcher } of HOOK_EVENTS) {
    const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: 'node', args: [hookPath], async: true, timeout: 5 }] };
    (settings.hooks[event] ??= []).push(group);
  }
  writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
  return file;
}

export function excludeFromGit(root, entries) {
  const gitDir = pjoin(root, '.git');
  if (!existsSync(gitDir)) return;
  const info = pjoin(gitDir, 'info');
  mkdirSync(info, { recursive: true });
  const file = pjoin(info, 'exclude');
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const missing = entries.filter((e) => !cur.split(/\r?\n/).includes(e));
  if (missing.length) appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

export function upsertClaudeMd(root, snippet) {
  const file = pjoin(root, 'CLAUDE.md');
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const re = /<!-- hive:start -->[\s\S]*?<!-- hive:end -->\n?/;
  const block = snippet.trim() + '\n';
  const next = re.test(cur) ? cur.replace(re, block) : `${cur}${cur && !cur.endsWith('\n\n') ? (cur.endsWith('\n') ? '\n' : '\n\n') : ''}${block}`;
  if (next !== cur) writeFileSync(file, next);
  return file;
}

function writeHiveDir(root, cfg, hookSource) {
  const dir = pjoin(root, '.hive');
  mkdirSync(dir, { recursive: true });
  writeFileSync(pjoin(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  writeFileSync(pjoin(dir, 'hook.mjs'), hookSource);
  excludeFromGit(root, ['.hive/', '.claude/settings.local.json']);
}

/**
 * Full join flow. Returns the config written to .hive/config.json.
 * @param {{ address: string, code: string, name?: string, cwd?: string, skipClaudeMd?: boolean }} opts
 */
export async function join(opts) {
  const server = normalizeAddress(opts.address);
  const root = repoRoot(opts.cwd) ?? resolve(opts.cwd ?? process.cwd());
  if (!repoRoot(opts.cwd)) log(`  ! ${root} is not a git repo; installing there anyway`);
  const name = opts.name ?? defaultName();

  log(`→ joining ${server} as "${name}"`);
  const r = await getJson(`${server}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: opts.code, name }),
  });
  const cfg = { server, name: r.name, token: r.token, mcp_url: r.mcp_url, hook_url: r.hook_url, dashboard_url: r.dashboard_url, repo_root: root };

  const [hookSource, snippet] = await Promise.all([getText(`${server}/hook.mjs`), getText(`${server}/snippet.md`)]);
  writeHiveDir(root, cfg, hookSource);
  log('  ✓ token saved to .hive/config.json (git-excluded)');
  const settingsFile = installHooks(root);
  log(`  ✓ hooks installed in ${settingsFile}`);
  if (registerMcp(root, r.mcp_url, r.token)) log('  ✓ MCP server "hive" registered (local scope)');
  if (!opts.skipClaudeMd) log(`  ✓ workflow section written to ${upsertClaudeMd(root, snippet)}`);
  log(`\nJoined session "${r.session}" as ${r.name} (${r.role}). Dashboard: ${r.dashboard_url}`);
  log('Restart Claude Code in this repo, then say: "start hive workflow"');
  return cfg;
}

/** Point an existing join at a new server address (after `hive import` on another laptop). */
export async function rehost(address, cwd) {
  const root = repoRoot(cwd) ?? resolve(cwd ?? process.cwd());
  const file = pjoin(root, '.hive', 'config.json');
  if (!existsSync(file)) throw new Error('no .hive/config.json here; run hive join first');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const server = normalizeAddress(address);
  await getJson(`${server}/api/info`);
  Object.assign(cfg, { server, mcp_url: `${server}/mcp`, hook_url: `${server}/api/hook`, dashboard_url: `${server}/` });
  writeHiveDir(root, cfg, await getText(`${server}/hook.mjs`));
  registerMcp(root, cfg.mcp_url, cfg.token);
  log(`✓ now pointing at ${server}. Restart Claude Code.`);
  return cfg;
}

// Standalone use: node hive-join.mjs HOST[:PORT] CODE [NAME]
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [address, code, name] = process.argv.slice(2);
  if (!address || !code) {
    console.error('usage: node hive-join.mjs HOST[:PORT] JOINCODE [NAME]');
    process.exit(2);
  }
  join({ address, code, name }).catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
