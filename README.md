# Hive

Hive lets a small team, each running their own Claude Code on their own laptop, work together on one git repo:
- agents split work into tasks
- they claim files so they don't overwrite each other
- they message each other
- one agent acts as leader: it plans, assigns and reviews

Everything runs on the local network. There is no cloud and no accounts.

```
 laptop A (host)              laptop B, C, D
 ┌──────────────────┐         ┌──────────────┐
 │ hive host        │◄─MCP────│ Claude Code  │  hive tools (tasks, claims, messages)
 │  MCP  /mcp       │◄─hooks──│ .hive/hook   │  session, edit and subagent events
 │  dashboard  /    │◄─SSE────│ browser/phone│  live team view + human overrides
 │  SQLite file     │         └──────────────┘
 └──────────────────┘
```

## Requirements
- Node.js 22 or newer, git, and Claude Code on every laptop.
- **Install before the event, while you still have internet.** `better-sqlite3` downloads a prebuilt binary during `npm install`.

```bash
git clone <this repo> hive && cd hive && npm install     # builds dist/ automatically
npm link                                                 # optional: puts `hive` on PATH
```

## Quick start (about 2 minutes)

**Host.** Run this in your clone of the *project* repo. The host becomes the leader.
```bash
hive host                 # or: node /path/to/hive/dist/cli.js host
```
It prints:
- a 6-character **join code**
- the dashboard URLs
- copy-paste join commands for teammates

It also connects the host's own Claude Code.

**Teammates.** Run this in your clone of the project repo:
```bash
hive join                          # finds the host via mDNS, then asks for the code
hive join 192.168.1.20:4747 --code K7QW3M --name sam   # manual fallback
```

**A teammate without Hive installed** (offline is fine, it downloads from the host):
```bash
curl -fsSL http://192.168.1.20:4747/join.mjs -o hive-join.mjs     # PowerShell: curl.exe
node hive-join.mjs 192.168.1.20:4747 K7QW3M sam
```

Then **restart Claude Code** in the repo and say: **"start hive workflow"**.

### What `join` changes in your repo
| File | Contents | Committed? |
|---|---|---|
| `.hive/config.json`, `.hive/hook.mjs` | your token and the hook forwarder | no (added to `.git/info/exclude`) |
| `.claude/settings.local.json` | the Hive hooks, merged with your existing settings | no (machine-local) |
| Claude MCP config, `local` scope | `hive` server and your token | no (stored in `~/.claude.json`) |
| `CLAUDE.md` | the team workflow, between `<!-- hive:start/end -->` markers | yes, shared with the team |

Running join again replaces Hive's entries and leaves everything else alone.

## Roles and tools
Every agent can use:
- `whoami`, `list_agents`, `heartbeat`
- `list_tasks`, `get_task`, `claim_task`, `update_task`
- `claim_files`, `release_files`, `check_files`
- `send_message`, `read_messages`
- `report_subagent`

**Leader only** (enforced by the server):
- `plan_feature`, `create_task`, `assign_task`, `reassign_task`
- `review_task`, `force_release`, `post_status`, `transfer_leadership`

**Tool results** are short JSON. Failures name who holds what and say what to do instead. For example:
```json
{"ok":false,"error":"conflict","held":[{"path":"src/api/users.ts","held":"src/api/**","by":"ben","task":1}],
 "do":"message ben or leader; free ready tasks: 3, 4"}
```

**Task status flow:** open → assigned → in_progress → review → done. Separately, blocked can be set from any status except done.
- `claim_task` atomically claims the task's declared files and returns its branch name, `task/<id>-<slug>`.
- Setting `review` releases those claims and notifies the leader.
- Only `review_task` sets done. **Humans merge** after approval.

**File claims** can be:
- paths, `dir/` (meaning everything below it), or globs (`src/**/*.ts`)
- matched case-insensitively

Claims expire after 10 minutes of silence (`--claim-ttl`). Any activity renews them: a Hive call or any hook event. A crashed session can't lock files forever.

**Plans:** the server can't run an LLM, so the leader agent writes the breakdown. `plan_feature(description)` with no tasks returns a template and the list of online agents. Calling it again with `tasks[]` creates the whole plan at once. Dependencies between tasks use local keys, circular dependencies are rejected, and overlapping file sets get a warning.

## Dashboard
Open `http://<host-ip>:4747/` on any laptop or phone and enter the join code. It shows:
- **Team:** each agent with role, online/working/idle status, current task, and live **subagents** (purpose and runtime)
- **Tasks:** a kanban board with dependency badges. Each card lets you assign, reassign, set status, approve or request changes.
- **File claims:** who holds what, with an **Unlock** button. Edits to **unclaimed files** are flagged in red.
- **Activity:** messages, status posts, task transitions and file edits
- **Leader health:** if the leader is offline for more than 5 minutes, a banner suggests a new leader for a human to confirm. You can also use "Make X leader" at any time.
- **Pause live updates**, **Export**, and **New code** (rotate the join code)

