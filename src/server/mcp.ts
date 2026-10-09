import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { type Hive, TASK_STATUSES } from '../core/hive.js';
import { ago, claimView, errorView, messageView, nameOf, taskBrief, taskFull } from '../core/format.js';
import { VERSION } from '../version.js';
export { VERSION };

const INSTRUCTIONS = `Alveare (hive) coordinates several AI coding agents on one repo.
Start with whoami, read_messages, list_tasks. Never edit files claimed by others (check_files); message them or the leader.
claim_task claims the task's files; claim_files before touching anything else. Set status "review" when done, with a short note (what, why, decisions); only the leader approves.
When a result contains "inbox", call read_messages before continuing.
The leader (queen) plans with plan_feature, reviews with review_task, and may remove_agent bees that ignore the workflow.
Workers may vote_replace_queen(reason) if the queen leads badly; when at least two workers voted and every online worker has, a human decides.
The full workflow is in AGENTS.md / CLAUDE.md under "Alveare team workflow".`;

type Json = Record<string, unknown>;

function ok(data: Json) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, ...data }) }] };
}

/** Run a tool body; HiveErrors become structured `{ok:false,...}` results flagged isError. */
function runRaw(fn: () => Json) {
  try {
    return ok(fn());
  } catch (e) {
    return { content: [{ type: 'text' as const, text: JSON.stringify(errorView(e)) }], isError: true };
  }
}

const paths = z.array(z.string().min(1)).min(1).describe('Repo-relative paths, dirs ("src/api/") or globs ("src/**/*.ts")');

