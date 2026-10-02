#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CLIENT_DIR } from './paths.js';

const HELP = `hive — coordinate several Claude Code agents on one repo

  hive host   [--port 4747] [--name you] [--session name] [--db file] [--claim-ttl min] [--no-join]
              Start the server here (you become leader) and connect your own Claude Code.
  hive join   [host[:port]] [--code CODE] [--name you] [--no-claude-md]
              Find a Hive on the LAN (mDNS) or use the given address, then connect this repo.
  hive join   --rehost host[:port]      Point this repo at a new host after a handover.
  hive export [-o file] [--db file]     Snapshot the local session (host).
  hive export --from host[:port] [-o file] [--every min]
              Pull a snapshot from a running host (any member; --every keeps a rolling backup).
  hive import <file> [--db file] [--force]   Restore a snapshot, then run hive host.
  hive status                           Show the server this repo is joined to.`;

type JoinLib = {
  join(o: { address: string; code: string; name?: string; cwd?: string; skipClaudeMd?: boolean }): Promise<Record<string, string>>;
  rehost(address: string, cwd?: string): Promise<Record<string, string>>;
  repoRoot(cwd?: string): string | null;
  defaultName(): string;
  normalizeAddress(a: string): string;
};
const joinLib = (): Promise<JoinLib> => import(pathToFileURL(join(CLIENT_DIR, 'join.mjs')).href);

