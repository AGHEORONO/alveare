import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/core/db.ts';
import { Hive } from '../src/core/hive.ts';
import { HiveError, type ErrorCode } from '../src/core/errors.ts';

const MIN = 60_000;

function setup() {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => { t += ms; } };
  const hive = new Hive(openDb(':memory:'), { now: clock.now, claimTtlMs: 10 * MIN });
  const ana = hive.registerAgent('ana', { isHost: true }).agent.id; // first agent = leader
  const ben = hive.registerAgent('ben').agent.id;
  const cat = hive.registerAgent('cat').agent.id;
  return { hive, clock, ana, ben, cat };
}

function throwsCode(fn: () => unknown, code: ErrorCode): HiveError {
  try { fn(); } catch (e) {
    assert.ok(e instanceof HiveError, `expected HiveError, got ${e}`);
    assert.equal(e.code, code, e.message);
    return e;
  }
  assert.fail(`expected ${code} error`);
}

describe('agents and auth', () => {
  test('first agent is leader; token authenticates; rejoin rotates token', () => {
    const { hive, ana } = setup();
    assert.equal(hive.leaderId(), ana);
    const { token } = hive.registerAgent('dan');
    assert.equal(hive.authenticate(token)?.name, 'dan');
    const again = hive.registerAgent('DAN');
    assert.equal(again.agent.name, 'dan', 'names are case-insensitive');
    assert.equal(hive.authenticate(token), null, 'old token revoked');
    assert.equal(hive.authenticate(again.token)?.name, 'dan');
  });

  test('join code is 6 chars without ambiguous characters and case-insensitive', () => {
    const { hive } = setup();
    const code = hive.joinCode();
    assert.match(code, /^[2-9A-HJ-NP-Z]{6}$/);
    assert.ok(hive.checkJoinCode(code.toLowerCase()));
    assert.ok(!hive.checkJoinCode('XXXXXX') || code === 'XXXXXX');
  });

  test('rejects invalid names', () => {
    const { hive } = setup();
    throwsCode(() => hive.registerAgent(''), 'invalid');
    throwsCode(() => hive.registerAgent('a'.repeat(40)), 'invalid');
  });
});

describe('leader-only permissions', () => {
  test('members cannot use leader tools; leader and humans can', () => {
    const { hive, ana, ben } = setup();
    const e = throwsCode(() => hive.createTask(ben, { title: 'x' }), 'leader_only');
    assert.equal(e.details.leader, 'ana');
    throwsCode(() => hive.planFeature(ben, 'f', []), 'leader_only');
    throwsCode(() => hive.postStatus(ben, 's'), 'leader_only');
    throwsCode(() => hive.forceRelease(ben, ['a']), 'leader_only');
    throwsCode(() => hive.transferLeadership(ben, 'ben'), 'leader_only');
    const t = hive.createTask(ana, { title: 'x' });
    throwsCode(() => hive.assignTask(ben, t.id, 'ben'), 'leader_only');
    throwsCode(() => hive.reviewTask(ben, t.id, 'approve'), 'leader_only');
    hive.createTask(null, { title: 'human-made' });
  });
});

describe('leadership transfer', () => {
  test('transfer moves powers and notifies both', () => {
    const { hive, ana, ben } = setup();
    assert.deepEqual(hive.transferLeadership(ana, 'ben'), { from: 'ana', to: 'ben' });
    assert.equal(hive.leaderId(), ben);
    throwsCode(() => hive.createTask(ana, { title: 'x' }), 'leader_only');
    hive.createTask(ben, { title: 'x' });
    assert.match(hive.readMessages(ben).at(-1)!.body, /now the Hive leader/);
    assert.match(hive.readMessages(ana).at(-1)!.body, /transferred to ben/);
  });

  test('"leader" messages go to whoever leads at read time', () => {
    const { hive, ana, ben, cat } = setup();
    hive.sendMessage(cat, 'leader', 'question?');
    hive.transferLeadership(null, 'ben');
    assert.ok(hive.readMessages(ben).some((m) => m.body === 'question?'));
    assert.ok(!hive.readMessages(ana).some((m) => m.body === 'question?'));
  });

  test('dashboard proposes a new leader when the leader is offline too long', () => {
    const { hive, clock, ben, cat } = setup();
    assert.equal(hive.leaderStatus().propose, null);
    clock.advance(6 * MIN);
    hive.touch(cat);
    clock.advance(1000);
    hive.touch(ben);
    const s = hive.leaderStatus();
    assert.equal(s.online, false);
    assert.equal(s.propose, 'ben', 'most recently active online member');
  });
});

