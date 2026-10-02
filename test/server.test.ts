import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server/index.ts';

const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('host handover: export → import on a new server keeps tasks, claims, messages and tokens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-srv-'));
  try {
    const a = await startServer({ dbFile: join(dir, 'a.db'), port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${a.port}`;
    const code = a.hive.joinCode();
    const lead = await (await post(`${base}/api/join`, { code, name: 'lead' })).json() as { token: string; role: string };
    const mem = await (await post(`${base}/api/join`, { code, name: 'mem' })).json() as { token: string };
    assert.equal(lead.role, 'leader');
    const leadId = a.hive.authenticate(lead.token)!.id;
    const memId = a.hive.authenticate(mem.token)!.id;
    const t = a.hive.createTask(leadId, { title: 'T', files: ['src/x.ts'] });
    a.hive.claimTask(memId, t.id);
    a.hive.sendMessage(memId, 'leader', 'hello');

    // hook endpoint: auth required, whitelisted fields only
    assert.equal((await post(`${base}/api/hook`, { hook_event_name: 'Stop' })).status, 401);
    const hr = await post(`${base}/api/hook`, { hook_event_name: 'PostToolUse', tool_name: 'Edit', file_path: 'src/y.ts', session_id: 's', tool_result: 'SECRET' }, { authorization: `Bearer ${mem.token}` });
    assert.equal(hr.status, 200);
    const ev = a.hive.db.prepare("SELECT * FROM events WHERE kind = 'edit'").get() as { path: string; flag: string; data: string };
    assert.deepEqual([ev.path, ev.flag], ['src/y.ts', 'unclaimed']);
    assert.ok(!JSON.stringify(ev).includes('SECRET'));

    // export requires auth; a member token works
    assert.equal((await fetch(`${base}/api/export`)).status, 401);
    const exp = await fetch(`${base}/api/export`, { headers: { authorization: `Bearer ${mem.token}` } });
    assert.equal(exp.status, 200);
    const file = join(dir, 'snap.hive');
    writeFileSync(file, Buffer.from(await exp.arrayBuffer()));
    await a.close();

    const b = await startServer({ dbFile: file, port: 0, host: '127.0.0.1' });
    try {
      assert.equal(b.hive.authenticate(lead.token)?.name, 'lead', 'old tokens still valid');
      assert.equal(b.hive.leaderStatus().leader, 'lead');
      assert.equal(b.hive.task(t.id).status, 'in_progress');
      assert.equal(b.hive.claimsOf(memId)[0]?.pattern, 'src/x.ts');
      assert.ok(b.hive.readMessages(leadId).some((m) => m.body === 'hello'));
      assert.equal(b.hive.joinCode(), code, 'join code carried over');
      const info = await (await fetch(`http://127.0.0.1:${b.port}/api/info`)).json() as { session: string; leader: string };
      assert.equal(info.leader, 'lead');
    } finally {
      await b.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('join and dashboard login: wrong codes are rate limited; static files and traversal', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hive-srv-'));
  const s = await startServer({ dbFile: join(dir, 'c.db'), port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${s.port}`;
  try {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/join.mjs`)).status, 200);
    assert.equal((await fetch(`${base}/hook.mjs`)).status, 200);
    assert.match(await (await fetch(`${base}/snippet.md`)).text(), /hive:start/);
    assert.equal((await fetch(`${base}/api/state`)).status, 401);
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await post(`${base}/api/login`, { code: 'NOPE00' })).status);
    assert.deepEqual(statuses, [403, 403, 403, 403, 403, 429]);
    assert.equal((await post(`${base}/api/join`, { code: s.hive.joinCode(), name: 'x' })).status, 429, 'limit shared with join');
  } finally {
    await s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
