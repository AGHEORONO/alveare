// Hive dashboard: one SSE stream delivers full state snapshots (at most ~1/s). Each section
// re-renders only when its markup changes, preserving focus, open <details> and unsaved selects
// so keyboard and screen-reader users keep their place. Live updates can be paused.
'use strict';

const $ = (id) => document.getElementById(id);
const COLUMNS = [
  ['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In progress'],
  ['blocked', 'Blocked'], ['review', 'Review'], ['done', 'Done'],
];
const ANNOUNCE_KINDS = new Set(['status', 'task_reviewed', 'leader_changed', 'agent_joined']);
let state = null;
let latest = null;      // newest snapshot, held while paused
let paused = false;
let lastFeedId = null;
let serverSkew = 0;     // server clock - local clock

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idSafe = (s) => encodeURIComponent(String(s)).replace(/[^\w-]/g, '_');
const icon = (ch) => `<span aria-hidden="true">${ch}</span>`;

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
const now = () => Date.now() + serverSkew;
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// ───────────── screen-reader announcements (batched every 2 s) ─────────────

let announceQueue = [];
let announceTimer = null;
function announce(msg) {
  announceQueue.push(msg);
  announceTimer ??= setTimeout(() => {
    const p = document.createElement('p');
    const q = announceQueue;
    p.textContent = q.length > 2 ? `${q.length} updates. Latest: ${q.at(-1)}` : q.join('. ');
    $('announcer').replaceChildren(p);
    announceQueue = [];
    announceTimer = null;
  }, 2000);
}

// ───────────── rendering ─────────────

function render() {
  if (!state) return;
  $('session').textContent = state.session;
  $('join-code').textContent = state.join_code;
  $('leader-name').textContent = state.leader.leader ?? 'none';
  document.title = `${state.session} · Hive`;
  renderBanner();
  patch('team-list', teamHtml());
  patch('board-cols', boardHtml());
  patch('unclaimed', unclaimedHtml());
  patch('claim-list', claimsHtml());
  patch('feed-list', feedHtml());
  announceNew();
  tick();
}

/**
 * Replace a container's markup only if it changed. Defers while a <select> inside is focused
 * (so an open picker isn't destroyed), keeps unsaved select values and open <details>, and
 * restores focus without scrolling: same id → enclosing card → section heading.
 */
function patch(id, html) {
  const el = $(id);
  if (el.__html === html) return;
  const active = document.activeElement;
  const inside = active && active !== el && el.contains(active);
  if (inside && active.tagName === 'SELECT') {
    if (el.__pending == null) {
      active.addEventListener('blur', () => setTimeout(() => {
        const h = el.__pending;
        el.__pending = null;
        if (h != null) patch(id, h);
      }), { once: true });
    }
    el.__pending = html;
    return;
  }
  const focusId = inside ? active.id : null;
  const holderId = inside ? active.closest('[id]:not(#' + id + ')')?.id : null;
  const dirty = [...el.querySelectorAll('select[id]')]
    .filter((s) => [...s.options].some((o) => o.selected !== o.defaultSelected))
    .map((s) => [s.id, s.value]);
  const open = [...el.querySelectorAll('details[open]')].map((d) => d.id);
  el.innerHTML = html;
  el.__html = html;
  for (const d of open) { const x = document.getElementById(d); if (x) x.open = true; }
  for (const [sid, v] of dirty) { const s = document.getElementById(sid); if (s) s.value = v; }
  if (inside) {
    const target = (focusId && document.getElementById(focusId))
      || (holderId && document.getElementById(holderId))
      || el.closest('section')?.querySelector('h2');
    target?.focus({ preventScroll: true });
  }
}

function renderBanner() {
  const l = state.leader;
  const b = $('banner');
  const key = l.propose ? `${l.leader}|${l.propose}` : '';
  if (b.__key === key) return;
  b.__key = key;
  if (!key) { b.hidden = true; b.replaceChildren(); return; }
  b.innerHTML = `<span><strong>Leader ${esc(l.leader)} has been offline for <span data-ago="${now() - l.offline_for_s * 1000}"></span>.</strong>
      Suggested new leader: ${esc(l.propose)}.</span>
    <button type="button" class="primary" id="banner-lead" data-action="set_leader" data-agent="${esc(l.propose)}">Make ${esc(l.propose)} leader</button>`;
  b.hidden = false;
  announce(`Leader ${l.leader} is offline. Suggested new leader: ${l.propose}.`);
}

