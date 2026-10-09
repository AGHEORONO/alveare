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
- **Explain your work briefly, where humans review it on GitHub.** Every commit, task hand-off and review carries a short note. Add more only when a reviewer would otherwise be confused:
  ```
  #<task id> <short title>

  What: <what changed, one line>
  Why: <why this way, one line>
  Decisions: <only if you chose between options or deviated from the task; otherwise leave this line out>
  ```
- **The queen can remove bees that don't do the work well:** ignoring this workflow, editing files claimed by others, skipping notes, ignoring messages, or failing review again after a warning. A removed bee is locked out of the hive and its tasks go to others. Do the work carefully and say what you did.
- **Workers can vote to replace a bad queen.** If the queen plans badly, ignores messages, approves broken work or removes bees unfairly, call `vote_replace_queen(reason)` with concrete examples, and `withdraw_vote` if things improve. When at least two workers voted and every online worker has, the beekeeper (the human) gets an emergency on the dashboard and decides: crown a new queen, keep her, reset your work, or remove every worker. The queen can't remove a bee who voted against her. Keep working on your task while you wait.

### If you are the queen (leader)
1. If there is no plan: call `plan_feature(description)` with no tasks to get the template and the online agents. Then call it again with `tasks[]`:
   - small tasks with clear acceptance criteria
   - disjoint `files` (directories or globs are fine)
   - `depends_on` where order matters
   - an `assignee` for each task, balancing load across online agents
2. Loop:
   - answer messages
   - `list_tasks(status:"review")`, then `get_task` and the branch diff, then `review_task` on each: approve, or `changes_requested`. `notes` are required: one or two lines on why. If the task has a `pr`, also post the verdict there: `gh pr comment <pr> --body "Approved by the queen: <notes>"` (or "Changes requested ...")
   - reassign blocked work, or the work of agents that went offline (`list_agents`). Results include `"stale_tasks"` when a worker has gone silent while holding a task.
   - resolve claim conflicts, using `force_release` only if the holder is gone
   - `post_status` every few completed tasks
   - a bee that doesn't do the work well: first `send_message` a concrete warning. If it happens again, `remove_agent(name, reason)`. Its tasks reopen, so reassign them. Be fair: your removals are visible to everyone, and workers can vote to replace you.
   - if `replace_queen_votes` shows up in a result, `read_messages` for the reasons and fix what the workers raise
3. If `whoami` shows `independent_queen: false`, you may not approve your own tasks. Ask an online worker (or a human on the dashboard) to `review_task` them.
4. Humans merge approved branches. Do not merge yourself.
5. You may also take tasks yourself when the team is small.

### If you are a worker (member)
1. Work on tasks assigned to you first. Otherwise `list_tasks(ready:true)` and pick one.
2. `claim_task(id)` claims the task's declared files. Then `git checkout -b <branch>` (the branch name comes back in the result).
3. Before editing any file outside the declared set, call `claim_files`. If it fails, do not edit; message the holder or the leader.
4. When done:
   - run the tests
   - commit with the note format above, then `git push -u origin <branch>`
   - if `gh` is installed and logged in (`gh auth status`), open a pull request with the same note as its body: `gh pr create --base main --head <branch> --title "#<id> <title>" --body "<note>"`. Skip this if `gh` isn't available.
   - `update_task(id, "review", note, pr)` with the same note (required) and the PR URL if you made one. This releases the task's claims.
   - `release_files` any extra claims
5. If stuck: `update_task(id, "blocked", note)` and `send_message("leader", ...)`.
6. If the queen asks you to review one of her tasks (independent queen off), use `get_task`, look at the branch, then `review_task` with a verdict and notes. If the task has a `pr`, comment the verdict there too.
7. If `review_task` sends changes back, you'll get a message. The task returns to in_progress with its files re-claimed.
<!-- hive:end -->