describe('file claims', () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => { ctx = setup(); });

  test('conflict says who holds what; claims are all-or-nothing', () => {
    const { hive, ben, cat } = ctx;
    hive.claimFiles(ben, ['src/api/']);
    const e = throwsCode(() => hive.claimFiles(cat, ['src/ui/a.ts', 'src/api/users.ts']), 'conflict');
    const held = e.details.held as { path: string; held: string; by: string }[];
    assert.deepEqual(held.map((h) => [h.path, h.held, h.by]), [['src/api/users.ts', 'src/api/**', 'ben']]);
    assert.match(e.hint!, /ben/);
    assert.deepEqual(hive.claimsOf(cat), [], 'nothing claimed on conflict');
    hive.claimFiles(cat, ['src/ui/a.ts']);
  });

  test('glob vs glob conflicts, case and slash insensitive', () => {
    const { hive, ben, cat } = ctx;
    hive.claimFiles(ben, ['src\\API\\*.ts']);
    throwsCode(() => hive.claimFiles(cat, ['src/**']), 'conflict');
    throwsCode(() => hive.claimFiles(cat, ['./src/api/x.ts']), 'conflict');
  });

  test('reclaiming own files renews instead of conflicting', () => {
    const { hive, ben } = ctx;
    hive.claimFiles(ben, ['a.ts']);
    hive.claimFiles(ben, ['a.ts']);
    assert.equal(hive.claimsOf(ben).length, 1);
  });

  test('claims expire after TTL without activity', () => {
    const { hive, clock, ben, cat } = ctx;
    hive.claimFiles(ben, ['a.ts']);
    clock.advance(9 * MIN);
    throwsCode(() => hive.claimFiles(cat, ['a.ts']), 'conflict');
    clock.advance(2 * MIN);
    hive.claimFiles(cat, ['a.ts']);
    assert.equal(hive.checkFiles(null, ['a.ts'])[0].by, 'cat');
  });

  test('activity (touch/heartbeat) renews claims', () => {
    const { hive, clock, ben, cat } = ctx;
    hive.claimFiles(ben, ['a.ts']);
    for (let i = 0; i < 5; i++) { clock.advance(8 * MIN); hive.touch(ben); }
    throwsCode(() => hive.claimFiles(cat, ['a.ts']), 'conflict');
  });

  test('expired claims cannot be revived by touch', () => {
    const { hive, clock, ben } = ctx;
    hive.claimFiles(ben, ['a.ts']);
    clock.advance(11 * MIN);
    hive.touch(ben);
    assert.deepEqual(hive.claimsOf(ben), []);
    assert.equal(hive.pruneExpiredClaims(), 1);
  });

  test('release, check, coversPath, force_release', () => {
    const { hive, ana, ben, cat } = ctx;
    hive.claimFiles(ben, ['src/api/**', 'b.ts']);
    assert.deepEqual(hive.checkFiles(cat, ['src/api/x.ts', 'c.ts']).map((c) => c.status), ['held', 'free']);
    assert.equal(hive.checkFiles(ben, ['b.ts'])[0].status, 'mine');
    assert.ok(hive.coversPath(ben, 'SRC/api/x.ts'));
    assert.ok(!hive.coversPath(ben, 'c.ts'));
    assert.deepEqual(hive.releaseFiles(ben, ['b.ts']).released, ['b.ts']);
    assert.equal(hive.forceRelease(ana, ['src/api/x.ts']).released[0].from, 'ben');
    assert.deepEqual(hive.claimsOf(ben), []);
    assert.match(hive.readMessages(ben).at(-1)!.body, /force-released/);
  });
});

