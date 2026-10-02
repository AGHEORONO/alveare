#!/usr/bin/env node
import './quiet.js';
import { parseArgs } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import * as joinLib from '../client/join.mjs';
import type { HookCommand } from '../client/join.mjs';
import { IS_SEA } from './paths.js';
import { VERSION } from './version.js';

const HELP = `alveare ${VERSION} — a hive for teams of AI coding agents on one repo

  alveare host   [--port 4747] [--name you] [--client claude] [--session name] [--claim-ttl min] [--no-join]
                 Start the hive here (you become queen/leader) and connect your own AI tool.
  alveare join   [host[:port]] [--code CODE] [--name you] [--client claude,cursor,...]
                 Find a hive on the LAN (mDNS) or use the address, then connect this repo.
                 Clients: ${Object.keys(joinLib.CLIENTS).join(', ')}
  alveare join   --rehost host[:port]     Point this repo at a new host after a handover.
  alveare export [-o file]                Snapshot the local hive (host).
  alveare export --from host[:port] [-o file] [--every min]
                 Pull a snapshot from a running host (any member; --every keeps a rolling backup).
  alveare import <file> [--force]         Restore a snapshot, then run alveare host.
  alveare status                          Show the hive this repo is joined to.
  alveare version`;

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

const defaultDb = () => join(joinLib.repoRoot() ?? process.cwd(), '.hive', 'hive.db');

/** How Claude Code should run the hook forwarder: the standalone exe itself, or node + hook.mjs. */
function hookCommand(): HookCommand | undefined {
  if (!IS_SEA) return undefined; // join.mjs default: node <repo>/.hive/hook.mjs
  const root = joinLib.repoRoot() ?? process.cwd();
  return { command: process.execPath, args: ['hook', join(root, '.hive', 'config.json')] };
}

/** --client value, or detect installed AI tools and ask when it's ambiguous. */
async function pickClients(flag: string | undefined): Promise<string[]> {
  if (flag) return flag.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  const found = joinLib.detectClients();
  if (found.length === 1 || !process.stdin.isTTY) return [found[0] ?? 'other'];
  const ids = Object.keys(joinLib.CLIENTS);
  console.log('Which AI tool(s) will you use in this repo?');
  ids.forEach((id, i) => console.log(`  ${i + 1}) ${joinLib.CLIENTS[id].label}${found.includes(id) ? '  (found)' : ''}`));
  const answer = await ask(`Numbers, comma-separated [${found.length ? found.map((f) => ids.indexOf(f) + 1).join(',') : ids.length}]: `);
  const picked = (answer || (found.length ? found.map((f) => String(ids.indexOf(f) + 1)).join(',') : String(ids.length)))
    .split(',').map((n) => ids[Number(n.trim()) - 1]).filter(Boolean);
  return picked.length ? picked : ['other'];
}