function teamHtml() {
  if (!state.agents.length) return '<li class="empty">Nobody has joined yet.</li>';
  return state.agents.map((a) => {
    const status = a.online
      ? `<span class="badge b-online">online</span>${a.activity ? ` <span class="badge b-${a.activity}">${a.activity}</span>` : ''}`
      : `<span class="badge b-offline">offline · seen <span data-ago="${a.last_seen}"></span> ago</span>`;
    const tasks = a.tasks.length
      ? `<ul class="plain">${a.tasks.map((t) => `<li><a class="tap" id="tl-${idSafe(a.id)}-${t.id}" href="#task-${t.id}">#${t.id} ${esc(t.title)}</a> <span class="muted small">(${t.status.replace('_', ' ')})</span></li>`).join('')}</ul>`
      : '<span class="muted">no active task</span>';
    const subs = a.subagents.length ? `
      <ul class="subs" aria-label="Subagents of ${esc(a.name)}">
        ${a.subagents.map((s) => `<li>
          <strong>${esc(s.name)}</strong>
          <span class="badge ${s.status === 'running' ? 'b-working' : s.status === 'failed' ? 'b-bad' : 'b-idle'}">${s.status}</span>
          <span class="muted small" data-run-start="${s.started_at}" data-run-end="${s.ended_at ?? ''}"></span>
          ${s.purpose ? `<span class="purpose">${esc(s.purpose)}</span>` : ''}
        </li>`).join('')}
      </ul>` : '';
    return `<li class="card agent ${a.online ? '' : 'offline'}" id="agent-${idSafe(a.id)}" tabindex="-1">
      <div class="agent-head">
        <h3>${esc(a.name)}</h3>
        ${a.role === 'leader' ? `<span class="badge b-leader">${icon('★')} leader</span>` : ''}
        ${a.host ? '<span class="badge b-idle">host</span>' : ''}
        ${status}
      </div>
      <div class="small">${tasks}</div>
      <div class="muted small">${a.claims} claim${a.claims === 1 ? '' : 's'}</div>
      ${subs}
      ${a.role !== 'leader' ? `<div class="agent-actions"><button type="button" id="mk-leader-${idSafe(a.id)}" data-action="set_leader" data-agent="${esc(a.name)}">Make ${esc(a.name)} leader</button></div>` : ''}
    </li>`;
  }).join('');
}

function boardHtml() {
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const names = state.agents.map((a) => a.name);
  return COLUMNS.map(([status, label]) => {
    const tasks = state.tasks.filter((t) => t.status === status);
    return `<div class="col">
      <h3 id="col-${status}"><span>${label}</span> <span class="muted">${tasks.length}<span class="visually-hidden"> tasks</span></span></h3>
      ${tasks.length ? `<ul aria-labelledby="col-${status}">${tasks.map((t) => taskHtml(t, byId, names)).join('')}</ul>` : '<p class="empty">None</p>'}
    </div>`;
  }).join('');
}

