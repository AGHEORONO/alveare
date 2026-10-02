// Compact, name-based views of domain rows. Shared by MCP tool output and the dashboard.
import type { Hive, TaskRow, MessageRow, ClaimRow } from './hive.js';
import { HiveError } from './errors.js';

export function ago(hive: Hive, ts: number): string {
  return duration(hive.now() - ts);
}

export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${(s / 3600).toFixed(1)}h`;
}

export function nameOf(hive: Hive, id: string | null): string | null {
  if (id === null) return null;
  try { return hive.agent(id).name; } catch { return id; }
}

export function taskBrief(hive: Hive, t: TaskRow) {
  const deps = hive.taskDeps(t.id);
  return {
    id: t.id,
    title: t.title,
    status: t.status,
    owner: nameOf(hive, t.owner_id),
    pri: t.priority,
    ...(deps.length ? { deps: deps.map((d) => (d.status === 'done' ? d.id : `${d.id}*`)) } : {}),
  };
}

export function taskFull(hive: Hive, t: TaskRow) {
  return {
    ...taskBrief(hive, t),
    description: t.description,
    acceptance: t.acceptance,
    files: hive.taskFiles(t.id),
    branch: t.branch,
    ...(t.review_notes ? { review_notes: t.review_notes } : {}),
    ...(t.status === 'blocked' ? { blocked_from: t.blocked_from } : {}),
    unmet_deps: hive.unmetDeps(t.id),
  };
}

export function messageView(hive: Hive, m: MessageRow) {
  return {
    id: m.id,
    from: m.from_id ? nameOf(hive, m.from_id) : 'hive',
    to: m.to_kind === 'agent' ? nameOf(hive, m.to_id) : m.to_kind,
    ...(m.task_id ? { task: m.task_id } : {}),
    body: m.body,
    ago: ago(hive, m.created_at),
  };
}

export function claimView(hive: Hive, c: ClaimRow) {
  return {
    path: c.pattern,
    by: nameOf(hive, c.agent_id),
    ...(c.task_id ? { task: c.task_id } : {}),
    expires_in: duration(c.expires_at - hive.now()),
  };
}

/** Error → `{ok:false, error, message, ...details, do}` */
export function errorView(e: unknown) {
  if (e instanceof HiveError) {
    return { ok: false, error: e.code, message: e.message, ...e.details, ...(e.hint ? { do: e.hint } : {}) };
  }
  return { ok: false, error: 'internal', message: e instanceof Error ? e.message : String(e) };
}
