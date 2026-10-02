# Alveare 🐝

*Alveare* is Italian for "beehive" (from the Latin *alvearium*).

Alveare lets a small team vibe code together on one git repo, each person with their own AI coding agent:
- the agents **split the work** into tasks
- they **claim files** so they never overwrite each other
- they **message each other**
- one of them is the **queen** (the leader): it plans, assigns and reviews

You and your friends watch the whole colony live from a dashboard on any laptop or phone.

It works with **any AI tool that supports MCP**, not just Claude: Claude Code, Cursor, Gemini CLI, Codex CLI, VS Code Copilot, and anything else that speaks MCP.
It runs entirely on your local network. There is no cloud and no accounts, so it works at hackathons with bad or no internet.

```
 laptop A (host)                      laptops B, C, D (any AI tool)
 ┌──────────────────────┐             ┌──────────────────────────┐
 │ alveare host          │◄── MCP ─────│ Claude / Cursor / Gemini │  tasks, claims, messages
 │  • MCP  /mcp          │◄── hooks ───│ (Claude Code only)       │  live edits & subagents
 │  • dashboard  /       │◄── SSE ─────│ browser / phone          │  watch + override
 │  • one SQLite file    │             └──────────────────────────┘
 └──────────────────────┘
```

## Install (one line)

**macOS / Linux**
```bash
curl -fsSL https://raw.githubusercontent.com/AGHEORONO/alveare/main/client/install.sh | sh
```

**Windows (PowerShell)**
```powershell
irm https://raw.githubusercontent.com/AGHEORONO/alveare/main/client/install.ps1 | iex
```

The installer downloads a single `alveare` executable into `~/.alveare/bin` and adds it to your PATH. You don't need Node or npm.

Prefer npm? `git clone` this repo, then run `npm install && npm link`. You'll need Node 24 or newer.

## Use it (two commands)

**Host**: one person runs this inside the project repo. The host's agent becomes the queen.
```bash
alveare host
```
It prints:
- a 6-letter **join code**
- the **dashboard URL**
- ready-to-copy join lines for your teammates

**Teammates** run this inside their clone of the project repo:
```bash
alveare join
```
`alveare join`:
1. finds the hive on the Wi-Fi
2. asks for the code
3. asks which AI tool you use
4. sets that tool up

Then restart your AI tool and tell it **"start hive workflow"**.

**A teammate with nothing installed** can install and join in one line. The host's terminal prints this with the address and code filled in, and it even downloads the program from the host, so no internet is needed if they're on the same OS:
```bash
curl -fsSL http://192.168.1.20:4747/install.sh | sh -s -- 192.168.1.20:4747 K7QW3M                          # macOS/Linux
& ([scriptblock]::Create((irm http://192.168.1.20:4747/install.ps1))) 192.168.1.20:4747 K7QW3M            # Windows
```

**If the Wi-Fi blocks discovery**, use the address directly: `alveare join 192.168.1.20:4747 --code K7QW3M`.

**Something not working?** Run `alveare doctor` in the repo. It checks, with a fix for each problem:
- whether this repo has joined a hive
- whether the host can be reached, and how fast
- whether your token is still valid
- whether each AI tool is configured
- whether the Claude hooks are installed
- whether mDNS can see the hive
- on Windows, whether your Wi-Fi is set to "Public", which blocks teammates from connecting to you

## Supported AI tools

Choose one or more with `--client`, e.g. `alveare join --client cursor,gemini`, or pick from the list `join` shows you.

| `--client` | Tool | MCP config `join` writes | Instructions it reads | Live edit tracking |
|---|---|---|---|---|
| `claude` | Claude Code | `claude mcp add` (local scope) | `CLAUDE.md` | ✅ via hooks (checked against real Claude Code payloads) |
| `cursor` | Cursor | `.cursor/mcp.json` | `AGENTS.md`, `.cursor/rules/alveare.mdc` | — |
| `vscode` | VS Code + GitHub Copilot (agent mode) | `.vscode/mcp.json` | `AGENTS.md`, `.github/copilot-instructions.md` | — |
| `gemini` | Gemini CLI | `.gemini/settings.json` | `GEMINI.md` | — |
| `codex` | OpenAI Codex CLI | `~/.codex/config.toml` | `AGENTS.md` | — |
| `opencode` | opencode (works with free models) | `opencode.json` | `AGENTS.md` | — |
| `other` | anything that speaks MCP over HTTP | prints the URL and header to paste | `AGENTS.md` | — |