/** Build an MCP server whose tools act as `agentId`. */
export function buildMcpServer(hive: Hive, agentId: string): McpServer {
  const server = new McpServer({ name: 'hive', version: VERSION }, { instructions: INSTRUCTIONS });
  const me = agentId;
  // Standard MCP hints: hive tools never touch files or the outside world; some only read.
  const READ_ONLY = new Set(['whoami', 'list_agents', 'list_tasks', 'get_task', 'check_files']);
  const tool: typeof server.registerTool = (name, config, cb) => server.registerTool(name, {
    ...config,
    annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: false, openWorldHint: false, ...config.annotations },
  }, cb);

  /**
   * MCP can't push into an agent's chat, so every successful result carries pending notices:
   * unread messages for everyone, and tasks waiting for review for the queen.
   */
  const run = (fn: () => Json) => runRaw(() => {
    const data = fn();
    const unread = hive.unreadCount(me);
    const leader = hive.isLeader(me);
    const reviews = leader ? hive.tasks({ status: 'review' }).length : 0;
    const stale = leader ? hive.staleTasks() : [];
    const votes = leader ? hive.queenVotes() : null;
    return {
      ...data,
      ...(unread ? { inbox: unread } : {}),
      ...(reviews ? { reviews_waiting: reviews } : {}),
      ...(votes?.votes.length ? { replace_queen_votes: `${votes.votes.length} of ${votes.online_workers} online workers want a new queen${votes.emergency ? '; the beekeeper has been alerted' : ''}. read_messages for their reasons and fix what they raise.` } : {}),
      ...(stale.length ? { stale_tasks: stale.map((t) => `#${t.id} (${t.owner} silent ${Math.round(t.offline_for_s / 60)}m: reassign_task?)`) } : {}),
    };
  });

  // ───────── all agents ─────────

  tool('whoami', { description: 'Your name, role, leader, your open tasks, claims and unread message count.' }, () => run(() => {
    hive.touch(me);
    const a = hive.agent(me);
    const mine = hive.tasks({ owner: me }).filter((t) => t.status !== 'done');
    return {
      name: a.name,
      role: hive.isLeader(me) ? 'leader' : 'member',
      leader: nameOf(hive, hive.leaderId()),
      independent_queen: hive.independentQueen(),
      tasks: mine.map((t) => taskBrief(hive, t)),
      claims: hive.claimsOf(me).map((c) => c.pattern),
      unread: hive.unreadCount(me),
    };
  }));

  tool('list_agents', { description: 'Team members with role, online status, current task and running subagents.' }, () => run(() => {
    hive.touch(me);
    const leader = hive.leaderId();
    const running = hive.db.prepare("SELECT agent_id, COUNT(*) n FROM subagents WHERE status = 'running' GROUP BY agent_id").all() as { agent_id: string; n: number }[];
    return {
      agents: hive.agents().filter((a) => !a.removed_at).map((a) => {
        const cur = hive.tasks({ owner: a.id, status: 'in_progress' })[0];
        const subs = running.find((r) => r.agent_id === a.id)?.n ?? 0;
        return {
          name: a.name,
          role: a.id === leader ? 'leader' : 'member',
          online: hive.isOnline(a),
          seen: ago(hive, a.last_seen_at),
          ...(cur ? { task: cur.id } : {}),
          ...(subs ? { subagents: subs } : {}),
        };
      }),
    };
  }));

  tool('heartbeat', { description: 'Keep your file claims alive during long work without other Hive calls.' }, () => run(() => {
    hive.touch(me);
    return { claims: hive.claimsOf(me).length, unread: hive.unreadCount(me) };
  }));

  tool('list_tasks', {
    description: 'List tasks. deps entries ending in * are not done yet.',
    inputSchema: {
      status: z.enum(TASK_STATUSES).optional(),
      owner: z.string().optional().describe('"me" or an agent name'),
      ready: z.boolean().optional().describe('only open tasks whose dependencies are done'),
    },
  }, (args) => run(() => {
    hive.touch(me);
    const owner = args.owner === undefined ? undefined : args.owner === 'me' ? me : hive.resolveAgent(args.owner).id;
    const tasks = hive.tasks({ status: args.status, owner, ready: args.ready });
    return { count: tasks.length, tasks: tasks.map((t) => taskBrief(hive, t)) };
  }));

  tool('get_task', { description: 'Full task details: description, acceptance, files, branch, deps.', inputSchema: { id: z.number().int() } },
    ({ id }) => run(() => { hive.touch(me); return { task: taskFull(hive, hive.task(id)) }; }));

  tool('claim_task', {
    description: 'Start a task (open, or assigned to you). Claims its declared files atomically. Then: git checkout -b <branch>.',
    inputSchema: { id: z.number().int() },
  }, ({ id }) => run(() => {
    const r = hive.claimTask(me, id);
    return { id, status: r.task.status, branch: r.task.branch, claimed: r.claimed, do: `git checkout -b ${r.task.branch}` };
  }));

  tool('update_task', {
    description: 'Move your task: "review" when done (releases its claims, notifies leader; note required), "blocked" with a note, "in_progress" to unblock.',
    inputSchema: {
      id: z.number().int(),
      status: z.enum(['in_progress', 'review', 'blocked']),
      note: z.string().optional().describe('for review: "What: ... Why: ... Decisions: ..." in 2-3 lines; add more only if the reviewer needs it'),
      pr: z.string().optional().describe('pull request URL, if you opened one'),
    },
  }, ({ id, status, note, pr }) => run(() => {
    const t = hive.updateTask(me, id, status, note, pr);
    return { id, status: t.status };
  }));

  tool('claim_files', {
    description: 'Claim files before editing anything outside your task\'s declared files. All-or-nothing.',
    inputSchema: { paths, task_id: z.number().int().optional() },
  }, ({ paths, task_id }) => run(() => hive.claimFiles(me, paths, task_id)));

  tool('release_files', { description: 'Release your claims (exact patterns you claimed).', inputSchema: { paths } },
    ({ paths }) => run(() => hive.releaseFiles(me, paths)));

  tool('check_files', { description: 'Is each path free, yours, or held (by whom)?', inputSchema: { paths } },
    ({ paths }) => run(() => { hive.touch(me); return { files: hive.checkFiles(me, paths) }; }));

  tool('send_message', {
    description: 'Message an agent by name, "leader", or "all".',
    inputSchema: { to: z.string().min(1), body: z.string().min(1), task_id: z.number().int().optional() },
  }, ({ to, body, task_id }) => run(() => ({ id: hive.sendMessage(me, to, body, task_id).id })));

  tool('read_messages', {
    description: 'Unread messages for you (direct, broadcast, and "leader" if you lead). Pass since=<id> to re-read history.',
    inputSchema: { since: z.number().int().optional() },
  }, ({ since }) => run(() => ({ messages: hive.readMessages(me, since).map((m) => messageView(hive, m)) })));

  tool('vote_replace_queen', {
    description: 'Vote that the queen should be replaced (bad plans, ignored messages, broken approvals, unfair removals). When at least two workers voted and every online worker has, the beekeeper (a human) gets an emergency and decides. Voting again updates your reason.',
    inputSchema: { reason: z.string().min(1).describe('concrete examples; the beekeeper reads this') },
  }, ({ reason }) => run(() => {
    const v = hive.voteReplaceQueen(me, reason);
    return { votes: v.votes.length, online_workers: v.online_workers, emergency: v.emergency };
  }));

  tool('withdraw_vote', { description: 'Take back your vote to replace the queen.' },
    () => run(() => hive.withdrawVote(me)));

  tool('report_subagent', {
    description: 'Manual subagent tracking (only needed if Hive hooks are not installed).',
    inputSchema: { name: z.string().min(1), purpose: z.string(), status: z.enum(['running', 'done', 'failed']) },
  }, ({ name, purpose, status }) => run(() => hive.reportSubagent(me, name, purpose, status)));

  // ───────── leader only ─────────

  const planTask = z.object({
    key: z.string().min(1).describe('local id used by depends_on'),
    title: z.string().min(1),
    description: z.string().optional(),
    acceptance: z.string().optional(),
    files: z.array(z.string()).optional().describe('expected files/dirs/globs; claimed when the task starts'),
    depends_on: z.array(z.string()).optional().describe('keys of other tasks in this plan'),
    priority: z.number().int().min(0).max(4).optional().describe('0 = highest, default 2'),
    assignee: z.string().optional(),
  });

  tool('plan_feature', {
    description: '[leader] Create a feature breakdown atomically. Call without tasks to get a template and the online agents. Keep file sets disjoint.',
    inputSchema: { description: z.string().min(1), tasks: z.array(planTask).optional() },
  }, ({ description, tasks }) => run(() => {
    if (!tasks?.length) {
      hive.requireLeader(me, 'plan_feature');
      return {
        template: { key: 'api', title: '...', description: '...', acceptance: '...', files: ['src/api/'], depends_on: [], priority: 2, assignee: 'name' },
        online: hive.agents().filter((a) => hive.isOnline(a)).map((a) => ({ name: a.name, open_tasks: hive.tasks({ owner: a.id }).filter((t) => t.status !== 'done').length })),
        existing: hive.tasks().filter((t) => t.status !== 'done').map((t) => taskBrief(hive, t)),
        do: 'call plan_feature again with tasks[]; small tasks, disjoint files, balanced across online agents',
      };
    }
    const r = hive.planFeature(me, description, tasks);
    return { created: r.tasks, ...(r.warnings.length ? { warnings: r.warnings } : {}) };
  }));

  tool('create_task', {
    description: '[leader] Create one task.',
    inputSchema: {
      title: z.string().min(1), description: z.string().optional(), acceptance: z.string().optional(),
      files: z.array(z.string()).optional(), depends_on: z.array(z.number().int()).optional(),
      priority: z.number().int().min(0).max(4).optional(),
    },
  }, (args) => run(() => ({ id: hive.createTask(me, args).id })));

  tool('assign_task', { description: '[leader] Assign an open task to an agent (they get a message).', inputSchema: { id: z.number().int(), agent: z.string() } },
    ({ id, agent }) => run(() => hive.assignTask(me, id, agent)));

  tool('reassign_task', {
    description: '[leader] Give a started/blocked task to another agent; its claims move too.',
    inputSchema: { id: z.number().int(), agent: z.string(), note: z.string().optional() },
  }, ({ id, agent, note }) => run(() => hive.reassignTask(me, id, agent, note)));

  tool('review_task', {
    description: '[leader] Approve (done; humans merge) or request changes (back to in_progress) for a task in review. Notes are required: one or two lines on why. When independent_queen is false, the queen cannot review her own tasks and any other bee reviews them instead.',
    inputSchema: { id: z.number().int(), verdict: z.enum(['approve', 'changes_requested']), notes: z.string().describe('why you approve, or exactly what must change') },
  }, ({ id, verdict, notes }) => run(() => {
    const r = hive.reviewTask(me, id, verdict, notes);
    const pr = r.task.pr_url;
    return {
      id, status: r.task.status, ...(r.warnings.length ? { warnings: r.warnings } : {}),
      ...(pr ? { pr, do: `put your verdict on GitHub too: gh pr comment ${pr} --body "${verdict === 'approve' ? 'Approved' : 'Changes requested'} by the queen: <your notes>"` } : {}),
    };
  }));

  tool('force_release', { description: '[leader] Release anyone\'s claims overlapping these paths (owners are notified).', inputSchema: { paths } },
    ({ paths }) => run(() => hive.forceRelease(me, paths)));

  tool('remove_agent', {
    description: '[leader] Throw a bee out of the hive for not doing the work well (ignores the workflow, edits claimed files, skips notes, keeps failing review after warnings). Its token stops working, its claims are freed and its unfinished tasks reopen. A human can let it back in. You cannot remove a bee that voted to replace you.',
    inputSchema: { agent: z.string(), reason: z.string().min(1).describe('shown to every bee and the beekeeper') },
    annotations: { destructiveHint: true },
  }, ({ agent, reason }) => run(() => hive.removeAgent(me, agent, reason)));

  tool('post_status', { description: '[leader] Post a status summary to everyone and the dashboard feed.', inputSchema: { summary: z.string().min(1) } },
    ({ summary }) => run(() => ({ id: hive.postStatus(me, summary).id })));

  tool('transfer_leadership', { description: '[leader] Make another agent the leader.', inputSchema: { to: z.string() } },
    ({ to }) => run(() => hive.transferLeadership(me, to)));

  return server;
}

/** List of active claims, for diagnostics. */
export function claimsSnapshot(hive: Hive) {
  return hive.activeClaims().map((c) => claimView(hive, c));
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

/** Stateless streamable-HTTP handling: every POST builds a server bound to the caller's agent. */
export async function handleMcp(hive: Hive, req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
  const token = bearer(req);
  const agent = token ? hive.authenticate(token) : null;
  const removed = !agent && token ? hive.removedAgent(token) : null;
  if (removed) {
    res.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({
      error: `${removed.name} was removed from the hive: ${removed.removed_reason ?? 'no reason given'}. Stop working on hive tasks; ask the beekeeper (a human) to let you back in.`,
    }));
    return;
  }
  if (!agent) {
    res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid or missing Hive token; run hive join' }));
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405, { allow: 'POST' }).end();
    return;
  }
  const server = buildMcpServer(hive, agent.id);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
