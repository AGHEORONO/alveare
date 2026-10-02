#!/usr/bin/env node
// Hive hook forwarder (installed by `hive join` into <repo>/.hive/hook.mjs).
// Runs as an async Claude Code command hook: reads the hook JSON from stdin, keeps only a
// small whitelist of fields (never prompts or tool output), and POSTs it to the Hive server.
// Fire-and-forget: 1.5 s timeout, never prints, always exits 0.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const cfg = JSON.parse(readFileSync(join(here, 'config.json'), 'utf8'));
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  const e = JSON.parse(raw);
  const input = e.tool_input ?? {};

  const out = {
    hook_event_name: e.hook_event_name,
    session_id: e.session_id,
    cwd: e.cwd,
    agent_id: e.agent_id,
    agent_type: e.agent_type,
    source: e.source,
    reason: e.reason,
    tool_name: e.tool_name,
    task_title: e.task_title,
  };
  if (e.hook_event_name === 'PreToolUse') {
    out.description = typeof input.description === 'string' ? input.description : undefined;
    out.subagent_type = typeof input.subagent_type === 'string' ? input.subagent_type : undefined;
  }
  const fp = input.file_path ?? input.notebook_path;
  if (e.hook_event_name === 'PostToolUse' && typeof fp === 'string') {
    const abs = isAbsolute(fp) ? fp : resolve(e.cwd ?? cfg.repo_root, fp);
    const rel = relative(cfg.repo_root, abs);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) out.file_path = rel.split('\\').join('/');
  }

  await fetch(cfg.hook_url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.token}` },
    body: JSON.stringify(out),
    signal: AbortSignal.timeout(1500),
  });
}

main().catch(() => {}).finally(() => process.exit(0));