- **Tokens stay off GitHub.** Every config file that holds your personal token is added to `.git/info/exclude`, so it never gets committed. The instruction files (`AGENTS.md` and friends) contain no secrets and are meant to be shared.
- **Friends without Claude** can use a tool with a free tier: Gemini CLI, Copilot in VS Code, Cursor, or opencode with its free models. They join the same hive as everyone else.
- **Tested for real:** an opencode agent on a free model, acting as queen, planned a task. A Codex agent, as a worker, claimed it and messaged the queen, and the queen read the message and replied, all through the hive.
- **No approval prompt on every call:** hive tools only change hive state (tasks, claims, messages), never your files. So `join` pre-approves them for Codex (`default_tools_approval_mode`) and Gemini (`trust`), and marks the read-only ones with standard MCP hints.
- **What works for every tool:**
  - tasks, file claims, messages and leader rules (all enforced by the server)
  - the queen role
  - showing as online on the dashboard
- **What only Claude Code adds:** live subagent ("drone") tracking, and flags when an agent edits a file it hasn't claimed. Other tools don't expose the hooks this needs.

## How the AIs talk to each other

The agents never connect to each other directly. Everything goes through the hive server, like bees through the hive:

1. **Shared state, not chat.** Every agent calls the same MCP tools on the host:
   - `list_tasks`, `claim_task`, `update_task`
   - `claim_files`, `check_files`
   - `send_message`, `read_messages`

   The server is the single source of truth. It handles one request at a time inside a database transaction, so if two agents grab the same task or file at the same moment, exactly one wins.
2. **Files are coordinated by claims.** Before editing, an agent claims files: paths, folders or globs. If someone else holds one, the tool answers with who holds it and what to do instead, for example:
   ```json
   {"ok":false,"error":"conflict","held":[{"path":"src/api/users.ts","by":"ben","task":1}],"do":"message ben or leader; free ready tasks: 3, 4"}
   ```
   Claims expire about 10 minutes after the agent goes silent, so a crashed laptop never locks files forever.
3. **Messages are a mailbox.**
   - `send_message(to: "ben" | "leader" | "all", body)` drops a message in the hive.
   - Agents **pull** messages with `read_messages`. The workflow tells them to check between steps.

   There's no push into an AI's chat, because MCP tools can't interrupt a running agent. Instead, **every hive tool result carries `"inbox": N`** when there is unread mail, and `"reviews_waiting": N` for the queen. So an agent notices new messages the next time it does anything. Messages to `"leader"` go to whoever is queen when they're read, so they survive a leadership change.
4. **The queen coordinates.**
   - She uses `plan_feature` to create tasks, with dependencies and the files each task expects to touch.
   - She assigns tasks to the bees that are online.
   - She reviews finished work (`review_task`) and posts status updates.

   Workers can't use those tools; the server refuses.
5. **The workflow is in plain English.** `join` writes a short "Alveare team workflow" section into each tool's instruction file (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`…). That's what makes any model follow the same protocol.
6. **Humans can override anything** from the dashboard: reassign tasks, unlock files, change the queen.

## Dashboard

Open the printed URL on any device and enter the join code.

| Area | What it shows |
|---|---|
| **The colony** | each bee (agent): queen or worker, online/working/idle, current task, and its live **drones** (subagents) with purpose and runtime |
| **The comb** | the task board: Open, Assigned, In progress, Blocked, Review, Done ("capped"). Dependency badges, assign/reassign, approve/request changes. Tasks whose owner went silent get an **owner silent** chip. |
| **Ready to merge** | branches the queen approved, with a copyable merge command and a **Mark merged** button for the human doing the merge |
| **Waggle feed** | messages, status posts, task moves and file edits, filterable. Edits to unclaimed files are flagged in red. |
| **Claimed cells** | who holds which files, with an **Unlock** button |

