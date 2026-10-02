// End-to-end simulation: one leader and three members, each a real MCP client over HTTP,
// racing for overlapping tasks. Verifies locking, permissions, transfer and claim expiry.
//   npm run sim
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server/index.ts';

const TTL = 2000;
let failures = 0;
const check = (cond: unknown, label: string) => {
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${label}`);
  if (!cond) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type R = { ok: boolean; [k: string]: any };

class Agent {
  client = new Client({ name: 'sim', version: '0' });
  constructor(public name: string, private token: string, private url: string) {}
  async connect() {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { Authorization: `Bearer ${this.token}` } },
    }));
    return this;
  }
  async call(tool: string, args: Record<string, unknown> = {}): Promise<R> {
    const res = await this.client.callTool({ name: tool, arguments: args });
    const text = (res.content as { text: string }[])[0].text;
    return JSON.parse(text);
  }
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'hive-sim-'));
  const srv = await startServer({ dbFile: join(dir, 'sim.db'), port: 0, host: '127.0.0.1', claimTtlMs: TTL, sessionName: 'sim' });
  const base = `http://127.0.0.1:${srv.port}`;
  const code = srv.hive.joinCode();
  console.log(`server on ${base}, join code ${code}\n`);

  const joinAs = async (name: string) => {
    const r = await fetch(`${base}/api/join`, { method: 'POST', body: JSON.stringify({ code, name }) }).then((r) => r.json()) as { token: string; mcp_url: string };
    return new Agent(name, r.token, r.mcp_url).connect();
  };

  try {
    console.log('joining');
    const bad = await fetch(`${base}/api/join`, { method: 'POST', body: JSON.stringify({ code: 'WRONG1', name: 'eve' }) });
    check(bad.status === 403, 'wrong join code rejected');
    const lead = await joinAs('lead');
    const [m1, m2, m3] = await Promise.all(['m1', 'm2', 'm3'].map(joinAs));
    check((await lead.call('whoami')).role === 'leader', 'first joiner (host) is leader');
    check((await m1.call('whoami')).role === 'member', 'others are members');
    const noAuth = await fetch(`${base}/mcp`, { method: 'POST', body: '{}' });
    check(noAuth.status === 401, 'MCP without token is rejected');

    console.log('\nplanning');
    const tmpl = await lead.call('plan_feature', { description: 'auth' });
    check(tmpl.ok && tmpl.template && tmpl.online.length === 4, 'plan_feature without tasks returns template + online agents');
    const plan = await lead.call('plan_feature', {
      description: 'user auth',
      tasks: [
        { key: 'api', title: 'Auth API', files: ['src/api/'] },
        { key: 'users', title: 'Users endpoint', files: ['src/api/users.ts'] },
        { key: 'ui', title: 'Login form', files: ['src/ui/login.tsx'] },
        { key: 'style', title: 'Login styles', files: ['src/ui/*.css'] },
        { key: 'docs', title: 'Auth docs', files: ['docs/auth.md'] },
        { key: 'e2e', title: 'E2E test', files: ['e2e/auth.spec.ts'], depends_on: ['api', 'ui'] },
      ],
    });
    check(plan.ok && plan.created.length === 6, 'plan_feature created 6 tasks');
    check(plan.warnings?.some((w: string) => w.includes('api & users')), 'overlap warning for api/users');
    const id = Object.fromEntries(plan.created.map((t: { key: string; id: number }) => [t.key, t.id]));
    const cyc = await lead.call('plan_feature', { description: 'x', tasks: [{ key: 'a', title: 'a', depends_on: ['b'] }, { key: 'b', title: 'b', depends_on: ['a'] }] });
    check(!cyc.ok && cyc.error === 'invalid', 'cyclic plan rejected');

    console.log('\npermissions');
    const deny = await m1.call('assign_task', { id: id.docs, agent: 'm1' });
    check(!deny.ok && deny.error === 'leader_only' && deny.leader === 'lead', `member assign_task rejected → ${JSON.stringify(deny)}`);
    check((await m2.call('create_task', { title: 'sneaky' })).error === 'leader_only', 'member create_task rejected');
    check((await m3.call('review_task', { id: id.api, verdict: 'approve' })).error === 'leader_only', 'member review_task rejected');
    check((await m1.call('update_task', { id: id.api, status: 'review' })).error === 'forbidden', 'cannot update a task you do not own');

    console.log('\nrace: 3 members claim the same task at once');
    const same = await Promise.all([m1, m2, m3].map((m) => m.call('claim_task', { id: id.docs })));
    const winners = same.filter((r) => r.ok);
    check(winners.length === 1, `exactly one winner (${winners.length})`);
    check(same.filter((r) => !r.ok).every((r) => r.error === 'bad_state' && /owner/.test(r.message)), 'losers told who owns it');

    console.log('\nrace: overlapping tasks (src/api/** vs src/api/users.ts)');
    const [a, b] = await Promise.all([m2.call('claim_task', { id: id.api }), m3.call('claim_task', { id: id.users })]);
    const docsWinner = [m1, m2, m3][same.findIndex((r) => r.ok)];
    check([a, b].filter((r) => r.ok).length === 1, 'exactly one of the overlapping tasks starts');
    const loser = a.ok ? b : a;
    check(loser.error === 'conflict' && loser.held?.[0]?.by && typeof loser.do === 'string', `conflict says who + what to do → ${JSON.stringify(loser)}`);

    console.log('\nfile claims');
    const apiOwner = a.ok ? m2 : m3;
    const other = a.ok ? m3 : m2;
    const cf = await other.call('claim_files', { paths: ['src/api/users.ts', 'README.md'] });
    check(!cf.ok && cf.error === 'conflict', 'claim_files on held path rejected');
    check((await other.call('check_files', { paths: ['README.md'] })).files[0].status === 'free', 'all-or-nothing: README.md stayed free');
    const ui = await other.call('claim_task', { id: id.ui });
    check(ui.ok && ui.branch.startsWith(`task/${id.ui}-`), `free task claimed with branch ${ui.branch}`);
    const e2e = await docsWinner.call('claim_task', { id: id.e2e });
    check(!e2e.ok && e2e.error === 'deps_unmet', 'dependent task blocked until deps are done');

    console.log('\nmessages + review');
    await other.call('send_message', { to: 'leader', body: 'Should login use cookies?', task_id: id.ui });
    const inbox = await lead.call('read_messages');
    check(inbox.messages.some((m: { body: string }) => m.body.includes('cookies')), 'leader received the question');
    await lead.call('send_message', { to: 'all', body: 'Use cookies.' });
    check((await m1.call('read_messages')).messages.some((m: { body: string }) => m.body === 'Use cookies.'), 'broadcast delivered');
    const rv = await other.call('update_task', { id: id.ui, status: 'review', note: 'done' });
    check(rv.ok && rv.status === 'review', 'member set review');
    check((await lead.call('review_task', { id: id.ui, verdict: 'approve' })).status === 'done', 'leader approved');

    console.log('\nleadership transfer');
    check((await lead.call('transfer_leadership', { to: 'm1' })).to === 'm1', 'leader transferred to m1');
    check((await lead.call('post_status', { summary: 'x' })).error === 'leader_only', 'old leader lost powers');
    check((await m1.call('post_status', { summary: '1/6 done' })).ok, 'new leader can post_status');
    check((await m1.call('whoami')).role === 'leader', 'whoami shows new role');

    console.log('\ncrash: apiOwner goes silent; claims expire after TTL');
    const early = await other.call('claim_files', { paths: ['src/api/users.ts'] });
    check(!early.ok, 'still held before TTL');
    for (let i = 0; i < 3; i++) { await sleep(TTL / 2); await other.call('heartbeat'); } // others stay alive
    const late = await other.call('claim_files', { paths: ['src/api/users.ts'] });
    check(late.ok, 'claim freed after the silent agent\'s TTL');
    void apiOwner;
  } finally {
    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
