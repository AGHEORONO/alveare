// mDNS / Bonjour: the host advertises _hive._tcp; `hive join` browses for it.
// Hackathon Wi-Fi often isolates clients, so callers always offer a manual address fallback.
import { networkInterfaces } from 'node:os';
import Bonjour from 'bonjour-service';
import { VERSION } from './mcp.js';

const TYPE = 'hive';

export interface Found { name: string; session: string; address: string; port: number }

export function advertise(port: number, session: string): () => Promise<void> {
  const bonjour = new Bonjour.Bonjour();
  bonjour.publish({ name: `Hive ${session} ${port}`, type: TYPE, port, txt: { session, v: VERSION } });
  return () => new Promise((resolve) => bonjour.unpublishAll(() => { bonjour.destroy(); resolve(); }));
}

export function discover(timeoutMs = 3000): Promise<Found[]> {
  return new Promise((resolve) => {
    const bonjour = new Bonjour.Bonjour();
    const found = new Map<string, Found>();
    const browser = bonjour.find({ type: TYPE }, (svc) => {
      const ipv4 = (svc.addresses ?? []).find((a) => /^\d+\.\d+\.\d+\.\d+$/.test(a)) ?? svc.referer?.address ?? svc.host;
      const f = { name: svc.name, session: String(svc.txt?.session ?? svc.name), address: ipv4, port: svc.port };
      found.set(`${f.address}:${f.port}`, f);
    });
    setTimeout(() => { browser.stop(); bonjour.destroy(); resolve([...found.values()]); }, timeoutMs);
  });
}

/** Non-internal IPv4 addresses, most likely LAN first. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : ip.startsWith('100.') ? 3 : 4);
  return out.sort((a, b) => rank(a) - rank(b));
}
