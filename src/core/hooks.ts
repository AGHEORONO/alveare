// Ingests Claude Code hook events (already whitelisted by .hive/hook.mjs) into sessions,
// subagents and the activity feed.
import type { Hive } from './hive.js';
import { normalizePattern } from './glob.js';

export interface HookEvent {
  hook_event_name: string;
  session_id?: string;
  cwd?: string;
  agent_id?: string;        // present when the event fires inside a subagent
  agent_type?: string;
  source?: string;          // SessionStart
  reason?: string;          // SessionEnd
  tool_name?: string;
  file_path?: string;       // repo-relative, computed by hook.mjs
  description?: string;     // Agent/Task tool_input.description (PreToolUse)
  subagent_type?: string;   // Agent/Task tool_input.subagent_type (PreToolUse)
  task_title?: string;      // TaskCompleted
}

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
export const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);

export class HookIngest {
  /** Purposes announced by PreToolUse(Agent), waiting for the matching SubagentStart. Key: session. */
  private pending = new Map<string, { type: string; purpose: string }[]>();
  /** Per-agent activity state for the dashboard. */
  readonly activity = new Map<string, { state: 'working' | 'idle'; at: number }>();

  constructor(private hive: Hive) {}

  ingest(agentId: string, e: HookEvent): { flagged?: boolean } {
    const hive = this.hive;
    const now = hive.now();
    const sid = e.session_id ?? null;
    return hive.db.transaction(() => {
      hive.touch(agentId);
      if (sid) {
        hive.db.prepare(`INSERT INTO sessions(id, agent_id, cwd, started_at, last_event_at) VALUES(?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET last_event_at = excluded.last_event_at, agent_id = excluded.agent_id`)
          .run(sid, agentId, e.cwd ?? null, now, now);
      }
      this.activity.set(agentId, { state: e.hook_event_name === 'Stop' || e.hook_event_name === 'SessionEnd' ? 'idle' : 'working', at: now });
      const base = { agent_id: agentId, session_id: sid, subagent_id: e.agent_id ?? null };

      switch (e.hook_event_name) {
        case 'SessionStart':
          if (sid) hive.db.prepare('UPDATE sessions SET ended_at = NULL WHERE id = ?').run(sid);
          hive.event('session_start', { ...base, data: { source: e.source } });
          break;

        case 'SessionEnd':
          if (sid) {
            hive.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(now, sid);
            hive.db.prepare("UPDATE subagents SET status = 'done', ended_at = ? WHERE session_id = ? AND status = 'running'").run(now, sid);
            this.pending.delete(sid);
          }
          hive.event('session_end', { ...base, data: { reason: e.reason } });
          break;

        case 'PreToolUse':
          if (sid && e.tool_name && SUBAGENT_TOOLS.has(e.tool_name)) {
            const q = this.pending.get(sid) ?? [];
            q.push({ type: e.subagent_type ?? 'general-purpose', purpose: e.description ?? '' });
            this.pending.set(sid, q.slice(-20));
          }
          break;

        case 'SubagentStart': {
          if (!e.agent_id) break;
          const q = sid ? this.pending.get(sid) ?? [] : [];
          // Match the oldest pending launch of the same type, else the oldest of any type.
          let i = q.findIndex((p) => p.type === e.agent_type);
          if (i === -1 && q.length) i = 0;
          const purpose = i >= 0 ? q.splice(i, 1)[0].purpose : '';
          hive.db.prepare(`INSERT INTO subagents(id, agent_id, session_id, agent_type, name, purpose, status, source, started_at)
            VALUES(?, ?, ?, ?, ?, ?, 'running', 'hook', ?) ON CONFLICT(id) DO NOTHING`)
            .run(e.agent_id, agentId, sid, e.agent_type ?? null, e.agent_type ?? 'subagent', purpose, now);
          hive.event('subagent', { ...base, data: { status: 'running', type: e.agent_type, purpose } });
          hive.onChange('subagents');
          break;
        }

        case 'SubagentStop':
          if (!e.agent_id) break;
          hive.db.prepare("UPDATE subagents SET status = 'done', ended_at = ? WHERE id = ? AND status = 'running'").run(now, e.agent_id);
          hive.event('subagent', { ...base, data: { status: 'done', type: e.agent_type } });
          hive.onChange('subagents');
          break;

        case 'PostToolUse': {
          if (!e.tool_name || !EDIT_TOOLS.has(e.tool_name) || !e.file_path) break;
          const path = normalizePattern(e.file_path);
          const flagged = !hive.coversPath(agentId, path);
          const task = hive.tasks({ owner: agentId, status: 'in_progress' })[0];
          hive.event('edit', { ...base, path, task_id: task?.id ?? null, flag: flagged ? 'unclaimed' : null, data: { tool: e.tool_name } });
          return { flagged };
        }

        case 'TaskCompleted':
          hive.event('todo_done', { ...base, data: { title: e.task_title } });
          break;
      }
      return {};
    })();
  }
}
