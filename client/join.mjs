#!/usr/bin/env node
// Alveare join client. Zero dependencies, so a teammate with only Node can run:
//   curl -fsSL http://HOST:4747/join.mjs -o alveare-join.mjs && node alveare-join.mjs HOST:4747 CODE [name] [client]
// The `alveare join` CLI uses the same code (and adds mDNS discovery and a client picker).
//
// It exchanges the join code for a personal token, then, in the git repo of the cwd, connects one or
// more AI coding tools to the hive's MCP server and writes the team workflow where each tool reads it.
// Every file that holds the token is kept out of git.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { dirname, join as pjoin, resolve } from 'node:path';
import { homedir, userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';

export const MCP_NAME = 'hive';
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

// ───────────────────────── helpers ─────────────────────────

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

/** Is a command on PATH? */
export function hasCommand(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' });
  return r.status === 0;
}

/** Run a CLI; on Windows npm-installed tools are .cmd shims that need a shell. */
function run(cmd, args, cwd) {
  let r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.error && process.platform === 'win32') {
    const quoted = args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ');
    r = spawnSync(`${cmd} ${quoted}`, { cwd, encoding: 'utf8', shell: true });
  }
  return r;
}

function readJsonFile(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { throw new Error(`${file} is not valid JSON; fix or delete it and re-run`); }
}

function writeJsonFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

function isTracked(root, rel) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', rel], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
  for (const e of entries) {
    if (!e.endsWith('/') && isTracked(root, e)) {
      log(`  ! ${e} is tracked by git and now holds your token. Do not commit it: git rm --cached ${e}`);
    }
  }
}

/** Insert or replace the marked Alveare section in a markdown-ish file. */
export function upsertSection(file, snippet, prefix = '') {
  mkdirSync(dirname(file), { recursive: true });
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : prefix;
  const re = /<!-- hive:start -->[\s\S]*?<!-- hive:end -->\n?/;
  const block = snippet.trim() + '\n';
  const next = re.test(cur) ? cur.replace(re, block) : `${cur}${cur && !cur.endsWith('\n\n') ? (cur.endsWith('\n') ? '\n' : '\n\n') : ''}${block}`;
  if (next !== cur) writeFileSync(file, next);
  return file;
}

// ───────────────────────── AI clients ─────────────────────────

/**
 * Every client: how to register the hive MCP server (url + bearer header) and which instruction
 * files its agent reads. Formats checked against each tool's docs (Oct 2026).
 */