async function host(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    port: { type: 'string', default: '4747' }, name: { type: 'string' }, session: { type: 'string' }, client: { type: 'string' },
    db: { type: 'string' }, 'claim-ttl': { type: 'string' }, 'no-join': { type: 'boolean', default: false },
  } });
  const dbFile = resolve(values.db ?? defaultDb());
  mkdirSync(dirname(dbFile), { recursive: true });
  const repo = joinLib.repoRoot();
  const { startServer } = await import('./server/index.js');
  const { advertise, lanAddresses } = await import('./server/discovery.js');
  const srv = await startServer({
    dbFile, port: Number(values.port), sessionName: values.session,
    defaultSessionName: repo ? repo.split(/[\\/]/).pop()! : 'hive',
    claimTtlMs: values['claim-ttl'] ? Number(values['claim-ttl']) * 60_000 : undefined,
    log: (m) => console.log(`[alveare] ${m}`),
  });
  const session = srv.hive.getMeta('session_name') ?? 'hive';
  const stopMdns = advertise(srv.port, session);
  const ips = lanAddresses();
  const code = srv.hive.joinCode();
  const primary = `${ips[0] ?? 'localhost'}:${srv.port}`;

  if (!values['no-join']) {
    const name = values.name ?? joinLib.defaultName();
    const clients = await pickClients(values.client);
    await joinLib.join({ address: `127.0.0.1:${srv.port}`, code, name, clients, hook: hookCommand() });
    srv.hive.db.prepare('UPDATE agents SET is_host = 1 WHERE name = ? COLLATE NOCASE').run(name);
  }

  console.log(`
┌─ Alveare · colony "${session}" is buzzing ─────────────────────
│  Join code:  ${code}
│  Dashboard:  ${ips.map((ip) => `http://${ip}:${srv.port}/`).join('\n│              ') || `http://localhost:${srv.port}/`}
│  Teammates, in their clone of the repo:
│    alveare join                    (finds this hive automatically)
│    alveare join ${primary} --code ${code}
│  No Alveare installed yet? One line installs it and joins:
│    macOS/Linux:  curl -fsSL http://${primary}/install.sh | sh -s -- ${primary} ${code}
│    Windows:      & ([scriptblock]::Create((irm http://${primary}/install.ps1))) ${primary} ${code}
│  Database:   ${dbFile}
└─ Ctrl+C to stop. Export before leaving: alveare export
`);

  const shutdown = async () => {
    console.log('\n[alveare] shutting down…');
    await stopMdns().catch(() => {});
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function joinCmd(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    code: { type: 'string' }, name: { type: 'string' }, client: { type: 'string' }, rehost: { type: 'string' },
    'no-instructions': { type: 'boolean', default: false },
  } });
  if (values.rehost) { await joinLib.rehost(values.rehost, undefined, hookCommand()); return; }

  let address = positionals[0];
  if (!address) {
    const { discover } = await import('./server/discovery.js');
    console.log('Looking for a hive on the LAN (3 s)…');
    const found = await discover(3000);
    if (found.length === 1) {
      address = `${found[0].address}:${found[0].port}`;
      console.log(`Found colony "${found[0].session}" at ${address}`);
    } else if (found.length > 1) {
      found.forEach((f, i) => console.log(`  ${i + 1}) ${f.session}  ${f.address}:${f.port}`));
      const f = found[Number(await ask('Which one? ')) - 1] ?? found[0];
      address = `${f.address}:${f.port}`;
    } else {
      console.log('None found (the Wi-Fi may block discovery). Use the address shown in the host\'s terminal.');
      address = await ask('Host address (e.g. 192.168.1.20:4747): ');
    }
  }
  const code = values.code ?? positionals[1] ?? await ask('Join code: ');
  const clients = await pickClients(values.client);
  await joinLib.join({ address, code, name: values.name, clients, skipInstructions: values['no-instructions'], hook: hookCommand() });
}

function readConfig(): Record<string, string> {
  const file = join(joinLib.repoRoot() ?? process.cwd(), '.hive', 'config.json');
  if (!existsSync(file)) throw new Error('this repo has not joined a hive (no .hive/config.json). Run: alveare join');
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function exportCmd(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    out: { type: 'string', short: 'o' }, from: { type: 'string' }, db: { type: 'string' }, every: { type: 'string' },
  } });
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  if (!values.from) {
    const dbFile = resolve(values.db ?? defaultDb());
    if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
    const { openDb } = await import('./core/db.js');
    const db = openDb(dbFile);
    const out = resolve(values.out ?? `alveare-${stamp()}.hive`);
    await db.backup(out);
    db.close();
    console.log(`✓ exported to ${out}`);
    return;
  }
  const server = joinLib.normalizeAddress(values.from);
  const token = readConfig().token;
  const pull = async () => {
    const res = await fetch(`${server}/api/export`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`export failed: HTTP ${res.status}`);
    const out = resolve(values.out ?? (values.every ? 'alveare-mirror.hive' : `alveare-${stamp()}.hive`));
    writeFileSync(out + '.tmp', Buffer.from(await res.arrayBuffer()));
    copyFileSync(out + '.tmp', out);
    rmSync(out + '.tmp', { force: true });
    console.log(`✓ ${new Date().toLocaleTimeString()} pulled snapshot → ${out}`);
  };
  await pull();
  if (values.every) {
    console.log(`Mirroring every ${values.every} min. Ctrl+C to stop.`);
    setInterval(() => { pull().catch((e) => console.error(`! ${e.message}`)); }, Number(values.every) * 60_000);
  }
}

async function importCmd(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    db: { type: 'string' }, force: { type: 'boolean', default: false },
  } });
  const src = positionals[0];
  if (!src || !existsSync(src)) throw new Error('usage: alveare import <file.hive>');
  const dbFile = resolve(values.db ?? defaultDb());
  if (existsSync(dbFile) && !values.force) throw new Error(`${dbFile} exists; pass --force to replace it`);
  mkdirSync(dirname(dbFile), { recursive: true });
  for (const ext of ['-wal', '-shm']) rmSync(dbFile + ext, { force: true });
  copyFileSync(src, dbFile);
  const { openDb } = await import('./core/db.js');
  const { Hive } = await import('./core/hive.js');
  const hive = new Hive(openDb(dbFile));
  const n = hive.tasks().length;
  const leader = hive.leaderStatus().leader;
  hive.db.close();
  console.log(`✓ imported ${n} tasks (queen: ${leader ?? 'none'}) into ${dbFile}
Next: alveare host   — then teammates run:  alveare join --rehost <your-ip>:4747
(Their tokens keep working.)`);
}

async function status() {
  const cfg = readConfig();
  try {
    const info = await fetch(`${cfg.server}/api/info`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()) as { session: string; leader: string };
    console.log(`joined colony "${info.session}" at ${cfg.server} as ${cfg.name}; queen: ${info.leader}\ndashboard: ${cfg.dashboard_url}`);
  } catch {
    console.log(`joined ${cfg.server} as ${cfg.name}, but the hive is unreachable.\nIf the host moved: alveare join --rehost <new-ip>:4747`);
  }
}

/** Claude Code hook forwarder (standalone exe mode). Never fails, never prints. */
async function hookCmd(configPath: string) {
  const { runHook } = await import('../client/hook.mjs');
  await runHook(configPath).catch(() => {});
  process.exit(0);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'host': return host(rest);
    case 'join': return joinCmd(rest);
    case 'export': return exportCmd(rest);
    case 'import': return importCmd(rest);
    case 'status': return status();
    case 'hook': return hookCmd(rest[0]);
    case 'version': case '--version': case '-v': console.log(VERSION); return;
    default: console.log(HELP); process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0);
  }
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });
