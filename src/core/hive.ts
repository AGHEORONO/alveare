import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from './db.js';
import { HiveError } from './errors.js';
import { normalizePattern, overlaps, matches } from './glob.js';

/** Who performs an operation: an agent id, or `null` for a human acting from the dashboard. */
export type Actor = string | null;

export const TASK_STATUSES = ['open', 'assigned', 'in_progress', 'review', 'done', 'blocked'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface HiveOptions {
  now?: () => number;
  claimTtlMs?: number;
  onlineWindowMs?: number;
  leaderTimeoutMs?: number;
}

export interface AgentRow {
  id: string; name: string; token_hash: string; is_host: number;
  created_at: number; last_seen_at: number; last_read_msg_id: number;
}
export interface TaskRow {
  id: number; title: string; description: string; acceptance: string; status: TaskStatus;
  blocked_from: TaskStatus | null; owner_id: string | null; priority: number; branch: string | null;
  review_notes: string | null; created_by: string | null; created_at: number; updated_at: number;
  merged_at: number | null;
}
export interface ClaimRow {
  id: number; agent_id: string; pattern: string; task_id: number | null;
  created_at: number; expires_at: number;
}
export interface MessageRow {
  id: number; from_id: string | null; to_kind: 'agent' | 'leader' | 'all'; to_id: string | null;
  body: string; task_id: number | null; created_at: number;
}

export interface TaskInput {
  title: string;
  description?: string;
  acceptance?: string;
  files?: string[];
  depends_on?: number[];
  priority?: number;
}

export interface PlanTaskInput extends Omit<TaskInput, 'depends_on'> {
  key: string;
  depends_on?: string[];
  assignee?: string;
}

export interface ClaimConflict { path: string; held: string; by: string; task: number | null; expires_in_s: number }

const JOIN_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O/1/I

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'task';
}

export class Hive {
  readonly now: () => number;
  readonly claimTtlMs: number;
  readonly onlineWindowMs: number;
  readonly leaderTimeoutMs: number;
  /** Called after every state change; the server uses it to push dashboard updates. */
  onChange: (kind: string) => void = () => {};

  constructor(readonly db: DB, opts: HiveOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.claimTtlMs = opts.claimTtlMs ?? 10 * 60_000;
    this.onlineWindowMs = opts.onlineWindowMs ?? 90_000;
    this.leaderTimeoutMs = opts.leaderTimeoutMs ?? 5 * 60_000;
  }

  private tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ───────────────────────── meta ─────────────────────────