describe('tasks', () => {
  test('claim_task claims files, sets branch, blocks overlap with a hint', () => {
    const { hive, ana, ben, cat } = setup();
    const t1 = hive.createTask(ana, { title: 'Users API', files: ['src/api/users.ts'] });
    const t2 = hive.createTask(ana, { title: 'API tests', files: ['src/api/**'] });
    const t3 = hive.createTask(ana, { title: 'UI', files: ['src/ui/**'] });
    assert.equal(t1.branch, `task/${t1.id}-users-api`);
    assert.deepEqual(hive.claimTask(ben, t1.id).claimed, ['src/api/users.ts']);
    const e = throwsCode(() => hive.claimTask(cat, t2.id), 'conflict');
    assert.match(e.hint!, new RegExp(`free ready tasks: ${t3.id}`));
    throwsCode(() => hive.claimTask(cat, t1.id), 'bad_state');
    assert.equal(hive.task(t2.id).status, 'open', 'failed claim leaves task untouched');
  });

  test('dependencies must be done before claiming', () => {
    const { hive, ana, ben, cat } = setup();
    const a = hive.createTask(ana, { title: 'A' });
    const b = hive.createTask(ana, { title: 'B', depends_on: [a.id] });
    const e = throwsCode(() => hive.claimTask(cat, b.id), 'deps_unmet');
    assert.deepEqual(e.details.waiting_on, [a.id]);
    assert.deepEqual(hive.tasks({ ready: true }).map((t) => t.id), [a.id]);
    hive.claimTask(ben, a.id);
    hive.updateTask(ben, a.id, 'review');
    hive.reviewTask(ana, a.id, 'approve');
    hive.claimTask(cat, b.id);
  });

  test('full lifecycle: assign → claim → review → changes → review → done', () => {
    const { hive, ana, ben, cat } = setup();
    const t = hive.createTask(ana, { title: 'T', files: ['t.ts'] });
    hive.assignTask(ana, t.id, 'ben');
    assert.equal(hive.task(t.id).status, 'assigned');
    throwsCode(() => hive.claimTask(cat, t.id), 'forbidden');
    hive.claimTask(ben, t.id);
    throwsCode(() => hive.updateTask(cat, t.id, 'review'), 'forbidden');
    throwsCode(() => hive.updateTask(ben, t.id, 'done'), 'leader_only');
    hive.updateTask(ben, t.id, 'review');
    assert.deepEqual(hive.claimsOf(ben), [], 'review releases task claims');
    assert.ok(hive.readMessages(ana).some((m) => /ready for review/.test(m.body)));
    hive.reviewTask(ana, t.id, 'changes_requested', 'add tests');
    assert.equal(hive.task(t.id).status, 'in_progress');
    assert.equal(hive.claimsOf(ben)[0]?.pattern, 't.ts', 'files re-claimed on changes_requested');
    assert.ok(hive.readMessages(ben).some((m) => /add tests/.test(m.body)));
    hive.updateTask(ben, t.id, 'review');
    hive.reviewTask(ana, t.id, 'approve');
    assert.equal(hive.task(t.id).status, 'done');
    throwsCode(() => hive.reviewTask(ana, t.id, 'approve'), 'bad_state');
  });

  test('deps_unmet explains each dependency; claiming your own blocked task resumes it', () => {
    const { hive, ana, ben, cat } = setup();
    const a = hive.createTask(ana, { title: 'API' });
    const b = hive.createTask(ana, { title: 'UI', depends_on: [a.id] });
    hive.assignTask(ana, b.id, 'cat');
    hive.claimTask(ben, a.id);
    let e = throwsCode(() => hive.claimTask(cat, b.id), 'deps_unmet');
    assert.match(e.hint!, /being built by ben/);
    hive.updateTask(ben, a.id, 'review');
    e = throwsCode(() => hive.claimTask(cat, b.id), 'deps_unmet');
    assert.match(e.hint!, new RegExp(`waiting for the queen's review.*origin/task/${a.id}-api`));
    assert.deepEqual((e.details.deps as { status: string }[]).map((d) => d.status), ['review']);
    hive.updateTask(cat, b.id, 'blocked', 'waiting on API');
    hive.reviewTask(ana, a.id, 'approve');
    assert.equal(hive.claimTask(cat, b.id).task.status, 'in_progress', 'one call resumes the blocked task');
    assert.equal(hive.task(b.id).blocked_from, null);
  });

  test('blocked requires a note and unblocks to the previous status', () => {
    const { hive, ana, ben } = setup();
    const t = hive.createTask(ana, { title: 'T' });
    hive.claimTask(ben, t.id);
    throwsCode(() => hive.updateTask(ben, t.id, 'blocked'), 'invalid');
    hive.updateTask(ben, t.id, 'blocked', 'need API key');
    assert.ok(hive.readMessages(ana).some((m) => /need API key/.test(m.body)));
    hive.updateTask(ben, t.id, 'in_progress');
    assert.equal(hive.task(t.id).status, 'in_progress');
  });

  test('reassign moves task claims to the new owner', () => {
    const { hive, ana, ben, cat } = setup();
    const t = hive.createTask(ana, { title: 'T', files: ['t.ts'] });
    hive.claimTask(ben, t.id);
    assert.deepEqual(hive.reassignTask(ana, t.id, 'cat', 'ben is offline'), { id: t.id, from: 'ben', owner: 'cat' });
    assert.equal(hive.claimsOf(cat)[0].pattern, 't.ts');
    assert.deepEqual(hive.claimsOf(ben), []);
    hive.updateTask(cat, t.id, 'review');
  });

  test('assign_task refuses started tasks and unknown agents', () => {
    const { hive, ana, ben } = setup();
    const t = hive.createTask(ana, { title: 'T' });
    throwsCode(() => hive.assignTask(ana, t.id, 'nobody'), 'not_found');
    hive.claimTask(ben, t.id);
    throwsCode(() => hive.assignTask(ana, t.id, 'ben'), 'bad_state');
    throwsCode(() => hive.reassignTask(ana, t.id, 'ben'), 'bad_state');
  });

  test('paths keep their case but compare case-insensitively', () => {
    const { hive, ana, ben, cat } = setup();
    const t = hive.createTask(ana, { title: 'T', files: ['README.md', 'readme.md'] });
    assert.deepEqual(hive.taskFiles(t.id), ['README.md']);
    hive.claimTask(ben, t.id);
    assert.equal(hive.claimsOf(ben)[0].pattern, 'README.md');
    throwsCode(() => hive.claimFiles(cat, ['readme.MD']), 'conflict');
    assert.deepEqual(hive.releaseFiles(ben, ['readme.md']).released, ['readme.md']);
    assert.deepEqual(hive.claimsOf(ben), []);
  });
});

