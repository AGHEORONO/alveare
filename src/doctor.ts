// `alveare doctor`: one command that explains why joining or syncing isn't working.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as joinLib from '../client/join.mjs';
import { VERSION } from './version.js';

type Level = 'ok' | 'warn' | 'fail' | 'info';
const ICON: Record<Level, string> = { ok: '✓', warn: '!', fail: '✗', info: '·' };
let problems = 0;
const say = (level: Level, msg: string, fix?: string) => {
  if (level === 'fail' || level === 'warn') problems++;
  console.log(`  ${ICON[level]} ${msg}${fix ? `\n      → ${fix}` : ''}`);
};

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = Date.now();
  const v = await fn();
  return [v, Date.now() - t];
}

/** Windows marks networks "Public" by default on new Wi-Fi, which blocks incoming connections. */
function windowsNetworkCategories(): string[] {
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', 'Get-NetConnectionProfile | ForEach-Object { "$($_.Name)=$($_.NetworkCategory)" }'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000 });
    return out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function clientConfigured(id: string, root: string, mcpUrl: string): boolean | null {
  const has = (file: string) => existsSync(file) && readFileSync(file, 'utf8').includes(mcpUrl);
  switch (id) {
    case 'cursor': return has(join(root, '.cursor', 'mcp.json'));
    case 'vscode': return has(join(root, '.vscode', 'mcp.json'));
    case 'agy': return has(join(homedir(), '.gemini', 'config', 'mcp_config.json'));
    case 'opencode': return has(join(root, 'opencode.json'));
    case 'codex': return has(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'));
    case 'claude': {
      try {
        const out = execFileSync(process.platform === 'win32' ? 'claude.exe' : 'claude', ['mcp', 'get', joinLib.MCP_NAME],
          { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 20000 });
        return out.includes(mcpUrl);
      } catch {
        return null;
      }
    }
    default: return null;
  }
}

export async function doctor(): Promise<void> {
  console.log(`alveare doctor ${VERSION} · ${process.platform}-${process.arch}\n`);

  console.log('This repo');
  const root = joinLib.repoRoot();
  if (!root) say('warn', 'not inside a git repo', 'cd into your clone of the project repo');
  else say('ok', `git repo: ${root}`);
  const cfgFile = join(root ?? process.cwd(), '.hive', 'config.json');
  const cfg = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) as joinLib.JoinConfig : null;
  if (!cfg) say('fail', 'not joined to a hive (no .hive/config.json)', 'alveare join');
  else say('ok', `joined as "${cfg.name}" → ${cfg.server}`);

  if (cfg) {
    console.log('\nThe hive');
    try {
      const [info, ms] = await timed(() => fetch(`${cfg.server}/api/info`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json() as Promise<{ session: string; leader: string }>));
      say('ok', `reachable in ${ms} ms: colony "${info.session}", queen ${info.leader ?? 'none'}`);
      const me = await fetch(`${cfg.server}/api/me`, { headers: { authorization: `Bearer ${cfg.token}` }, signal: AbortSignal.timeout(4000) });
      if (me.ok) {
        const m = await me.json() as { name: string; role: string };
        say('ok', `token valid: you are ${m.name} (${m.role === 'leader' ? 'queen' : 'worker'})`);
      } else if (me.status === 404) {
        say('info', 'the host runs an older Alveare without token checks; update it to see this check');
      } else {
        say('fail', 'this hive does not recognize your token', 'join again with the current code: alveare join <address> --code <code>');
      }
    } catch {
      say('fail', `cannot reach ${cfg.server}`, 'is the host running? same Wi-Fi? If the host moved: alveare join --rehost <new-ip>:4747. Otherwise try a phone hotspot or Tailscale.');
    }

    console.log('\nAI tools');
    for (const id of (cfg.clients ?? []).map(joinLib.resolveClient)) {
      const label = joinLib.CLIENTS[id]?.label ?? id;
      const ok = clientConfigured(id, cfg.repo_root, cfg.mcp_url);
      if (ok === true) say('ok', `${label} is configured for this hive`);
      else if (ok === false) say('fail', `${label} is not pointing at ${cfg.mcp_url}`, `alveare join --rehost ${new URL(cfg.server).host}`);
      else say('info', `${label}: configured manually, check its MCP settings`);
    }
    if ((cfg.clients ?? []).includes('claude')) {
      const settings = join(cfg.repo_root, '.claude', 'settings.local.json');
      const hooked = existsSync(settings) && /\.hive[\\/]+(hook\.mjs|config\.json)/.test(readFileSync(settings, 'utf8'));
      if (hooked) say('ok', 'Claude Code activity hooks installed');
      else say('warn', 'Claude Code hooks missing (no live drones / edit flags)', 'alveare join --rehost <host>');
    }
  }

  console.log('\nNetwork');
  const { lanAddresses, discover } = await import('./server/discovery.js');
  const ips = lanAddresses();
  if (ips.length) say('ok', `this laptop: ${ips.join(', ')}`);
  else say('fail', 'no network connection found', 'connect to the same Wi-Fi as the host');
  if (process.platform === 'win32') {
    for (const p of windowsNetworkCategories()) {
      if (/=Public$/i.test(p)) say('warn', `network "${p.split('=')[0]}" is Public; Windows blocks incoming connections`, 'if you host: Settings › Network › Wi-Fi › this network › Private');
      else say('ok', `network "${p.split('=')[0]}" is ${p.split('=')[1]}`);
    }
  }
  const found = await discover(2500);
  if (found.length) say('ok', `mDNS sees: ${found.map((f) => `"${f.session}" at ${f.address}:${f.port}`).join(', ')}`);
  else say('info', 'mDNS sees no hive (normal if the venue Wi-Fi blocks discovery; use the address instead)');

  console.log(problems ? `\n${problems} thing(s) to fix above.` : '\nAll good. Buzz on. 🐝');
}