export const CLIENTS = {
  claude: {
    label: 'Claude Code',
    detect: () => hasCommand('claude'),
    instructions: ['CLAUDE.md'],
    hooks: true,
    register(root, url, token) {
      run('claude', ['mcp', 'remove', MCP_NAME, '-s', 'local'], root);
      const r = run('claude', ['mcp', 'add', '--transport', 'http', '--scope', 'local', MCP_NAME, url, '--header', `Authorization: Bearer ${token}`], root);
      if (r.error || r.status !== 0) {
        log('  ! could not run `claude mcp add`. Run this in the repo root:');
        log(`    claude mcp add --transport http --scope local ${MCP_NAME} ${url} --header "Authorization: Bearer ${token}"`);
        return false;
      }
      return 'Claude Code: MCP server registered (local scope)';
    },
  },
  cursor: {
    label: 'Cursor',
    detect: () => hasCommand('cursor'),
    instructions: ['AGENTS.md', '.cursor/rules/alveare.mdc'],
    register(root, url, token) {
      const file = pjoin(root, '.cursor', 'mcp.json');
      const cfg = readJsonFile(file, {});
      (cfg.mcpServers ??= {})[MCP_NAME] = { url, headers: { Authorization: `Bearer ${token}` } };
      writeJsonFile(file, cfg);
      excludeFromGit(root, ['.cursor/mcp.json']);
      return 'Cursor: .cursor/mcp.json (enable "hive" in Cursor Settings › MCP if asked)';
    },
  },
  vscode: {
    label: 'VS Code (Copilot agent mode)',
    detect: () => hasCommand('code'),
    instructions: ['AGENTS.md', '.github/copilot-instructions.md'],
    register(root, url, token) {
      const file = pjoin(root, '.vscode', 'mcp.json');
      const cfg = readJsonFile(file, {});
      (cfg.servers ??= {})[MCP_NAME] = { type: 'http', url, headers: { Authorization: `Bearer ${token}` } };
      writeJsonFile(file, cfg);
      excludeFromGit(root, ['.vscode/mcp.json']);
      return 'VS Code: .vscode/mcp.json (start "hive" in the MCP view, then use Agent mode)';
    },
  },
  agy: {
    label: 'Antigravity CLI (agy)',
    detect: () => hasCommand('agy'),
    instructions: ['AGENTS.md', 'GEMINI.md'],
    register(root, url, token) {
      // agy keeps MCP servers per user (~/.gemini/config/mcp_config.json); `mcp add` updates in place.
      const r = run('agy', ['mcp', 'add', '--header', `Authorization: Bearer ${token}`, MCP_NAME, url], root);
      if (r.error || r.status !== 0) {
        log('  ! could not run `agy mcp add`. Run this yourself:');
        log(`    agy mcp add --header "Authorization: Bearer ${token}" ${MCP_NAME} ${url}`);
        return false;
      }
      return 'Antigravity CLI: registered with agy (check with: agy mcp list)';
    },
  },
  codex: {
    label: 'Codex CLI',
    detect: () => hasCommand('codex'),
    instructions: ['AGENTS.md'],
    register(_root, url, token) {
      const file = pjoin(process.env.CODEX_HOME ?? pjoin(homedir(), '.codex'), 'config.toml');
      mkdirSync(dirname(file), { recursive: true });
      const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
      const block = `# >>> alveare (managed by alveare join)\n[mcp_servers.${MCP_NAME}]\nurl = "${url}"\nhttp_headers = { "Authorization" = "Bearer ${token}" }\n# hive tools only change hive state (tasks, claims, messages), never files: skip per-call prompts\ndefault_tools_approval_mode = "approve"\n# <<< alveare\n`;
      const re = /# >>> alveare[\s\S]*?# <<< alveare\n?/;
      writeFileSync(file, re.test(cur) ? cur.replace(re, block) : `${cur}${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}${block}`);
      return `Codex CLI: ${file} (check with /mcp)`;
    },
  },
  opencode: {
    label: 'opencode',
    detect: () => hasCommand('opencode'),
    instructions: ['AGENTS.md'],
    register(root, url, token) {
      const file = pjoin(root, 'opencode.json');
      const cfg = readJsonFile(file, { $schema: 'https://opencode.ai/config.json' });
      (cfg.mcp ??= {})[MCP_NAME] = { type: 'remote', url, headers: { Authorization: `Bearer ${token}` }, enabled: true };
      writeJsonFile(file, cfg);
      excludeFromGit(root, ['opencode.json']);
      return 'opencode: opencode.json (check with: opencode mcp list)';
    },
  },
  other: {
    label: 'Other MCP client (manual setup)',
    detect: () => false,
    instructions: ['AGENTS.md'],
    register(_root, url, token) {
      log('  Add this MCP server to your AI tool (streamable HTTP):');
      log(`    URL:     ${url}`);
      log(`    Header:  Authorization: Bearer ${token}`);
      log(`    JSON:    {"mcpServers":{"${MCP_NAME}":{"url":"${url}","headers":{"Authorization":"Bearer ${token}"}}}}`);
      log('  Keep that config out of git: it contains your personal token.');
      return 'manual setup printed above';
    },
  },
};

/** Old names that now map to another client (Gemini CLI was replaced by the Antigravity CLI). */
export const CLIENT_ALIASES = { gemini: 'agy', antigravity: 'agy' };
export const resolveClient = (id) => CLIENT_ALIASES[id] ?? id;

export function detectClients() {
  return Object.entries(CLIENTS).filter(([, c]) => c.detect()).map(([id]) => id);
}

function writeInstructions(root, clientIds, snippet) {
  const files = new Set(clientIds.map(resolveClient).flatMap((id) => CLIENTS[id]?.instructions ?? []));
  for (const rel of files) {
    const prefix = rel.endsWith('.mdc') ? '---\ndescription: Alveare team workflow (multi-agent coordination)\nalwaysApply: true\n---\n\n' : '';
    upsertSection(pjoin(root, rel), snippet, prefix);
  }
  return [...files];
}

/** Claude Code hooks: async, fire-and-forget. `hook` = how to run the forwarder. */
export function installHooks(root, hook) {
  const file = pjoin(root, '.claude', 'settings.local.json');
  const settings = readJsonFile(file, {});
  settings.hooks ??= {};
  const ours = (h) => (h.args ?? []).some((a) => /[\\/]\.hive[\\/](hook\.mjs|config\.json)$/.test(String(a)));
  for (const [event, groups] of Object.entries(settings.hooks)) {
    if (!Array.isArray(groups)) continue;
    settings.hooks[event] = groups.map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !ours(h)) })).filter((g) => g.hooks.length);
    if (!settings.hooks[event].length) delete settings.hooks[event];
  }
  for (const { event, matcher } of HOOK_EVENTS) {
    const group = { ...(matcher ? { matcher } : {}), hooks: [{ type: 'command', command: hook.command, args: hook.args, async: true, timeout: 5 }] };
    (settings.hooks[event] ??= []).push(group);
  }
  writeJsonFile(file, settings);
  return file;
}

