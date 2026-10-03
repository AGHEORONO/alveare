<!-- hive:start -->
## Alveare team workflow

Several AI coding agents work on this repo at once. They may be different tools: Claude Code, Antigravity (agy), Cursor, Codex, Copilot, opencode and others. They coordinate through the **hive** MCP server. Use its tools: `whoami`, `list_tasks`, `claim_task`, `claim_files`, `send_message`, `read_messages` and the rest.
When the user says "start hive workflow" (or at the start of any coding work), follow this. `whoami` tells you your role: **queen** = leader, **worker** = member.

### Always
- Start with `whoami`, `read_messages`, `list_tasks`.
- Never edit a file claimed by someone else. If in doubt, run `check_files`. If you need a file someone else holds, `send_message` its owner or `"leader"`, and work on something else meanwhile.
- Call `read_messages` between steps and answer questions addressed to you. Messages are not pushed to you, but any hive tool result that contains `"inbox": N` means you have N unread messages: read them before continuing. The queen also sees `"reviews_waiting": N`.
- Hive tool results are JSON. If `ok` is false, read `error` and follow `do`.
- If your tool has no Hive hooks (anything other than Claude Code), call `heartbeat` every few minutes during long work so your file claims don't expire.

### If you are the queen (leader)
1. If there is no plan: call `plan_feature(description)` with no tasks to get the template and the online agents. Then call it again with `tasks[]`:
   - small tasks with clear acceptance criteria
   - disjoint `files` (directories or globs are fine)
   - `depends_on` where order matters
   - an `assignee` for each task, balancing load across online agents
2. Loop:
   - answer messages
   - `list_tasks(status:"review")`, then `review_task` on each: approve, or `changes_requested` with concrete notes
   - reassign blocked work, or the work of agents that went offline (`list_agents`). Results include `"stale_tasks"` when a worker has gone silent while holding a task.
   - resolve claim conflicts, using `force_release` only if the holder is gone
   - `post_status` every few completed tasks
3. Humans merge approved branches. Do not merge yourself.
4. You may also take tasks yourself when the team is small.

### If you are a worker (member)
1. Work on tasks assigned to you first. Otherwise `list_tasks(ready:true)` and pick one.
2. `claim_task(id)` claims the task's declared files. Then `git checkout -b <branch>` (the branch name comes back in the result).
3. Before editing any file outside the declared set, call `claim_files`. If it fails, do not edit; message the holder or the leader.
4. When done:
   - run the tests
   - commit and `git push -u origin <branch>`
   - `update_task(id, "review", note)`, which releases the task's claims
   - `release_files` any extra claims
5. If stuck: `update_task(id, "blocked", note)` and `send_message("leader", ...)`.
6. If `review_task` sends changes back, you'll get a message. The task returns to in_progress with its files re-claimed.
<!-- hive:end -->