## Observability: the hooks
`join` installs async command hooks. They run in the background, so a slow or unreachable host never blocks Claude Code. The forwarder gives up after 1.5 s and always exits 0.

| Event | Used for |
|---|---|
| `SessionStart` / `SessionEnd` | online sessions |
| `PreToolUse` (`Agent\|Task`) → `SubagentStart` / `SubagentStop` | subagent tree, with its purpose taken from the launch description |
| `PostToolUse` (`Edit\|Write\|MultiEdit\|NotebookEdit`) | file-edit feed and unclaimed-edit flags (edits by subagents are attributed to them) |
| `Stop` | working / idle |
| `TaskCompleted` | Claude's internal todos, shown in the feed |

Only whitelisted fields are sent: event name, ids, tool name, repo-relative path and the subagent description. **Prompts, file contents and tool output never leave your laptop.**

**Known limits:**
- Files changed through Bash (sed, code generators) are not seen as edits.
- If hooks aren't installed, agents can call `report_subagent` by hand.

## Host handover
```bash
hive export                                   # on the host: snapshot → hive-YYYY-MM-DD-HH-MM.hive
hive export --from 192.168.1.20:4747 --every 5   # any member: rolling backup in case the host crashes
hive import hive-….hive && hive host          # on the new host
hive join --rehost 192.168.1.31:4747          # every teammate: point at the new host
```
Tasks, claims, messages, the leader and the join code all carry over. **Existing tokens keep working**, so teammates only change the address. The new host's own agent joins as a member. Transfer leadership from the dashboard if needed.

## Network trouble at hackathons
1. **mDNS finds nothing.** Venue Wi-Fi often blocks device-to-device discovery. Use the manual address the host printed: `hive join IP:4747 --code …`.
2. **Manual address doesn't connect either.** Client isolation blocks all laptop-to-laptop traffic. Two options:
   - **Phone hotspot:** one phone, everyone joins its hotspot, and the host shares its hotspot IP. Hive needs almost no bandwidth.
   - **Tailscale:** install it before the event, put everyone in one tailnet, then `hive join 100.x.y.z:4747`. It works across any network, but it needs internet to connect.
3. **Windows host:** see step 2 of the checklist below.

## Testing with a second laptop on the same Wi-Fi (checklist)
1. **Both laptops:**
   - `node -v` shows 22 or newer
   - `claude --version` works
   - both are on the **same SSID**, not "guest" vs "main"
2. **Windows host:**
   - Wi-Fi profile set to **Private**: Settings → Network → Wi-Fi → your network
   - when the firewall prompt appears for Node.js on the first `hive host`, allow it on **Private networks**
   - if you dismissed that prompt, run this in an admin PowerShell: `New-NetFirewallRule -DisplayName "Hive 4747" -Direction Inbound -Protocol TCP -LocalPort 4747 -Action Allow -Profile Private`
3. **macOS host:** allow "node" to accept incoming connections when prompted. Also check System Settings → Network → Firewall.
4. **Host:** run `hive host` in the project repo. Note the IP and the code.
5. **Laptop 2, reachability:** open `http://<host-ip>:4747/api/info` in a browser. You should see `{"name":"hive",…}`. If not, the problem is network or firewall, not Hive. Go back to steps 2–3, or switch to the hotspot.
6. **Laptop 2, join:** `hive join` (mDNS). If it finds nothing, use `hive join <host-ip>:4747 --code <code>`. Expect four ✓ lines.
7. **Laptop 2:** `claude mcp list` should show `hive: http://<host-ip>:4747/mcp (HTTP) - ✔ Connected`.
8. **Laptop 2:** start Claude Code and ask it to run `whoami`. Expected role: `member`.
9. **Dashboard:** the agent appears **online**. Ask Claude on laptop 2 to edit a file it hasn't claimed. It should show up in the feed within about a second, flagged **unclaimed**.
10. **Leader (host's Claude):** "start hive workflow" with a small goal. Check that it creates tasks, assigns one to laptop 2, and laptop 2 picks it up.
11. **Phone:** open the dashboard URL on the same Wi-Fi and enter the code.
12. **Kill test:** close laptop 2's Claude Code. Its claims disappear after the TTL (10 min, or start the host with `--claim-ttl 1` while testing).

## Development
```bash
npm test          # unit + server tests (node:test)
npm run sim       # 1 leader + 3 MCP clients racing for overlapping tasks
npm run build     # tsc → dist/
```
**Layout:**
- `src/core`: domain logic and SQLite. One transaction per operation, so races are impossible.
- `src/server`: HTTP, MCP (stateless streamable HTTP, one server per request bound to the caller's token), SSE and mDNS.
- `client/`: zero-dependency join client, hook forwarder and CLAUDE.md snippet. The host serves these files too.
- `public/`: the dashboard. No build step.

**Dependencies:** `@modelcontextprotocol/sdk`, `zod`, `better-sqlite3`, `bonjour-service`.