describe('plan_feature', () => {
  test('creates tasks atomically with key deps, assignees and overlap warnings', () => {
    const { hive, ana } = setup();
    const r = hive.planFeature(ana, 'auth', [
      { key: 'ui', title: 'Login UI', files: ['src/ui/login.tsx'], depends_on: ['api'], assignee: 'cat' },
      { key: 'api', title: 'Auth API', files: ['src/api/**'], assignee: 'ben' },
      { key: 'tests', title: 'Auth tests', files: ['src/api/auth.test.ts'], depends_on: ['api'] },
    ]);
    const id = Object.fromEntries(r.tasks.map((t) => [t.key, t.id]));
    assert.deepEqual(hive.taskDeps(id.ui).map((d) => d.id), [id.api]);
    assert.equal(hive.task(id.api).status, 'assigned');
    assert.equal(r.tasks.find((t) => t.key === 'ui')!.assignee, 'cat');
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /api & tests|tests & api/);
  });

  test('rejects cycles and unknown keys without creating anything', () => {
    const { hive, ana } = setup();
    throwsCode(() => hive.planFeature(ana, 'f', [
      { key: 'a', title: 'A', depends_on: ['b'] },
      { key: 'b', title: 'B', depends_on: ['a'] },
    ]), 'invalid');
    throwsCode(() => hive.planFeature(ana, 'f', [{ key: 'a', title: 'A', depends_on: ['zzz'] }]), 'invalid');
    throwsCode(() => hive.planFeature(ana, 'f', [
      { key: 'a', title: 'A' },
      { key: 'b', title: 'B', assignee: 'nobody' },
    ]), 'not_found');
    assert.equal(hive.tasks().length, 0, 'transaction rolled back');
  });
});

describe('messages and subagents', () => {
  test('direct, broadcast, unread cursor, since', () => {
    const { hive, ana, ben, cat } = setup();
    hive.sendMessage(ben, 'cat', 'hi cat');
    hive.sendMessage(ana, 'all', 'standup');
    hive.postStatus(ana, '2/5 done');
    assert.equal(hive.unreadCount(cat), 3);
    assert.deepEqual(hive.readMessages(cat).map((m) => m.body), ['hi cat', 'standup', '[status] 2/5 done']);
    assert.equal(hive.unreadCount(cat), 0);
    assert.deepEqual(hive.readMessages(cat), []);
    assert.equal(hive.readMessages(cat, 0).length, 3, 'since re-reads history');
    assert.deepEqual(hive.readMessages(ben).map((m) => m.body), ['standup', '[status] 2/5 done'], 'own messages excluded');
    throwsCode(() => hive.sendMessage(ben, 'nobody', 'x'), 'not_found');
  });

  test('report_subagent opens and closes rows', () => {
    const { hive, ben } = setup();
    const a = hive.reportSubagent(ben, 'explorer', 'find routes', 'running');
    assert.equal(hive.reportSubagent(ben, 'explorer', 'find routes', 'running').id, a.id);
    assert.equal(hive.reportSubagent(ben, 'explorer', '', 'done').id, a.id);
    const row = hive.db.prepare('SELECT * FROM subagents WHERE id = ?').get(a.id) as { status: string; ended_at: number };
    assert.equal(row.status, 'done');
    assert.ok(row.ended_at);
  });
});