- **Queen health:** if the queen is offline for more than 5 minutes, a banner suggests a new queen for a human to confirm.
- **Silent workers:** when a worker goes quiet while holding a task, the queen's next tool result lists it under `stale_tasks` so she can reassign it.
- **Look and feel:** dark and light themes, a phone layout with a bottom tab bar, and motion such as cards gliding between columns and new events dropping in. Motion turns off if your system asks for reduced motion.
- **Accessibility:** works fully with a keyboard and a screen reader.

## Host handover
```bash
alveare export                                      # snapshot the hive → alveare-YYYY-MM-DD-HH-MM.hive
alveare export --from 192.168.1.20:4747 --every 5   # any teammate: rolling backup in case the host crashes
alveare import alveare-….hive && alveare host       # on the new host laptop
alveare join --rehost 192.168.1.31:4747             # every teammate: point at the new host
```
Tasks, claims, messages, the queen and the join code all carry over, and **existing tokens keep working**.

## Network trouble at hackathons
1. **`alveare join` finds nothing.** Venue Wi-Fi often blocks device-to-device discovery. Use the address the host printed.
2. **The address doesn't connect either.** The network isolates laptops from each other. Two options:
   - **Phone hotspot:** one phone, everyone on it. Alveare needs almost no bandwidth.
   - **Tailscale:** install it before the event, put everyone in one tailnet, and join `100.x.y.z:4747`.
3. **Windows host:**
   - set the Wi-Fi network to **Private**
   - allow Alveare/Node through the firewall on Private networks when Windows asks
   - if you dismissed that prompt, run this in an admin PowerShell: `New-NetFirewallRule -DisplayName "Alveare 4747" -Direction Inbound -Protocol TCP -LocalPort 4747 -Action Allow -Profile Private`

## Testing with a second laptop (checklist)
1. **Both laptops:** Alveare installed (`alveare version`), an AI tool installed, on the **same SSID**.
2. **Host:** run `alveare host` in the project repo. Note the IP and the code. On Windows, allow the firewall prompt (Private networks).
3. **Laptop 2:** open `http://<host-ip>:4747/api/info` in a browser. You should see `{"name":"hive",…}`. If not, it's a network or firewall problem; see above.
4. **Laptop 2:** run `alveare join`. If discovery finds nothing, run `alveare join <host-ip>:4747 --code <code>`.
5. **Laptop 2:** restart the AI tool. Then:
   - **Claude Code:** `claude mcp list` should show `hive … ✔ Connected`.
   - **Gemini CLI / Codex:** `/mcp` should list `hive`.
   - **Cursor / VS Code:** enable `hive` in the MCP settings or view.
6. Ask the agent to run `whoami`. Expected role: `member` (a worker).
7. **Dashboard** (on a phone too): the bee shows online. With Claude Code, an edit to an unclaimed file shows up flagged in the waggle feed.
8. **Host's agent:** "start hive workflow" with a small goal. Check that it plans tasks, assigns one to laptop 2, and laptop 2 picks it up.

## Security notes
- Anyone on the network who has the join code can join and view the dashboard. Click **New** on the dashboard to rotate the code. Wrong codes are rate-limited.
- Hooks send only event names, ids, tool names, repo-relative paths and subagent descriptions. **Prompts, file contents and tool output never leave your laptop.**
- **The executables are unsigned.** Windows SmartScreen may warn you: click "More info", then "Run anyway". The macOS installer clears the quarantine flag.

## Development
```bash
npm install
npm test            # unit + server tests (node:test)
npm run sim         # 1 queen + 3 workers racing for overlapping tasks over real MCP
npm run build:exe   # standalone executable for this OS → release/
```

**Layout:**
- `src/core`: domain logic on Node's built-in SQLite. Every operation is one transaction.
- `src/server`: HTTP, MCP (stateless streamable HTTP, bound to the caller's token), SSE and mDNS.
- `client/`: zero-dependency join client, installers, hook forwarder and the workflow snippet. The host serves these too.
- `public/`: the dashboard. No build step. Fonts are bundled, so it works offline.

**Releases:** push a tag (`git tag v0.2.0 && git push --tags`) and GitHub Actions builds executables for Windows, macOS and Linux and attaches them to the release.

**Runtime dependencies:** `@modelcontextprotocol/sdk`, `zod`, `bonjour-service`.

**Licenses:** the fonts (Fraunces, Instrument Sans, JetBrains Mono) are under the SIL Open Font License.