function writeHiveDir(root, cfg, hookSource) {
  const dir = pjoin(root, '.hive');
  mkdirSync(dir, { recursive: true });
  writeFileSync(pjoin(dir, 'config.json'), JSON.stringify(cfg, null, 2) + '\n');
  if (hookSource) writeFileSync(pjoin(dir, 'hook.mjs'), hookSource);
  excludeFromGit(root, ['.hive/', '.claude/settings.local.json']);
}

function connectClients(root, cfg, clientIds, hook) {
  for (const id of clientIds.map(resolveClient)) {
    const c = CLIENTS[id];
    if (!c) { log(`  ! unknown client "${id}" (known: ${Object.keys(CLIENTS).join(', ')})`); continue; }
    const msg = c.register(root, cfg.mcp_url, cfg.token);
    if (msg) log(`  ✓ ${msg}`);
    if (c.hooks) log(`  ✓ live activity hooks installed in ${installHooks(root, hook)}`);
  }
}

// ───────────────────────── flows ─────────────────────────

/**
 * Full join flow. Returns the config written to .hive/config.json.
 * @param {{ address: string, code: string, name?: string, cwd?: string, clients?: string[],
 *           skipInstructions?: boolean, hook?: { command: string, args: string[] } }} opts
 *   `hook`: how Claude Code runs the hook forwarder (default: node <repo>/.hive/hook.mjs).
 */
export async function join(opts) {
  const server = normalizeAddress(opts.address);
  const gitRoot = repoRoot(opts.cwd);
  const root = gitRoot ?? resolve(opts.cwd ?? process.cwd());
  if (!gitRoot) log(`  ! ${root} is not a git repo; installing there anyway`);
  const name = opts.name ?? defaultName();
  const clients = (opts.clients?.length ? opts.clients : [detectClients()[0] ?? 'other']).map(resolveClient);

  log(`→ joining ${server} as "${name}" with ${clients.map((c) => CLIENTS[c]?.label ?? c).join(', ')}`);
  const r = await getJson(`${server}/api/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: opts.code, name }),
  });
  const cfg = { server, name: r.name, token: r.token, mcp_url: r.mcp_url, hook_url: r.hook_url, dashboard_url: r.dashboard_url, repo_root: root, clients };

  const [hookSource, snippet] = await Promise.all([getText(`${server}/hook.mjs`), getText(`${server}/snippet.md`)]);
  writeHiveDir(root, cfg, hookSource);
  log('  ✓ token saved to .hive/config.json (git-excluded)');
  connectClients(root, cfg, clients, opts.hook ?? { command: 'node', args: [pjoin(root, '.hive', 'hook.mjs')] });
  if (!opts.skipInstructions) log(`  ✓ team workflow written to ${writeInstructions(root, clients, snippet).join(', ')}`);
  log(`\nJoined colony "${r.session}" as ${r.name} (${r.role === 'leader' ? 'queen / leader' : 'worker'}). Dashboard: ${r.dashboard_url}`);
  log('Restart your AI tool in this repo, then tell it: "start hive workflow"');
  return cfg;
}

/** Point an existing join at a new server address (after `alveare import` on another laptop). */
export async function rehost(address, cwd, hook) {
  const root = repoRoot(cwd) ?? resolve(cwd ?? process.cwd());
  const file = pjoin(root, '.hive', 'config.json');
  if (!existsSync(file)) throw new Error('no .hive/config.json here; run alveare join first');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  const server = normalizeAddress(address);
  await getJson(`${server}/api/info`);
  Object.assign(cfg, { server, mcp_url: `${server}/mcp`, hook_url: `${server}/api/hook`, dashboard_url: `${server}/` });
  writeHiveDir(root, cfg, await getText(`${server}/hook.mjs`));
  connectClients(root, cfg, cfg.clients ?? ['claude'], hook ?? { command: 'node', args: [pjoin(root, '.hive', 'hook.mjs')] });
  log(`✓ now pointing at ${server}. Restart your AI tool.`);
  return cfg;
}

// Standalone use: node alveare-join.mjs HOST[:PORT] JOINCODE [NAME] [CLIENT[,CLIENT]]
if (import.meta.url.endsWith('/join.mjs') && process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [address, code, name, clients] = process.argv.slice(2);
  if (!address || !code) {
    console.error(`usage: node alveare-join.mjs HOST[:PORT] JOINCODE [NAME] [${Object.keys(CLIENTS).join('|')}]`);
    process.exit(2);
  }
  join({ address, code, name, clients: clients?.split(',') }).catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
}