describe('stale work and merge queue', () => {
  test('tasks whose owner went silent past the claim TTL are stale until they come back', () => {
    const { hive, clock, ana, ben } = setup();
    const t = hive.createTask(ana, { title: 'T', files: ['t.ts'] });
    hive.claimTask(ben, t.id);
    clock.advance(9 * MIN);
    assert.deepEqual(hive.staleTasks(), []);
    clock.advance(2 * MIN);
    assert.deepEqual(hive.staleTasks().map((s) => [s.id, s.owner]), [[t.id, 'ben']]);
    hive.touch(ben);
    assert.deepEqual(hive.staleTasks(), []);
  });

  test('approved tasks wait in the merge queue until a human marks them merged', () => {
    const { hive, ana, ben } = setup();
    const t = hive.createTask(ana, { title: 'T' });
    throwsCode(() => hive.markMerged(t.id), 'bad_state');
    hive.claimTask(ben, t.id);
    hive.updateTask(ben, t.id, 'review');
    assert.deepEqual(hive.mergeQueue(), []);
    hive.reviewTask(ana, t.id, 'approve');
    assert.deepEqual(hive.mergeQueue().map((x) => x.branch), [`task/${t.id}-t`]);
    hive.markMerged(t.id);
    assert.deepEqual(hive.mergeQueue(), []);
    hive.markMerged(t.id, false);
    assert.equal(hive.mergeQueue().length, 1, 'can be undone');
  });
});

describe('independent queen toggle', () => {
  function queensTaskInReview() {
    const ctx = setup();
    const t = ctx.hive.createTask(ctx.ana, { title: 'Queen work' });
    ctx.hive.claimTask(ctx.ana, t.id);
    ctx.hive.updateTask(ctx.ana, t.id, 'review');
    return { ...ctx, id: t.id };
  }

  test('on (default): the queen approves her own task; workers still cannot review', () => {
    const { hive, ana, ben, id } = queensTaskInReview();
    assert.equal(hive.independentQueen(), true);
    throwsCode(() => hive.reviewTask(ben, id, 'approve'), 'leader_only');
    assert.equal(hive.reviewTask(ana, id, 'approve').task.status, 'done');
  });

  test('off: the queen is told who can review; another bee or a human reviews instead', () => {
    const { hive, ana, ben, id } = queensTaskInReview();
    hive.setIndependentQueen(false);
    const e = throwsCode(() => hive.reviewTask(ana, id, 'approve'), 'forbidden');
    assert.ok((e.details.reviewers as string[]).includes('ben'));
    assert.match(e.hint!, /review_task/);
    assert.equal(hive.reviewTask(ben, id, 'changes_requested', 'add tests').task.status, 'in_progress');
    hive.updateTask(ana, id, 'review');
    assert.equal(hive.reviewTask(null, id, 'approve').task.status, 'done', 'humans can always review');
  });

  test('off: sending the queen\'s task to review asks the other bees, not the queen herself', () => {
    const { hive, ana, ben } = setup();
    hive.setIndependentQueen(false);
    const t = hive.createTask(ana, { title: 'Q' });
    hive.claimTask(ana, t.id);
    hive.updateTask(ana, t.id, 'review');
    assert.ok(hive.readMessages(ben).some((m) => /needs a reviewer/.test(m.body)));
    assert.ok(!hive.readMessages(ana).some((m) => /ready for review/.test(m.body)));
  });

  test('off: workers still cannot review other workers\' tasks', () => {
    const { hive, ana, ben, cat } = setup();
    hive.setIndependentQueen(false);
    const t = hive.createTask(ana, { title: 'Worker work' });
    hive.claimTask(cat, t.id);
    hive.updateTask(cat, t.id, 'review');
    throwsCode(() => hive.reviewTask(ben, t.id, 'approve'), 'leader_only');
    assert.equal(hive.reviewTask(ana, t.id, 'approve').task.status, 'done');
  });
});