  getMeta(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setMeta(key: string, value: string | null): void {
    if (value === null) this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
    else this.db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  /** Returns the current join code, creating one if needed. */
  joinCode(): string {
    return this.getMeta('join_code') ?? this.rotateJoinCode();
  }

  rotateJoinCode(): string {
    const bytes = randomBytes(6);
    const code = Array.from(bytes, (b) => JOIN_ALPHABET[b % JOIN_ALPHABET.length]).join('');
    this.setMeta('join_code', code);
    return code;
  }

  checkJoinCode(code: string): boolean {
    return code.trim().toUpperCase() === this.joinCode();
  }

  // ───────────────────────── agents ─────────────────────────

  /**
   * Create an agent, or rotate the token of an existing agent with the same name (re-join).
   * The first agent ever created becomes leader.
   */
  registerAgent(name: string, opts: { isHost?: boolean } = {}): { agent: AgentRow; token: string } {
    const clean = name.trim();
    if (!/^[\w .-]{1,32}$/.test(clean)) throw new HiveError('invalid', 'name must be 1-32 chars: letters, digits, space, . _ -');
    const token = randomBytes(24).toString('base64url');
    return this.tx(() => {
      const now = this.now();
      const existing = this.agentByName(clean);
      let id: string;
      if (existing) {
        id = existing.id;
        this.db.prepare('UPDATE agents SET token_hash = ?, last_seen_at = ? WHERE id = ?').run(hashToken(token), now, id);
        if (opts.isHost) this.db.prepare('UPDATE agents SET is_host = 1 WHERE id = ?').run(id);
      } else {
        id = randomUUID();
        this.db.prepare('INSERT INTO agents(id, name, token_hash, is_host, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?, ?)')
          .run(id, clean, hashToken(token), opts.isHost ? 1 : 0, now, now);
        this.event('agent_joined', { agent_id: id });
      }
      if (!this.leaderId()) this.setMeta('leader_id', id);
      this.onChange('agents');
      return { agent: this.agent(id), token };
    });
  }

  authenticate(token: string): AgentRow | null {
    return (this.db.prepare('SELECT * FROM agents WHERE token_hash = ?').get(hashToken(token)) as AgentRow) ?? null;
  }

  agent(id: string): AgentRow {
    const a = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
    if (!a) throw new HiveError('not_found', `agent ${id} not found`);
    return a;
  }

  agentByName(name: string): AgentRow | null {
    return (this.db.prepare('SELECT * FROM agents WHERE name = ? COLLATE NOCASE').get(name.trim()) as AgentRow) ?? null;
  }

  /** Resolve a display name (or id) to an agent, with a helpful error. */
  resolveAgent(nameOrId: string): AgentRow {
    const a = this.agentByName(nameOrId) ?? (this.db.prepare('SELECT * FROM agents WHERE id = ?').get(nameOrId) as AgentRow | undefined);
    if (!a) {
      const names = this.agents().map((x) => x.name);
      throw new HiveError('not_found', `no agent named "${nameOrId}"`, { agents: names });
    }
    return a;
  }

  agents(): AgentRow[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY created_at').all() as AgentRow[];
  }

  isOnline(a: AgentRow): boolean {
    return this.now() - a.last_seen_at <= this.onlineWindowMs;
  }

  /** Record activity: marks the agent online and renews all of its claims. */
  touch(agentId: string): void {
    const now = this.now();
    this.db.prepare('UPDATE agents SET last_seen_at = ? WHERE id = ?').run(now, agentId);
    this.db.prepare('UPDATE claims SET expires_at = ? WHERE agent_id = ? AND expires_at > ?').run(now + this.claimTtlMs, agentId, now);
  }

  leaderId(): string | null {
    return this.getMeta('leader_id');
  }

  isLeader(actor: Actor): boolean {
    return actor !== null && actor === this.leaderId();
  }

  /** Humans (null actor) may do anything; agents must be the current leader. */
  requireLeader(actor: Actor, action: string): void {
    if (actor === null || this.isLeader(actor)) return;
    const leader = this.leaderId();
    throw new HiveError('leader_only', `${action} is leader-only`,
      { leader: leader ? this.agent(leader).name : null },
      'send_message to "leader" with your request');
  }

  transferLeadership(actor: Actor, to: string): { from: string | null; to: string } {
    this.requireLeader(actor, 'transfer_leadership');
    return this.tx(() => {
      const target = this.resolveAgent(to);
      const prev = this.leaderId();
      this.setMeta('leader_id', target.id);
      const prevName = prev ? this.agent(prev).name : null;
      this.insertMessage(null, 'agent', target.id,
        `You are now the Hive leader${prevName ? ` (from ${prevName})` : ''}. Run whoami, read_messages, list_tasks.`, null);
      if (prev && prev !== target.id) {
        this.insertMessage(null, 'agent', prev, `Leadership transferred to ${target.name}. You are now a member.`, null);
      }
      this.event('leader_changed', { agent_id: target.id, data: { from: prevName, by: actor === null ? 'human' : 'leader' } });
      this.onChange('agents');
      return { from: prevName, to: target.name };
    });
  }

  /** Leader health for the dashboard: whether a new leader should be proposed. */
  leaderStatus(): { leader: string | null; online: boolean; offline_for_s: number; propose: string | null } {
    const id = this.leaderId();
    const leader = id ? this.agent(id) : null;
    const now = this.now();
    const offlineFor = leader ? now - leader.last_seen_at : Infinity;
    let propose: string | null = null;
    if (offlineFor > this.leaderTimeoutMs) {
      const candidate = this.agents()
        .filter((a) => a.id !== id && this.isOnline(a))
        .sort((a, b) => b.last_seen_at - a.last_seen_at)[0];
      propose = candidate?.name ?? null;
    }
    return {
      leader: leader?.name ?? null,
      online: leader ? this.isOnline(leader) : false,
      offline_for_s: Number.isFinite(offlineFor) ? Math.round(offlineFor / 1000) : -1,
      propose,
    };
  }

  // ───────────────────────── tasks ─────────────────────────

  task(id: number): TaskRow {
    const t = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
    if (!t) throw new HiveError('not_found', `task ${id} not found`);
    return t;
  }

  taskFiles(id: number): string[] {
    return (this.db.prepare('SELECT pattern FROM task_files WHERE task_id = ? ORDER BY pattern').all(id) as { pattern: string }[]).map((r) => r.pattern);
  }

  taskDeps(id: number): { id: number; status: TaskStatus }[] {
    return this.db.prepare(
      'SELECT t.id, t.status FROM task_deps d JOIN tasks t ON t.id = d.depends_on_id WHERE d.task_id = ? ORDER BY t.id',
    ).all(id) as { id: number; status: TaskStatus }[];
  }

  unmetDeps(id: number): number[] {
    return this.taskDeps(id).filter((d) => d.status !== 'done').map((d) => d.id);
  }

  tasks(filter: { status?: TaskStatus; owner?: string; ready?: boolean } = {}): TaskRow[] {
    let rows = this.db.prepare('SELECT * FROM tasks ORDER BY priority, id').all() as TaskRow[];
    if (filter.status) rows = rows.filter((t) => t.status === filter.status);
    if (filter.owner) rows = rows.filter((t) => t.owner_id === filter.owner);
    if (filter.ready) rows = rows.filter((t) => t.status === 'open' && this.unmetDeps(t.id).length === 0);
    return rows;
  }

  createTask(actor: Actor, input: TaskInput): TaskRow {
    this.requireLeader(actor, 'create_task');
    return this.tx(() => this.insertTask(actor, input));
  }

  private insertTask(actor: Actor, input: TaskInput): TaskRow {
    if (!input.title?.trim()) throw new HiveError('invalid', 'title is required');
    const now = this.now();
    const priority = input.priority ?? 2;
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO tasks(title, description, acceptance, priority, created_by, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)',
    ).run(input.title.trim(), input.description ?? '', input.acceptance ?? '', priority, actor, now, now);
    const id = Number(lastInsertRowid);
    this.db.prepare('UPDATE tasks SET branch = ? WHERE id = ?').run(`task/${id}-${slugify(input.title)}`, id);
    for (const f of uniqueCi((input.files ?? []).map(normalizePattern))) {
      this.db.prepare('INSERT INTO task_files(task_id, pattern) VALUES(?, ?)').run(id, f);
    }
    for (const dep of new Set(input.depends_on ?? [])) {
      this.task(dep); // throws not_found
      this.db.prepare('INSERT INTO task_deps(task_id, depends_on_id) VALUES(?, ?)').run(id, dep);
    }
    this.event('task_created', { agent_id: actor, task_id: id });
    this.onChange('tasks');
    return this.task(id);
  }

  /**
   * Create a whole feature breakdown atomically. Tasks reference each other by `key`.
   * Rejects dependency cycles; returns warnings for file overlap between tasks.
   */
  planFeature(actor: Actor, description: string, tasks: PlanTaskInput[]): {
    tasks: { key: string; id: number; assignee: string | null }[]; warnings: string[];
  } {
    this.requireLeader(actor, 'plan_feature');
    const keys = new Set<string>();
    for (const t of tasks) {
      if (keys.has(t.key)) throw new HiveError('invalid', `duplicate task key "${t.key}"`);
      keys.add(t.key);
    }
    for (const t of tasks) {
      for (const d of t.depends_on ?? []) {
        if (!keys.has(d)) throw new HiveError('invalid', `task "${t.key}" depends on unknown key "${d}"`);
      }
    }
    const order = topoSort(tasks);
    const warnings: string[] = [];
    for (let i = 0; i < tasks.length; i++) {
      for (let j = i + 1; j < tasks.length; j++) {
        const shared = overlapList((tasks[i].files ?? []).map(normalizePattern), (tasks[j].files ?? []).map(normalizePattern));
        if (shared.length) warnings.push(`files overlap: ${tasks[i].key} & ${tasks[j].key} (${shared.join(', ')})`);
      }
    }
    return this.tx(() => {
      const ids = new Map<string, number>();
      const out: { key: string; id: number; assignee: string | null }[] = [];
      for (const t of order) {
        const row = this.insertTask(actor, {
          ...t,
          description: t.description ?? '',
          depends_on: (t.depends_on ?? []).map((k) => ids.get(k)!),
        });
        ids.set(t.key, row.id);
        let assignee: string | null = null;
        if (t.assignee) assignee = this.assignTaskInner(actor, row.id, t.assignee).owner;
        out.push({ key: t.key, id: row.id, assignee });
      }
      this.event('feature_planned', { agent_id: actor, data: { description, tasks: out.length } });
      return { tasks: out, warnings };
    });
  }

  assignTask(actor: Actor, id: number, agentName: string): { id: number; owner: string } {
    this.requireLeader(actor, 'assign_task');
    return this.tx(() => this.assignTaskInner(actor, id, agentName));
  }

  private assignTaskInner(actor: Actor, id: number, agentName: string): { id: number; owner: string } {
    const t = this.task(id);
    if (t.status !== 'open' && t.status !== 'assigned') {
      throw new HiveError('bad_state', `task ${id} is ${t.status}`, { status: t.status }, 'use reassign_task for started tasks');
    }
    const target = this.resolveAgent(agentName);
    this.setTask(id, { status: 'assigned', owner_id: target.id });
    this.insertMessage(actor, 'agent', target.id, `Assigned to you: task #${id} "${t.title}". claim_task(${id}) to start.`, id);
    this.event('task_assigned', { agent_id: target.id, task_id: id });
    return { id, owner: target.name };
  }

  reassignTask(actor: Actor, id: number, agentName: string, note?: string): { id: number; from: string | null; owner: string } {
    this.requireLeader(actor, 'reassign_task');
    return this.tx(() => {
      const t = this.task(id);
      if (t.status === 'done') throw new HiveError('bad_state', `task ${id} is done`);
      const target = this.resolveAgent(agentName);
      if (t.owner_id === target.id) throw new HiveError('bad_state', `task ${id} is already owned by ${target.name}`);
      const from = t.owner_id ? this.agent(t.owner_id).name : null;
      const status: TaskStatus = t.status === 'open' ? 'assigned' : t.status;
      this.setTask(id, { status, owner_id: target.id });
      const now = this.now();
      this.db.prepare('UPDATE claims SET agent_id = ?, expires_at = ? WHERE task_id = ? AND expires_at > ?')
        .run(target.id, now + this.claimTtlMs, id, now);
      this.insertMessage(actor, 'agent', target.id,
        `Reassigned to you: task #${id} "${t.title}" (${status}, branch ${t.branch})${note ? `. Note: ${note}` : ''}`, id);
      if (t.owner_id && t.owner_id !== target.id) {
        this.insertMessage(actor, 'agent', t.owner_id, `Task #${id} was reassigned to ${target.name}. Stop working on it.${note ? ` Note: ${note}` : ''}`, id);
      }
      this.event('task_reassigned', { agent_id: target.id, task_id: id, data: { from } });
      return { id, from, owner: target.name };
    });
  }

  /** Start a task: must be open (or assigned to me), dependencies done, and its files free. */
  claimTask(agentId: string, id: number): { task: TaskRow; claimed: string[] } {
    return this.tx(() => {
      this.touch(agentId);
      const t = this.task(id);
      if (t.status === 'in_progress' && t.owner_id === agentId) return { task: t, claimed: this.taskFiles(id) };
      if (t.status === 'assigned' && t.owner_id !== agentId) {
        throw new HiveError('forbidden', `task ${id} is assigned to ${this.agent(t.owner_id!).name}`, {},
          this.hintForReadyTasks(agentId));
      }
      if (t.status !== 'open' && t.status !== 'assigned') {
        const owner = t.owner_id ? this.agent(t.owner_id).name : null;
        throw new HiveError('bad_state', `task ${id} is ${t.status}${owner ? ` (owner ${owner})` : ''}`, { status: t.status },
          this.hintForReadyTasks(agentId));
      }
      const unmet = this.unmetDeps(id);
      if (unmet.length) {
        throw new HiveError('deps_unmet', `task ${id} waits on tasks ${unmet.join(', ')}`, { waiting_on: unmet },
          this.hintForReadyTasks(agentId));
      }
      const files = this.taskFiles(id);
      const conflicts = this.findConflicts(agentId, files);
      if (conflicts.length) {
        throw new HiveError('conflict', `task ${id} files are held by others`, { held: conflicts },
          `message ${[...new Set(conflicts.map((c) => c.by))].join('/')} or leader; ${this.hintForReadyTasks(agentId)}`);
      }
      this.insertClaims(agentId, files, id);
      this.setTask(id, { status: 'in_progress', owner_id: agentId });
      this.event('task_status', { agent_id: agentId, task_id: id, data: { status: 'in_progress' } });
      return { task: this.task(id), claimed: files };
    });
  }

  /** Member-driven transitions: in_progress, review, blocked (and unblock back to in_progress). */
  updateTask(actor: Actor, id: number, status: TaskStatus, note?: string): TaskRow {
    return this.tx(() => {
      if (actor) this.touch(actor);
      const t = this.task(id);
      const privileged = actor === null || this.isLeader(actor);
      if (!privileged && t.owner_id !== actor) {
        throw new HiveError('forbidden', `task ${id} is not yours`, { owner: t.owner_id ? this.agent(t.owner_id).name : null });
      }
      const bad = () => new HiveError('bad_state', `cannot move task ${id} from ${t.status} to ${status}`, { status: t.status });
      switch (status) {
        case 'review':
          if (t.status !== 'in_progress') throw bad();
          this.setTask(id, { status: 'review' });
          this.releaseTaskClaims(id);
          if (this.leaderId()) {
            this.insertMessage(actor, 'leader', null, `Task #${id} "${t.title}" is ready for review (branch ${t.branch})${note ? `: ${note}` : ''}`, id);
          }
          break;
        case 'blocked':
          if (t.status === 'done' || t.status === 'blocked') throw bad();
          if (!note?.trim()) throw new HiveError('invalid', 'a note explaining the blocker is required');
          this.setTask(id, { status: 'blocked', blocked_from: t.status });
          this.insertMessage(actor, 'leader', null, `Task #${id} blocked: ${note}`, id);
          break;
        case 'in_progress':
          if (t.status === 'blocked') {
            const back = t.blocked_from ?? 'open';
            this.setTask(id, { status: back, blocked_from: null });
            this.event('task_status', { agent_id: actor, task_id: id, data: { status: back, note } });
            return this.task(id);
          }
          throw new HiveError('bad_state', `task ${id} is ${t.status}`, { status: t.status }, `use claim_task(${id}) to start a task`);
        case 'done':
          if (actor === null) { this.setTask(id, { status: 'done' }); this.releaseTaskClaims(id); break; }
          throw new HiveError('leader_only', 'only review_task can mark a task done', {}, `set status "review" and the leader will approve`);
        default:
          if (!privileged) throw bad();
          this.setTask(id, { status });
      }
      this.event('task_status', { agent_id: actor, task_id: id, data: { status, note } });
      return this.task(id);
    });
  }

  reviewTask(actor: Actor, id: number, verdict: 'approve' | 'changes_requested', notes?: string): { task: TaskRow; warnings: string[] } {
    this.requireLeader(actor, 'review_task');
    return this.tx(() => {
      const t = this.task(id);
      if (t.status !== 'review') throw new HiveError('bad_state', `task ${id} is ${t.status}, not review`, { status: t.status });
      const warnings: string[] = [];
      if (verdict === 'approve') {
        this.setTask(id, { status: 'done', review_notes: notes ?? null });
        this.releaseTaskClaims(id);
        if (t.owner_id) this.insertMessage(actor, 'agent', t.owner_id, `Task #${id} approved. A human will merge ${t.branch}.${notes ? ` Notes: ${notes}` : ''}`, id);
      } else {
        this.setTask(id, { status: 'in_progress', review_notes: notes ?? null });
        if (t.owner_id) {
          const files = this.taskFiles(id);
          const conflicts = this.findConflicts(t.owner_id, files);
          const free = files.filter((f) => !conflicts.some((c) => c.path === f));
          this.insertClaims(t.owner_id, free, id);
          for (const c of conflicts) warnings.push(`${c.path} now held by ${c.by}`);
          this.insertMessage(actor, 'agent', t.owner_id, `Task #${id} needs changes: ${notes ?? '(no notes)'}`, id);
        }
      }
      this.event('task_reviewed', { agent_id: actor, task_id: id, data: { verdict, notes } });
      return { task: this.task(id), warnings };
    });
  }

  /**
   * Started work whose owner has gone quiet for longer than the claim TTL: their claims are
   * gone, so the task is effectively orphaned until someone reassigns it.
   */
  staleTasks(): { id: number; title: string; owner: string; offline_for_s: number }[] {
    const now = this.now();
    return this.tasks()
      .filter((t) => (t.status === 'in_progress' || t.status === 'assigned') && t.owner_id)
      .map((t) => ({ t, a: this.agent(t.owner_id!) }))
      .filter(({ a }) => now - a.last_seen_at > this.claimTtlMs)
      .map(({ t, a }) => ({ id: t.id, title: t.title, owner: a.name, offline_for_s: Math.round((now - a.last_seen_at) / 1000) }));
  }

  /** Approved branches a human still has to merge, oldest first. */
  mergeQueue(): TaskRow[] {
    return this.tasks({ status: 'done' }).filter((t) => !t.merged_at).sort((a, b) => a.updated_at - b.updated_at);
  }

  /** A human merged (or dismissed) an approved branch. */
  markMerged(id: number, merged = true): TaskRow {
    const t = this.task(id);
    if (t.status !== 'done') throw new HiveError('bad_state', `task ${id} is ${t.status}; only approved (done) tasks can be merged`);
    this.db.prepare('UPDATE tasks SET merged_at = ? WHERE id = ?').run(merged ? this.now() : null, id);
    this.event('task_merged', { task_id: id, data: { branch: t.branch, merged } });
    this.onChange('tasks');
    return this.task(id);
  }

  private setTask(id: number, fields: Partial<Pick<TaskRow, 'status' | 'owner_id' | 'blocked_from' | 'review_notes'>>): void {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = @now WHERE id = @id`).run({ ...fields, id, now: this.now() });
    this.onChange('tasks');
  }

  /** Short hint listing up to 3 ready tasks whose files are free for this agent. */
  hintForReadyTasks(agentId: string): string {
    const ready = this.tasks({ ready: true })
      .filter((t) => this.findConflicts(agentId, this.taskFiles(t.id)).length === 0)
      .slice(0, 3)
      .map((t) => t.id);
    return ready.length ? `free ready tasks: ${ready.join(', ')}` : 'no free ready tasks; ask the leader';
  }

  // ───────────────────────── claims ─────────────────────────

  activeClaims(): ClaimRow[] {
    return this.db.prepare('SELECT * FROM claims WHERE expires_at > ? ORDER BY pattern').all(this.now()) as ClaimRow[];
  }

  claimsOf(agentId: string): ClaimRow[] {
    return this.activeClaims().filter((c) => c.agent_id === agentId);
  }

  /** Active claims by agents other than `agentId` that overlap any of `patterns`. */
  findConflicts(agentId: string | null, patterns: string[]): ClaimConflict[] {
    const now = this.now();
    const others = this.activeClaims().filter((c) => c.agent_id !== agentId);
    const out: ClaimConflict[] = [];
    for (const p of patterns.map(normalizePattern)) {
      for (const c of others) {
        if (overlaps(p, c.pattern)) {
          out.push({ path: p, held: c.pattern, by: this.agent(c.agent_id).name, task: c.task_id, expires_in_s: Math.round((c.expires_at - now) / 1000) });
        }
      }
    }
    return out;
  }

  /** All-or-nothing claim. Re-claiming your own pattern just renews it. */
  claimFiles(agentId: string, paths: string[], taskId?: number): { claimed: string[] } {
    if (!paths.length) throw new HiveError('invalid', 'no paths given');
    return this.tx(() => {
      this.touch(agentId);
      if (taskId !== undefined) this.task(taskId);
      const conflicts = this.findConflicts(agentId, paths);
      if (conflicts.length) {
        const holders = [...new Set(conflicts.map((c) => c.by))];
        throw new HiveError('conflict', 'files are held by others', { held: conflicts },
          `don't edit these; message ${holders.join('/')} or leader to coordinate`);
      }
      const claimed = uniqueCi(paths.map(normalizePattern));
      this.insertClaims(agentId, claimed, taskId ?? null);
      return { claimed };
    });
  }

  private insertClaims(agentId: string, patterns: string[], taskId: number | null): void {
    const now = this.now();
    for (const p of patterns) {
      const own = this.db.prepare('SELECT id FROM claims WHERE agent_id = ? AND pattern = ? COLLATE NOCASE AND expires_at > ?').get(agentId, p, now) as { id: number } | undefined;
      if (own) {
        this.db.prepare('UPDATE claims SET expires_at = ?, task_id = COALESCE(?, task_id) WHERE id = ?').run(now + this.claimTtlMs, taskId, own.id);
      } else {
        this.db.prepare('INSERT INTO claims(agent_id, pattern, task_id, created_at, expires_at) VALUES(?, ?, ?, ?, ?)')
          .run(agentId, p, taskId, now, now + this.claimTtlMs);
      }
    }
    if (patterns.length) {
      this.event('claim', { agent_id: agentId, task_id: taskId, data: { patterns } });
      this.onChange('claims');
    }
  }

  releaseFiles(agentId: string, paths: string[]): { released: string[] } {
    return this.tx(() => {
      this.touch(agentId);
      const released: string[] = [];
      for (const p of paths.map(normalizePattern)) {
        const r = this.db.prepare('DELETE FROM claims WHERE agent_id = ? AND pattern = ? COLLATE NOCASE').run(agentId, p);
        if (r.changes) released.push(p);
      }
      if (released.length) {
        this.event('release', { agent_id: agentId, data: { patterns: released } });
        this.onChange('claims');
      }
      return { released };
    });
  }

  private releaseTaskClaims(taskId: number): void {
    const r = this.db.prepare('DELETE FROM claims WHERE task_id = ?').run(taskId);
    if (r.changes) this.onChange('claims');
  }

  /** For each path: free, mine, or held by someone else. */
  checkFiles(agentId: string | null, paths: string[]): { path: string; status: 'free' | 'mine' | 'held'; by?: string; held?: string; task?: number | null }[] {
    const claims = this.activeClaims();
    return paths.map(normalizePattern).map((p) => {
      const hit = claims.find((c) => c.agent_id !== agentId && overlaps(p, c.pattern));
      if (hit) return { path: p, status: 'held' as const, by: this.agent(hit.agent_id).name, held: hit.pattern, task: hit.task_id };
      const mine = claims.some((c) => c.agent_id === agentId && overlaps(p, c.pattern));
      return { path: p, status: mine ? ('mine' as const) : ('free' as const) };
    });
  }

  /** Is a concrete edited path covered by one of the agent's claims? Used to flag unclaimed edits. */
  coversPath(agentId: string, path: string): boolean {
    const p = normalizePattern(path);
    return this.claimsOf(agentId).some((c) => matches(c.pattern, p));
  }

  forceRelease(actor: Actor, paths: string[]): { released: { pattern: string; from: string }[] } {
    this.requireLeader(actor, 'force_release');
    return this.tx(() => {
      const released: { pattern: string; from: string }[] = [];
      for (const p of paths.map(normalizePattern)) {
        for (const c of this.activeClaims().filter((c) => overlaps(p, c.pattern))) {
          this.db.prepare('DELETE FROM claims WHERE id = ?').run(c.id);
          const from = this.agent(c.agent_id).name;
          released.push({ pattern: c.pattern, from });
          this.insertMessage(actor, 'agent', c.agent_id, `Your claim on ${c.pattern} was force-released${actor === null ? ' by a human' : ' by the leader'}.`, c.task_id);
        }
      }
      if (released.length) {
        this.event('force_release', { agent_id: actor, data: { released } });
        this.onChange('claims');
      }
      return { released };
    });
  }

  pruneExpiredClaims(): number {
    const r = this.db.prepare('DELETE FROM claims WHERE expires_at <= ?').run(this.now());
    if (r.changes) this.onChange('claims');
    return r.changes;
  }

  // ───────────────────────── messages ─────────────────────────

  sendMessage(from: Actor, to: string, body: string, taskId?: number): MessageRow {
    if (!body.trim()) throw new HiveError('invalid', 'empty message');
    return this.tx(() => {
      if (from) this.touch(from);
      if (taskId !== undefined) this.task(taskId);
      const target = to.trim().toLowerCase();
      if (target === 'all') return this.insertMessage(from, 'all', null, body, taskId ?? null);
      if (target === 'leader') return this.insertMessage(from, 'leader', null, body, taskId ?? null);
      return this.insertMessage(from, 'agent', this.resolveAgent(to).id, body, taskId ?? null);
    });
  }

  private insertMessage(from: Actor, toKind: MessageRow['to_kind'], toId: string | null, body: string, taskId: number | null): MessageRow {
    const { lastInsertRowid } = this.db.prepare(
      'INSERT INTO messages(from_id, to_kind, to_id, body, task_id, created_at) VALUES(?, ?, ?, ?, ?, ?)',
    ).run(from, toKind, toId, body, taskId, this.now());
    const id = Number(lastInsertRowid);
    this.event('message', { agent_id: from, task_id: taskId, data: { id, to_kind: toKind, to_id: toId } });
    this.onChange('messages');
    return this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as MessageRow;
  }

  /**
   * Messages addressed to this agent, to everyone, or to "leader" (if it leads right now).
   * Without `since`, returns unread ones and advances the read cursor.
   */
  readMessages(agentId: string, since?: number): MessageRow[] {
    return this.tx(() => {
      this.touch(agentId);
      const me = this.agent(agentId);
      const cursor = since ?? me.last_read_msg_id;
      const leader = this.isLeader(agentId);
      const rows = this.db.prepare(`
        SELECT * FROM messages
        WHERE id > ? AND (from_id IS NULL OR from_id != ?)
          AND (to_kind = 'all' OR (to_kind = 'agent' AND to_id = ?) OR (to_kind = 'leader' AND ?))
        ORDER BY id`).all(cursor, agentId, agentId, leader ? 1 : 0) as MessageRow[];
      const max = rows.reduce((m, r) => Math.max(m, r.id), me.last_read_msg_id);
      if (max > me.last_read_msg_id) this.db.prepare('UPDATE agents SET last_read_msg_id = ? WHERE id = ?').run(max, agentId);
      return rows;
    });
  }

  unreadCount(agentId: string): number {
    const me = this.agent(agentId);
    const row = this.db.prepare(`
      SELECT COUNT(*) n FROM messages
      WHERE id > ? AND (from_id IS NULL OR from_id != ?)
        AND (to_kind = 'all' OR (to_kind = 'agent' AND to_id = ?) OR (to_kind = 'leader' AND ?))`)
      .get(me.last_read_msg_id, agentId, agentId, this.isLeader(agentId) ? 1 : 0) as { n: number };
    return row.n;
  }

  postStatus(actor: Actor, summary: string): MessageRow {
    this.requireLeader(actor, 'post_status');
    return this.tx(() => {
      const m = this.insertMessage(actor, 'all', null, `[status] ${summary}`, null);
      this.event('status', { agent_id: actor, data: { summary } });
      return m;
    });
  }

  // ───────────────────────── subagents ─────────────────────────

  /** Manual fallback when hooks aren't installed. `running` opens a row; done/failed closes the latest one with that name. */
  reportSubagent(agentId: string, name: string, purpose: string, status: 'running' | 'done' | 'failed'): { id: string } {
    return this.tx(() => {
      this.touch(agentId);
      const now = this.now();
      const open = this.db.prepare(
        "SELECT id FROM subagents WHERE agent_id = ? AND name = ? AND status = 'running' ORDER BY started_at DESC",
      ).get(agentId, name) as { id: string } | undefined;
      let id: string;
      if (status === 'running') {
        if (open) id = open.id;
        else {
          id = randomUUID();
          this.db.prepare("INSERT INTO subagents(id, agent_id, name, purpose, status, source, started_at) VALUES(?, ?, ?, ?, 'running', 'manual', ?)")
            .run(id, agentId, name, purpose, now);
        }
      } else if (open) {
        id = open.id;
        this.db.prepare('UPDATE subagents SET status = ?, ended_at = ? WHERE id = ?').run(status, now, id);
      } else {
        id = randomUUID();
        this.db.prepare("INSERT INTO subagents(id, agent_id, name, purpose, status, source, started_at, ended_at) VALUES(?, ?, ?, ?, ?, 'manual', ?, ?)")
          .run(id, agentId, name, purpose, status, now, now);
      }
      this.event('subagent', { agent_id: agentId, subagent_id: id, data: { name, purpose, status } });
      this.onChange('subagents');
      return { id };
    });
  }

  // ───────────────────────── events ─────────────────────────

  event(kind: string, e: { agent_id?: string | null; session_id?: string | null; subagent_id?: string | null; path?: string | null; task_id?: number | null; flag?: string | null; data?: unknown } = {}): void {
    this.db.prepare('INSERT INTO events(ts, agent_id, session_id, subagent_id, kind, path, task_id, flag, data) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(this.now(), e.agent_id ?? null, e.session_id ?? null, e.subagent_id ?? null, kind, e.path ?? null, e.task_id ?? null, e.flag ?? null,
        e.data === undefined ? null : JSON.stringify(e.data));
    this.onChange('events');
  }
}

