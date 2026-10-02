import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Hive, type HiveOptions, type TaskStatus } from '../core/hive.js';
import { openDb } from '../core/db.js';
import { HookIngest, type HookEvent } from '../core/hooks.js';
import { HiveError } from '../core/errors.js';
import { errorView } from '../core/format.js';
import { handleMcp } from './mcp.js';
import { snapshot } from './state.js';
import { IS_SEA, readAsset } from '../paths.js';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ServerOptions extends HiveOptions {
  dbFile: string;
  port?: number;
  host?: string;
  /** Explicit name (overrides an imported one). */
  sessionName?: string;
  /** Used only when the database has no session name yet. */
  defaultSessionName?: string;
  log?: (msg: string) => void;
}

export interface HiveServer {
  hive: Hive;
  hooks: HookIngest;
  server: Server;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.sh': 'text/plain; charset=utf-8', '.ps1': 'text/plain; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8',
};
const MAX_BODY = 1024 * 1024;
const DASH_COOKIE = 'hive_dash';
const HOOK_FIELDS: (keyof HookEvent)[] = ['hook_event_name', 'session_id', 'cwd', 'agent_id', 'agent_type', 'source', 'reason',
  'tool_name', 'file_path', 'description', 'subagent_type', 'task_title'];

export async function startServer(opts: ServerOptions): Promise<HiveServer> {
  const log = opts.log ?? (() => {});
  const hive = new Hive(openDb(opts.dbFile), opts);
  if (opts.sessionName) hive.setMeta('session_name', opts.sessionName);
  else if (opts.defaultSessionName && !hive.getMeta('session_name')) hive.setMeta('session_name', opts.defaultSessionName);
  hive.joinCode();
  const hooks = new HookIngest(hive);
  const dashSessions = new Set<string>();
  const joinAttempts = new Map<string, number[]>();

  // ── SSE: push a full snapshot (debounced) whenever state changes ──
  const streams = new Set<ServerResponse>();
  let pending: NodeJS.Timeout | null = null;
  const broadcast = () => {
    pending = null;
    if (!streams.size) return;
    const data = `data: ${JSON.stringify(snapshot(hive, hooks))}\n\n`;
    for (const s of streams) s.write(data);
  };
  // Coalesce bursts: at most one push per second keeps dashboards calm during busy periods.
  hive.onChange = () => { if (!pending) pending = setTimeout(broadcast, 1000); };

  // Periodic upkeep: expire claims and refresh relative times / online status on dashboards.
  const ticker = setInterval(() => { hive.pruneExpiredClaims(); broadcast(); }, 15_000);
  const keepalive = setInterval(() => { for (const s of streams) s.write(': ping\n\n'); }, 25_000);

  const cookieOk = (req: IncomingMessage) => {
    const m = /(?:^|;\s*)hive_dash=([\w-]+)/.exec(req.headers.cookie ?? '');
    return !!m && dashSessions.has(m[1]);
  };
  const bearerAgent = (req: IncomingMessage) => {
    const h = req.headers.authorization;
    return h?.startsWith('Bearer ') ? hive.authenticate(h.slice(7).trim()) : null;
  };

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path === '/mcp') {
      const body = method === 'POST' ? await readJson(req) : undefined;
      return handleMcp(hive, req, res, body);
    }

    if (path === '/api/info' && method === 'GET') {
      return json(res, 200, { name: 'hive', session: hive.getMeta('session_name') ?? 'Hive', leader: hive.leaderStatus().leader });
    }

    // Join codes are short, so wrong guesses are rate-limited per IP (5/min across join + login).
    const limited = () => {
      const ip = req.socket.remoteAddress ?? '?';
      const now = Date.now();
      const tries = (joinAttempts.get(ip) ?? []).filter((t) => now - t < 60_000);
      if (tries.length >= 5) { json(res, 429, { ok: false, error: 'too many attempts; wait a minute' }); return true; }
      return false;
    };
    const failed = () => {
      const ip = req.socket.remoteAddress ?? '?';
      joinAttempts.set(ip, [...(joinAttempts.get(ip) ?? []), Date.now()]);
    };

    if (path === '/api/join' && method === 'POST') {
      if (limited()) return;
      const ip = req.socket.remoteAddress ?? '?';
      const { code, name } = (await readJson(req)) as { code?: string; name?: string };
      if (!code || !hive.checkJoinCode(code)) { failed(); return json(res, 403, { ok: false, error: 'wrong join code' }); }
      const { agent, token } = hive.registerAgent(String(name ?? ''));
      log(`${agent.name} joined from ${ip}`);
      const base = `http://${req.headers.host}`;
      return json(res, 200, {
        ok: true, token, name: agent.name, role: hive.isLeader(agent.id) ? 'leader' : 'member',
        session: hive.getMeta('session_name') ?? 'Hive', mcp_url: `${base}/mcp`, hook_url: `${base}/api/hook`, dashboard_url: `${base}/`,
      });
    }

    if (path === '/api/hook' && method === 'POST') {
      const agent = bearerAgent(req);
      if (!agent) return json(res, 401, { ok: false });
      const raw = (await readJson(req)) as Record<string, unknown>;
      const ev: Record<string, string> = {};
      for (const k of HOOK_FIELDS) if (typeof raw[k] === 'string') ev[k] = (raw[k] as string).slice(0, 500);
      if (!ev.hook_event_name) return json(res, 400, { ok: false });
      hooks.ingest(agent.id, ev as unknown as HookEvent);
      return json(res, 200, {});
    }

    if (path === '/api/login' && method === 'POST') {
      if (limited()) return;
      const { code } = (await readJson(req)) as { code?: string };
      if (!code || !hive.checkJoinCode(code)) { failed(); return json(res, 403, { ok: false, error: 'wrong join code' }); }
      const sid = randomBytes(18).toString('base64url');
      dashSessions.add(sid);
      res.setHeader('set-cookie', `${DASH_COOKIE}=${sid}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`);
      return json(res, 200, { ok: true });
    }

    if (path === '/api/export' && method === 'GET') {
      if (!cookieOk(req) && !bearerAgent(req)) return json(res, 401, { ok: false });
      const dir = await mkdtemp(join(tmpdir(), 'hive-export-'));
      const file = join(dir, 'export.hive');
      await hive.db.backup(file);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="hive-${stamp}.hive"`,
        'content-length': statSync(file).size,
      });
      const stream = createReadStream(file);
      stream.pipe(res);
      stream.on('close', () => { void rm(dir, { recursive: true, force: true }); });
      return;
    }

    if (path.startsWith('/api/')) {
      if (!cookieOk(req)) return json(res, 401, { ok: false, error: 'login required' });

      if (path === '/api/state' && method === 'GET') return json(res, 200, snapshot(hive, hooks));

      if (path === '/api/stream' && method === 'GET') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(`retry: 2000\ndata: ${JSON.stringify(snapshot(hive, hooks))}\n\n`);
        streams.add(res);
        req.on('close', () => streams.delete(res));
        return;
      }

      if (path === '/api/action' && method === 'POST') {
        const body = (await readJson(req)) as Record<string, unknown>;
        try {
          return json(res, 200, { ok: true, result: humanAction(hive, body) });
        } catch (e) {
          return json(res, e instanceof HiveError ? 400 : 500, errorView(e));
        }
      }
      return json(res, 404, { ok: false, error: 'not found' });
    }

    // Zero-dependency client files for teammates without Hive installed.
    // Standalone binaries for the one-line installer, so teammates can install with no internet.
    const dl = /^\/download\/(alveare-(?:windows|macos|linux)-(?:x64|arm64)(?:\.exe)?)$/.exec(path);
    if (method === 'GET' && dl) {
      const file = findBinary(dl[1]);
      if (!file) return json(res, 404, { ok: false, error: 'this host has no copy of that binary' });
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size });
      createReadStream(file).pipe(res);
      return;
    }

    if (method === 'GET' && ['/join.mjs', '/hook.mjs', '/snippet.md', '/install.sh', '/install.ps1'].includes(path)) {
      return sendAsset(res, `client${path}`);
    }

    if (method === 'GET') {
      const rel = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
      return sendAsset(res, `public/${rel}`);
    }
    json(res, 404, { ok: false });
  }

  const server = createServer((req, res) => {
    route(req, res).catch((e) => {
      if (e instanceof BodyError) return json(res, e.status, { ok: false, error: e.message });
      log(`error ${req.method} ${req.url}: ${e instanceof Error ? e.stack : e}`);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 4747, opts.host ?? '0.0.0.0', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;

  return {
    hive, hooks, server, port,
    async close() {
      clearInterval(ticker);
      clearInterval(keepalive);
      if (pending) clearTimeout(pending);
      for (const s of streams) s.end();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      hive.db.close();
    },
  };
}

/** Dashboard overrides. Humans act with `null` actor, which passes every leader check. */
function humanAction(hive: Hive, b: Record<string, unknown>): unknown {
  const id = Number(b.id);
  const str = (k: string) => { const v = b[k]; if (typeof v !== 'string' || !v.trim()) throw new HiveError('invalid', `${k} required`); return v; };
  switch (b.action) {
    case 'assign': return hive.assignTask(null, id, str('agent'));
    case 'reassign': return hive.reassignTask(null, id, str('agent'), typeof b.note === 'string' ? b.note : 'changed from dashboard');
    case 'set_status': return hive.updateTask(null, id, str('status') as TaskStatus, typeof b.note === 'string' ? b.note : 'set from dashboard');
    case 'review': return hive.reviewTask(null, id, str('verdict') as 'approve' | 'changes_requested', typeof b.notes === 'string' ? b.notes : undefined);
    case 'release': return hive.forceRelease(null, Array.isArray(b.paths) ? b.paths.map(String) : [str('path')]);
    case 'set_leader': return hive.transferLeadership(null, str('agent'));
    case 'rotate_code': { const code = hive.rotateJoinCode(); hive.event('code_rotated'); return { code }; }
    default: throw new HiveError('invalid', `unknown action ${String(b.action)}`);
  }
}

class BodyError extends Error { constructor(public status: number, msg: string) { super(msg); } }

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new BodyError(413, 'body too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new BodyError(400, 'invalid JSON'); }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function sendAsset(res: ServerResponse, rel: string): void {
  const body = readAsset(rel);
  if (!body) return json(res, 404, { ok: false });
  res.writeHead(200, { 'content-type': MIME[extname(rel)] ?? 'application/octet-stream', 'cache-control': 'no-cache', 'content-length': body.length });
  res.end(body);
}

/** Name of the release asset matching this machine, e.g. alveare-windows-x64.exe. */
export function ownAssetName(): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  return `alveare-${os}-${process.arch === 'arm64' ? 'arm64' : 'x64'}${os === 'windows' ? '.exe' : ''}`;
}

/** This executable (when it is the requested platform), or a copy next to it / in ~/.alveare/bin. */
function findBinary(asset: string): string | null {
  if (IS_SEA && asset === ownAssetName()) return process.execPath;
  for (const dir of [dirname(process.execPath), join(homedir(), '.alveare', 'bin')]) {
    const f = join(dir, asset);
    if (existsSync(f)) return f;
  }
  return null;
}