async function ask(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

async function defaultDb(): Promise<string> {
  const lib = await joinLib();
  return join(lib.repoRoot() ?? process.cwd(), '.hive', 'hive.db');
}

async function host(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    port: { type: 'string', default: '4747' }, name: { type: 'string' }, session: { type: 'string' },
    db: { type: 'string' }, 'claim-ttl': { type: 'string' }, 'no-join': { type: 'boolean', default: false },
  } });
  const lib = await joinLib();
  const dbFile = resolve(values.db ?? await defaultDb());
  mkdirSync(dirname(dbFile), { recursive: true });
  const repo = lib.repoRoot();
  const { startServer } = await import('./server/index.js');
  const { advertise, lanAddresses } = await import('./server/discovery.js');
  const srv = await startServer({
    dbFile, port: Number(values.port), sessionName: values.session,
    defaultSessionName: repo ? repo.split(/[\\/]/).pop()! : 'hive',
    claimTtlMs: values['claim-ttl'] ? Number(values['claim-ttl']) * 60_000 : undefined,
    log: (m) => console.log(`[hive] ${m}`),
  });
  const session = srv.hive.getMeta('session_name') ?? 'hive';
  const stopMdns = advertise(srv.port, session);
  const ips = lanAddresses();
  const code = srv.hive.joinCode();
  const primary = `${ips[0] ?? 'localhost'}:${srv.port}`;

  if (!values['no-join']) {
    const name = values.name ?? lib.defaultName();
    await lib.join({ address: `127.0.0.1:${srv.port}`, code, name });
    srv.hive.db.prepare('UPDATE agents SET is_host = 1 WHERE name = ? COLLATE NOCASE').run(name);
  }

  console.log(`
┌─ Hive "${session}" is running ─────────────────────────────
│  Join code:  ${code}
│  Dashboard:  ${ips.map((ip) => `http://${ip}:${srv.port}/`).join('\n│              ') || `http://localhost:${srv.port}/`}
│  Teammates (in their clone of the repo):
│    hive join                      (auto-discovers via mDNS)
│    hive join ${primary} --code ${code}
│  No Hive installed? (Windows PowerShell: type curl.exe instead of curl)
│    curl -fsSL http://${primary}/join.mjs -o hive-join.mjs
│    node hive-join.mjs ${primary} ${code}
│  Database:   ${dbFile}
└─ Ctrl+C to stop. Export before leaving: hive export
`);

  const shutdown = async () => {
    console.log('\n[hive] shutting down…');
    await stopMdns().catch(() => {});
    await srv.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function joinCmd(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    code: { type: 'string' }, name: { type: 'string' }, rehost: { type: 'string' }, 'no-claude-md': { type: 'boolean', default: false },
  } });
  const lib = await joinLib();
  if (values.rehost) { await lib.rehost(values.rehost); return; }

  let address = positionals[0];
  if (!address) {
    const { discover } = await import('./server/discovery.js');
    console.log('Looking for Hive servers on the LAN (3 s)…');
    const found = await discover(3000);
    if (found.length === 1) {
      address = `${found[0].address}:${found[0].port}`;
      console.log(`Found "${found[0].session}" at ${address}`);
    } else if (found.length > 1) {
      found.forEach((f, i) => console.log(`  ${i + 1}) ${f.session}  ${f.address}:${f.port}`));
      const pick = Number(await ask('Which one? ')) - 1;
      const f = found[pick] ?? found[0];
      address = `${f.address}:${f.port}`;
    } else {
      console.log('None found (the Wi-Fi may block discovery). Ask the host for the address shown in their terminal.');
      address = await ask('Host address (e.g. 192.168.1.20:4747): ');
    }
  }
  const code = values.code ?? positionals[1] ?? await ask('Join code: ');
  await lib.join({ address, code, name: values.name, skipClaudeMd: values['no-claude-md'] });
}

function readConfig(lib: JoinLib): Record<string, string> {
  const file = join(lib.repoRoot() ?? process.cwd(), '.hive', 'config.json');
  if (!existsSync(file)) throw new Error('this repo has not joined a Hive (no .hive/config.json)');
  return JSON.parse(readFileSync(file, 'utf8'));
}

async function exportCmd(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: {
    out: { type: 'string', short: 'o' }, from: { type: 'string' }, db: { type: 'string' }, every: { type: 'string' },
  } });
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  if (!values.from) {
    const dbFile = resolve(values.db ?? await defaultDb());
    if (!existsSync(dbFile)) throw new Error(`no database at ${dbFile}`);
    const { openDb } = await import('./core/db.js');
    const db = openDb(dbFile);
    const out = resolve(values.out ?? `hive-${stamp()}.hive`);
    await db.backup(out);
    db.close();
    console.log(`✓ exported to ${out}`);
    return;
  }
  const lib = await joinLib();
  const server = lib.normalizeAddress(values.from);
  const token = readConfig(lib).token;
  const pull = async () => {
    const res = await fetch(`${server}/api/export`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`export failed: HTTP ${res.status}`);
    const out = resolve(values.out ?? (values.every ? 'hive-mirror.hive' : `hive-${stamp()}.hive`));
    writeFileSync(out + '.tmp', Buffer.from(await res.arrayBuffer()));
    copyFileSync(out + '.tmp', out);
    console.log(`✓ ${new Date().toLocaleTimeString()} pulled snapshot → ${out}`);
  };
  await pull();
  if (values.every) {
    const ms = Number(values.every) * 60_000;
    console.log(`Mirroring every ${values.every} min. Ctrl+C to stop.`);
    setInterval(() => { pull().catch((e) => console.error(`! ${e.message}`)); }, ms);
  }
}

async function importCmd(argv: string[]) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    db: { type: 'string' }, force: { type: 'boolean', default: false },
  } });
  const src = positionals[0];
  if (!src || !existsSync(src)) throw new Error('usage: hive import <file.hive>');
  const dbFile = resolve(values.db ?? await defaultDb());
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
  console.log(`✓ imported ${n} tasks (leader: ${leader ?? 'none'}) into ${dbFile}
Next: hive host   — then teammates run:  hive join --rehost <your-ip>:4747
(Their existing tokens keep working. Use --name with the same name if you were already a member.)`);
}

async function status() {
  const lib = await joinLib();
  const cfg = readConfig(lib);
  try {
    const info = await fetch(`${cfg.server}/api/info`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()) as { session: string; leader: string };
    console.log(`joined "${info.session}" at ${cfg.server} as ${cfg.name}; leader: ${info.leader}\ndashboard: ${cfg.dashboard_url}`);
  } catch {
    console.log(`joined ${cfg.server} as ${cfg.name}, but the server is unreachable.\nIf the host moved: hive join --rehost <new-ip>:4747`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'host': return host(rest);
    case 'join': return joinCmd(rest);
    case 'export': return exportCmd(rest);
    case 'import': return importCmd(rest);
    case 'status': return status();
    default: console.log(HELP); process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 2 : 0);
  }
}

main().catch((e) => { console.error(`✗ ${e instanceof Error ? e.message : e}`); process.exit(1); });