/** Dedupe patterns ignoring case, keeping the first spelling. */
function uniqueCi(xs: string[]): string[] {
  const seen = new Set<string>();
  return xs.filter((x) => !seen.has(x.toLowerCase()) && !!seen.add(x.toLowerCase()));
}

function overlapList(a: string[], b: string[]): string[] {
  const out: string[] = [];
  for (const x of a) for (const y of b) if (overlaps(x, y)) out.push(x.toLowerCase() === y.toLowerCase() ? x : `${x}~${y}`);
  return out;
}

/** Kahn's algorithm over plan keys; throws on cycles. */
function topoSort(tasks: PlanTaskInput[]): PlanTaskInput[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const indeg = new Map(tasks.map((t) => [t.key, (t.depends_on ?? []).length]));
  const queue = tasks.filter((t) => !t.depends_on?.length).map((t) => t.key);
  const out: PlanTaskInput[] = [];
  while (queue.length) {
    const k = queue.shift()!;
    out.push(byKey.get(k)!);
    for (const t of tasks) {
      if (t.depends_on?.includes(k)) {
        const n = indeg.get(t.key)! - 1;
        indeg.set(t.key, n);
        if (n === 0) queue.push(t.key);
      }
    }
  }
  if (out.length !== tasks.length) {
    const stuck = tasks.filter((t) => !out.includes(t)).map((t) => t.key);
    throw new HiveError('invalid', `dependency cycle among: ${stuck.join(', ')}`, { cycle: stuck });
  }
  return out;
}
