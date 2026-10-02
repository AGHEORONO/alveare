// Full dashboard snapshot. The team is small, so the dashboard simply receives the whole state
// (debounced) on every change instead of computing deltas.
import type { Hive } from '../core/hive.js';
import type { HookIngest } from '../core/hooks.js';
import { claimView, messageView, nameOf, taskFull } from '../core/format.js';

interface EventRow {
  id: number; ts: number; agent_id: string | null; session_id: string | null; subagent_id: string | null;
  kind: string; path: string | null; task_id: number | null; flag: string | null; data: string | null;
}

const RECENT_SUBAGENT_MS = 10 * 60_000;

export function snapshot(hive: Hive, hooks: HookIngest) {
  const now = hive.now();
  const leaderId = hive.leaderId();
  const subs = hive.db.prepare(
    "SELECT * FROM subagents WHERE status = 'running' OR ended_at > ? ORDER BY started_at",
  ).all(now - RECENT_SUBAGENT_MS) as { id: string; agent_id: string; agent_type: string | null; name: string | null; purpose: string | null; status: string; started_at: number; ended_at: number | null; source: string }[];

  const agents = hive.agents().map((a) => {
    const act = hooks.activity.get(a.id);
    const current = hive.tasks({ owner: a.id }).filter((t) => t.status === 'in_progress' || t.status === 'blocked' || t.status === 'review');
    return {
      id: a.id,
      name: a.name,
      role: a.id === leaderId ? 'leader' : 'member',
      host: !!a.is_host,
      online: hive.isOnline(a),
      last_seen: a.last_seen_at,
      activity: act && hive.isOnline(a) ? act.state : null,
      tasks: current.map((t) => ({ id: t.id, title: t.title, status: t.status })),
      claims: hive.claimsOf(a.id).length,
      subagents: subs.filter((s) => s.agent_id === a.id).map((s) => ({
        id: s.id, name: s.name ?? s.agent_type ?? 'subagent', type: s.agent_type, purpose: s.purpose, status: s.status,
        started_at: s.started_at, ended_at: s.ended_at, source: s.source,
      })),
    };
  });

  const tasks = hive.tasks().map((t) => ({ ...taskFull(hive, t), updated_at: t.updated_at }));

  const claims = hive.activeClaims().map((c) => ({ ...claimView(hive, c), expires_at: c.expires_at }));

  const events = hive.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 150').all() as EventRow[];
  const feed = events.map((e) => feedItem(hive, e)).filter((x) => x !== null);

  const unclaimed = hive.db.prepare(
    "SELECT path, agent_id, MAX(ts) ts, COUNT(*) n FROM events WHERE flag = 'unclaimed' AND ts > ? GROUP BY path, agent_id ORDER BY ts DESC LIMIT 50",
  ).all(now - 60 * 60_000) as { path: string; agent_id: string; ts: number; n: number }[];

  return {
    now,
    session: hive.getMeta('session_name') ?? 'Hive',
    join_code: hive.joinCode(),
    leader: hive.leaderStatus(),
    claim_ttl_ms: hive.claimTtlMs,
    agents,
    tasks,
    claims,
    unclaimed: unclaimed.map((u) => ({ path: u.path, by: nameOf(hive, u.agent_id), ts: u.ts, count: u.n })),
    feed,
  };
}

function feedItem(hive: Hive, e: EventRow): { id: number; ts: number; kind: string; who: string | null; text: string; task?: number; flag?: string } | null {
  const who = e.agent_id ? nameOf(hive, e.agent_id) : 'human';
  const d = e.data ? JSON.parse(e.data) : {};
  const base = { id: e.id, ts: e.ts, kind: e.kind, who, ...(e.task_id ? { task: e.task_id } : {}), ...(e.flag ? { flag: e.flag } : {}) };
  switch (e.kind) {
    case 'message': {
      const m = hive.db.prepare('SELECT * FROM messages WHERE id = ?').get(d.id) as Parameters<typeof messageView>[1] | undefined;
      if (!m) return null;
      const v = messageView(hive, m);
      if (m.body.startsWith('[status] ')) return null; // shown via the 'status' event
      return { ...base, who: v.from, text: `→ ${v.to}: ${m.body}` };
    }
    case 'status': return { ...base, text: `status: ${d.summary}` };
    case 'task_created': return { ...base, text: `created task #${e.task_id}` };
    case 'task_assigned': return { ...base, text: `was assigned task #${e.task_id}` };
    case 'task_reassigned': return { ...base, text: `took over task #${e.task_id}${d.from ? ` from ${d.from}` : ''}` };
    case 'task_status': return { ...base, text: `task #${e.task_id} → ${d.status}${d.note ? ` (${d.note})` : ''}` };
    case 'task_reviewed': return { ...base, text: `review #${e.task_id}: ${d.verdict}${d.notes ? ` — ${d.notes}` : ''}` };
    case 'feature_planned': return { ...base, text: `planned "${d.description}" (${d.tasks} tasks)` };
    case 'leader_changed': return { ...base, text: `is now leader${d.from ? ` (was ${d.from})` : ''}` };
    case 'agent_joined': return { ...base, text: 'joined' };
    case 'claim': return { ...base, text: `claimed ${d.patterns.join(', ')}` };
    case 'release': return { ...base, text: `released ${d.patterns.join(', ')}` };
    case 'force_release': return { ...base, text: `force-released ${d.released.map((r: { pattern: string; from: string }) => `${r.pattern} (${r.from})`).join(', ')}` };
    case 'edit': return { ...base, text: `${e.flag === 'unclaimed' ? 'edited UNCLAIMED' : 'edited'} ${e.path}` };
    case 'subagent': return { ...base, text: `subagent ${d.name ?? d.type ?? ''} ${d.status}${d.purpose ? `: ${d.purpose}` : ''}` };
    case 'session_start': return { ...base, text: `started a Claude session (${d.source ?? 'startup'})` };
    case 'session_end': return { ...base, text: 'ended a Claude session' };
    case 'todo_done': return { ...base, text: `completed todo: ${d.title ?? ''}` };
    case 'code_rotated': return { ...base, text: 'rotated the join code' };
    default: return { ...base, text: e.kind };
  }
}