function taskHtml(t, byId, names) {
  const deps = (t.deps ?? []).map((d) => {
    const id = parseInt(d, 10);
    const dep = byId.get(id);
    const done = dep?.status === 'done';
    return `<a href="#task-${id}" id="dep-${t.id}-${id}" class="badge tap ${done ? 'b-ok' : 'b-warn'}">${icon(done ? '✓' : '⏳')} needs #${id}${done ? ' (done)' : ` (${dep ? dep.status.replace('_', ' ') : '?'})`}</a>`;
  }).join(' ');
  const opts = (sel) => `<option value="">— agent —</option>` + names.map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const assignAction = t.status === 'open' || t.status === 'assigned' ? 'assign' : 'reassign';
  const controls = t.status === 'done' ? '' : `
    <div class="row">
      <label for="own-${t.id}">Owner</label>
      <select id="own-${t.id}">${opts(t.owner)}</select>
      <button type="button" id="own-btn-${t.id}" data-action="${assignAction}" data-id="${t.id}" data-from="own-${t.id}">${assignAction === 'assign' ? 'Assign' : 'Reassign'}</button>
    </div>
    <div class="row">
      <label for="st-${t.id}">Status</label>
      <select id="st-${t.id}">
        ${['open', 'assigned', 'in_progress', 'blocked', 'review', 'done'].map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
      </select>
      <button type="button" id="st-btn-${t.id}" data-action="set_status" data-id="${t.id}" data-from="st-${t.id}">Set</button>
    </div>
    ${t.status === 'review' ? `<div class="row">
      <button type="button" class="primary" id="ap-${t.id}" data-action="review" data-verdict="approve" data-id="${t.id}">Approve</button>
      <button type="button" id="rq-${t.id}" data-action="review" data-verdict="changes_requested" data-id="${t.id}">Request changes</button>
    </div>` : ''}`;
  return `<li class="card task" id="task-${t.id}" tabindex="-1">
    <div class="title">#${t.id} ${esc(t.title)}</div>
    <div class="meta">
      <span>${t.owner ? `${icon('👤')} ${esc(t.owner)}` : 'unowned'}</span>
      <span>P${t.pri}</span>
      ${t.status === 'blocked' ? '<span class="badge b-bad">blocked</span>' : ''}
    </div>
    ${deps ? `<div class="meta">${deps}</div>` : ''}
    <details id="det-${t.id}">
      <summary id="sum-${t.id}">Details and actions<span class="visually-hidden"> for #${t.id} ${esc(t.title)}</span></summary>
      ${t.description ? `<p class="desc">${esc(t.description)}</p>` : ''}
      ${t.acceptance ? `<p class="desc"><strong>Done when:</strong> ${esc(t.acceptance)}</p>` : ''}
      ${t.files.length ? `<ul class="files" aria-label="Expected files">${t.files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>` : ''}
      ${t.branch ? `<div class="small">Branch <code>${esc(t.branch)}</code></div>` : ''}
      ${t.review_notes ? `<p class="desc"><strong>Review notes:</strong> ${esc(t.review_notes)}</p>` : ''}
      ${controls}
    </details>
  </li>`;
}

function unclaimedHtml() {
  if (!state.unclaimed.length) return '';
  return `<div class="alert-box">
    <h3>${icon('⚠')} Edits to unclaimed files (last hour)</h3>
    <ul>${state.unclaimed.map((u) => `<li><strong>${esc(u.by)}</strong> edited <code>${esc(u.path)}</code>${u.count > 1 ? ` ${u.count} times` : ''}, last at ${clock(u.ts)}</li>`).join('')}</ul>
  </div>`;
}

function claimsHtml() {
  if (!state.claims.length) return '<p class="empty">No files are claimed.</p>';
  return `<div class="table-wrap" tabindex="0" role="region" aria-label="File claims table"><table>
    <caption class="visually-hidden">Active file claims</caption>
    <thead><tr><th scope="col">Path</th><th scope="col">Held by</th><th scope="col">Task</th><th scope="col">Expires</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
    <tbody>${state.claims.map((c) => `<tr>
      <td><code>${esc(c.path)}</code></td>
      <td>${esc(c.by)}</td>
      <td>${c.task ? `<a class="tap" id="ct-${idSafe(c.by + c.path)}" href="#task-${c.task}">#${c.task}</a>` : '—'}</td>
      <td>in <span data-until="${c.expires_at}"></span></td>
      <td><button type="button" class="danger" id="rel-${idSafe(c.by + ':' + c.path)}" data-action="release" data-path="${esc(c.path)}" aria-label="Unlock ${esc(c.path)} held by ${esc(c.by)}">Unlock</button></td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function feedHtml() {
  if (!state.feed.length) return '<li class="empty">Nothing yet.</li>';
  return state.feed.map((f) => `<li class="k-${f.kind} ${f.flag ? 'flagged' : ''}">
    <time datetime="${new Date(f.ts).toISOString()}">${clock(f.ts)}</time>
    <span>${f.flag ? '<strong class="flag-label">Flagged:</strong> ' : ''}<span class="who">${esc(f.who ?? 'hive')}</span> <span class="text">${esc(f.text)}</span>${f.task && !/#\d/.test(f.text) ? ` <a class="tap" id="fl-${f.id}" href="#task-${f.task}">#${f.task}</a>` : ''}</span>
  </li>`).join('');
}

/** Announce only important new events to screen readers (not every edit). */
function announceNew() {
  const newest = state.feed[0]?.id ?? 0;
  if (lastFeedId !== null) {
    const fresh = state.feed.filter((f) => f.id > lastFeedId && (ANNOUNCE_KINDS.has(f.kind) || f.flag)).reverse();
    for (const f of fresh) announce(`${f.flag ? 'Flagged: ' : ''}${f.who ?? 'hive'} ${f.text}`);
  }
  lastFeedId = newest;
}

/** Live-updating relative times without re-rendering markup. */
function tick() {
  const n = now();
  for (const el of document.querySelectorAll('[data-ago]')) el.textContent = dur(n - Number(el.dataset.ago));
  for (const el of document.querySelectorAll('[data-until]')) el.textContent = dur(Number(el.dataset.until) - n);
  for (const el of document.querySelectorAll('[data-run-start]')) {
    const end = el.dataset.runEnd ? Number(el.dataset.runEnd) : n;
    el.textContent = `${el.dataset.runEnd ? 'ran' : 'running'} ${dur(end - Number(el.dataset.runStart))}`;
  }
}
setInterval(tick, 1000);

// ───────────── actions ─────────────

function toast(msg) {
  $('toast-msg').textContent = msg;
  $('toast').hidden = false;
  document.body.classList.add('has-toast');
}
function hideToast() {
  $('toast').hidden = true;
  document.body.classList.remove('has-toast');
}
$('toast-close').addEventListener('click', hideToast);

async function act(body, success) {
  hideToast();
  const res = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (!res) return toast("Can't reach the Hive host. Check the connection.");
  if (res.status === 401) return showLogin();
  const r = await res.json().catch(() => ({}));
  if (!r.ok) toast(`${r.message ?? r.error ?? 'Action failed'}${r.do ? ` — ${r.do}` : ''}`);
  else if (success) announce(success);
  return r;
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const d = btn.dataset;
  const id = d.id ? Number(d.id) : undefined;
  switch (d.action) {
    case 'assign':
    case 'reassign': {
      const agent = $(d.from).value;
      if (!agent) return toast('Pick an agent first.');
      return act({ action: d.action, id, agent }, `Task ${id} ${d.action}ed to ${agent}`);
    }
    case 'set_status': {
      const status = $(d.from).value;
      const note = status === 'blocked' ? prompt('Why is it blocked?') : undefined;
      if (status === 'blocked' && !note) return;
      return act({ action: 'set_status', id, status, note }, `Task ${id} set to ${status.replace('_', ' ')}`);
    }
    case 'review': {
      const notes = d.verdict === 'changes_requested' ? prompt('What needs to change?') : undefined;
      if (d.verdict === 'changes_requested' && !notes) return;
      return act({ action: 'review', id, verdict: d.verdict, notes }, `Task ${id} ${d.verdict === 'approve' ? 'approved' : 'sent back'}`);
    }
    case 'release':
      if (!confirm(`Unlock ${d.path}? The holder will be notified.`)) return;
      return act({ action: 'release', path: d.path }, `Unlocked ${d.path}`);
    case 'set_leader':
      if (!confirm(`Make ${d.agent} the leader?`)) return;
      return act({ action: 'set_leader', agent: d.agent }, `${d.agent} is now leader`);
  }
});

$('rotate').addEventListener('click', async () => {
  if (!confirm('Generate a new join code? The old one stops working for new joins (connected agents are unaffected).')) return;
  act({ action: 'rotate_code' }, 'New join code generated');
});

$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').setAttribute('aria-pressed', String(paused));
  $('pause').textContent = paused ? 'Resume live updates' : 'Pause live updates';
  if (!paused && latest) { state = latest; render(); }
  announce(paused ? 'Live updates paused' : 'Live updates resumed');
});

// ───────────── connection ─────────────

let source = null;
function setConn(text, cls) {
  const c = $('conn');
  if (c.textContent === text) return;
  c.textContent = text;
  c.className = `conn ${cls}`;
}

function connect() {
  source?.close();
  source = new EventSource('/api/stream');
  source.onopen = () => {
    if ($('conn').classList.contains('down')) announce('Reconnected');
    setConn('live', 'live');
  };
  source.onmessage = (ev) => {
    latest = JSON.parse(ev.data);
    serverSkew = latest.now - Date.now();
    if (paused) { setConn('paused', 'paused'); return; }
    state = latest;
    render();
  };
  source.onerror = async () => {
    if (!$('conn').classList.contains('down')) announce('Connection lost, reconnecting');
    setConn('reconnecting…', 'down');
    const r = await fetch('/api/state').catch(() => null);
    if (r?.status === 401) { source.close(); showLogin(); }
  };
}

function showLogin() {
  source?.close();
  $('app').hidden = true;
  $('login').hidden = false;
  $('code').focus();
}

function loginError(msg) {
  const input = $('code');
  input.setAttribute('aria-invalid', 'true');
  $('login-error').textContent = '';
  setTimeout(() => { $('login-error').textContent = msg; }, 50); // re-announce repeated errors
  input.focus();
  input.select();
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: $('code').value }) }).catch(() => null);
  if (!res) return loginError("Can't reach the Hive host. Check your connection and try again.");
  if (!res.ok) return loginError(res.status === 429 ? 'Too many tries. Wait one minute.' : 'That join code is not valid. Check the host terminal.');
  $('code').removeAttribute('aria-invalid');
  $('login-error').textContent = '';
  start();
});

async function start() {
  const r = await fetch('/api/state').catch(() => null);
  if (!r || r.status === 401) return showLogin();
  state = latest = await r.json();
  $('login').hidden = true;
  $('app').hidden = false;
  render();
  connect();
}

start();
