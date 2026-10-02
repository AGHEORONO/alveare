import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.ts';
import { Hive } from '../src/core/hive.ts';
import { HookIngest } from '../src/core/hooks.ts';

function setup() {
  let t = 1_000_000;
  const hive = new Hive(openDb(':memory:'), { now: () => t });
  const ana = hive.registerAgent('ana').agent.id;
  const ben = hive.registerAgent('ben').agent.id;
  return { hive, hooks: new HookIngest(hive), ana, ben, advance: (ms: number) => { t += ms; } };
}

const subs = (hive: Hive) => hive.db.prepare('SELECT * FROM subagents ORDER BY started_at').all() as
  { id: string; agent_id: string; purpose: string; status: string; agent_type: string; ended_at: number | null }[];
const events = (hive: Hive, kind: string) => hive.db.prepare('SELECT * FROM events WHERE kind = ?').all(kind) as
  { path: string; flag: string | null; subagent_id: string | null; task_id: number | null }[];

test('session start/end tracks sessions and closes running subagents', () => {
  const { hive, hooks, ben } = setup();
  hooks.ingest(ben, { hook_event_name: 'SessionStart', session_id: 's1', source: 'startup', cwd: '/r' });
  hooks.ingest(ben, { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'sub1', agent_type: 'Explore' });
  hooks.ingest(ben, { hook_event_name: 'SessionEnd', session_id: 's1', reason: 'other' });
  const s = hive.db.prepare('SELECT * FROM sessions').get() as { agent_id: string; ended_at: number | null };
  assert.equal(s.agent_id, ben);
  assert.ok(s.ended_at);
  assert.equal(subs(hive)[0].status, 'done');
  assert.equal(hooks.activity.get(ben)?.state, 'idle');
});

test('subagent purpose comes from the preceding Agent tool call, matched by type', () => {
  const { hive, hooks, ben } = setup();
  hooks.ingest(ben, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', description: 'map routes', subagent_type: 'Explore' });
  hooks.ingest(ben, { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Agent', description: 'write tests', subagent_type: 'general-purpose' });
  hooks.ingest(ben, { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'b', agent_type: 'general-purpose' });
  hooks.ingest(ben, { hook_event_name: 'SubagentStart', session_id: 's1', agent_id: 'a', agent_type: 'Explore' });
  const byId = Object.fromEntries(subs(hive).map((s) => [s.id, s]));
  assert.equal(byId.a.purpose, 'map routes');
  assert.equal(byId.b.purpose, 'write tests');
  assert.equal(byId.a.agent_id, ben);
  hooks.ingest(ben, { hook_event_name: 'SubagentStop', session_id: 's1', agent_id: 'a', agent_type: 'Explore' });
  assert.equal(subs(hive).find((s) => s.id === 'a')!.status, 'done');
  assert.equal(subs(hive).find((s) => s.id === 'b')!.status, 'running');
});

test('edits are flagged when the file is not claimed, and attributed to subagents', () => {
  const { hive, hooks, ana, ben } = setup();
  const t = hive.createTask(ana, { title: 'T', files: ['src/api/'] });
  hive.claimTask(ben, t.id);
  assert.deepEqual(hooks.ingest(ben, { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Edit', file_path: 'src/api/a.ts' }), { flagged: false });
  assert.deepEqual(hooks.ingest(ben, { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Write', file_path: 'src/ui/b.ts', agent_id: 'sub9' }), { flagged: true });
  hooks.ingest(ben, { hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', file_path: 'src/ui/c.ts' }); // not an edit
  const ev = events(hive, 'edit');
  assert.equal(ev.length, 2);
  assert.deepEqual(ev.map((e) => [e.path, e.flag, e.task_id]), [['src/api/a.ts', null, t.id], ['src/ui/b.ts', 'unclaimed', t.id]]);
  assert.equal(ev[1].subagent_id, 'sub9');
});

test('hook activity counts as a heartbeat (keeps claims alive)', () => {
  const { hive, hooks, ben, advance } = setup();
  hive.claimFiles(ben, ['a.ts']);
  for (let i = 0; i < 4; i++) { advance(8 * 60_000); hooks.ingest(ben, { hook_event_name: 'Stop', session_id: 's' }); }
  assert.equal(hive.claimsOf(ben).length, 1);
  assert.equal(hooks.activity.get(ben)?.state, 'idle');
});
