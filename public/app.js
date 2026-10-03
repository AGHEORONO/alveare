// Alveare dashboard. One SSE stream delivers full state snapshots (at most ~1/s). Each section
// re-renders only when its markup changes, preserving focus, open <details> and unsaved selects.
// Motion: task cards glide between columns (FLIP), new feed items drop in, finished tasks get
// "capped". Everything respects prefers-reduced-motion.
'use strict';

const $ = (id) => document.getElementById(id);
const COLUMNS = [
  ['open', 'Open'], ['assigned', 'Assigned'], ['in_progress', 'In progress'],
  ['blocked', 'Blocked'], ['review', 'Review'], ['done', 'Done · capped'],
];
const ANNOUNCE_KINDS = new Set(['status', 'task_reviewed', 'leader_changed', 'agent_joined']);
const FILTERS = {
  all: () => true,
  messages: (f) => f.kind === 'message' || f.kind === 'status',
  edits: (f) => f.kind === 'edit',
  flags: (f) => !!f.flag,
};
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let state = null;
let latest = null;          // newest snapshot, held while paused
let paused = false;
let filter = 'all';
let lastFeedId = null;      // for announcements
let seenFeedId = null;      // for drop-in animation
let prevStatus = new Map(); // task id → status, for the "capped" animation
let serverSkew = 0;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const idSafe = (s) => encodeURIComponent(String(s)).replace(/[^\w-]/g, '_');
const initial = (n) => esc(String(n ?? '?').trim().charAt(0).toUpperCase() || '?');
const ICON = {
  drone: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><ellipse cx="12" cy="14" rx="5" ry="6"/><path d="M7 13H17M7.5 16.5H16.5M9 7C6 3 3 5 5 8M15 7C18 3 21 5 19 8"/></svg>',
  crown: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" style="width:14px;height:14px"><path d="M3 8L7.5 12L12 5L16.5 12L21 8L19 18H5Z"/></svg>',
  cell: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L21 7V17L12 22L3 17V7Z"/></svg>',
  warn: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3L22 20H2ZM12 10V14M12 17V17.5"/></svg>',
};

function dur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}
const now = () => Date.now() + serverSkew;
const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// ───────────── theme ─────────────

function storageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function storageSet(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } }
function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]').content = t === 'light' ? '#FBF6EA' : '#14110B';
  $('theme').setAttribute('aria-label', t === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
}
applyTheme(storageGet('alveare-theme') ?? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'));
$('theme').addEventListener('click', () => {
  const t = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(t);
  storageSet('alveare-theme', t);
});

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
  $('indep').setAttribute('aria-checked', String(state.independent_queen !== false));
  document.title = `${state.session} · Alveare`;
  const online = state.agents.filter((a) => a.online).length;
  $('colony-count').textContent = `${state.agents.length} bee${state.agents.length === 1 ? '' : 's'} · ${online} online`;
  const done = state.tasks.filter((t) => t.status === 'done').length;
  $('comb-count').textContent = state.tasks.length ? `${done} of ${state.tasks.length} capped` : '';
  const flags = state.feed.filter((f) => f.flag).length;
  $('flag-count').textContent = flags ? `· ${flags}` : '';

  renderBanner();
  patch('team-list', teamHtml());
  flip('board-cols', () => patch('board-cols', boardHtml()));
  patch('merge-wrap', mergeHtml());
  patch('unclaimed', unclaimedHtml());
  patch('claim-list', claimsHtml());
  patch('feed-list', feedHtml());
  seenFeedId = state.feed[0]?.id ?? 0;
  prevStatus = new Map(state.tasks.map((t) => [t.id, t.status]));
  announceNew();
  tick();
}

/**
 * Replace a container's markup only if it changed. Defers while a <select> inside is focused,
 * keeps unsaved select values and open <details>, and restores focus without scrolling:
 * same id → enclosing card → section heading.
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
  const holderId = inside ? active.closest(`[id]:not(#${id})`)?.id : null;
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

/** FLIP: cards keep their identity across re-renders and glide from their old position. */
function flip(containerId, update) {
  const box = $(containerId);
  if (reducedMotion.matches) return update();
  const before = new Map([...box.querySelectorAll('[data-flip]')].map((el) => [el.dataset.flip, el.getBoundingClientRect()]));
  update();
  for (const el of box.querySelectorAll('[data-flip]')) {
    const old = before.get(el.dataset.flip);
    if (!old) continue;
    const r = el.getBoundingClientRect();
    const dx = old.left - r.left, dy = old.top - r.top;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 280, easing: 'cubic-bezier(.2,.8,.2,1)' });
  }
}

function renderBanner() {
  const l = state.leader;
  const b = $('banner');
  const key = l.propose ? `${l.leader}|${l.propose}` : '';
  if (b.__key === key) return;
  b.__key = key;
  if (!key) { b.hidden = true; b.replaceChildren(); return; }
  b.innerHTML = `<span><strong>The queen (${esc(l.leader)}) has been offline for <span data-ago="${now() - l.offline_for_s * 1000}"></span>.</strong>
      Suggested new queen: ${esc(l.propose)}.</span>
    <button type="button" class="btn honey" id="banner-lead" data-action="set_leader" data-agent="${esc(l.propose)}">Crown ${esc(l.propose)}</button>`;
  b.hidden = false;
  announce(`Leader ${l.leader} is offline. Suggested new leader: ${l.propose}.`);
}

function teamHtml() {
  if (!state.agents.length) return '<li class="empty">No bees yet. Share the join code.</li>';
  return state.agents.map((a) => {
    const queen = a.role === 'leader';
    const status = !a.online
      ? `<span class="status"><span class="dot"></span>Offline · seen <span data-ago="${a.last_seen}"></span> ago</span>`
      : `<span class="status"><span class="dot ${a.activity ?? 'idle'}"></span>${a.activity === 'working' ? 'Working' : a.activity === 'idle' ? 'Idle' : 'Online'}</span>`;
    const tasks = a.tasks.length
      ? a.tasks.map((t) => `<a id="tl-${idSafe(a.id)}-${t.id}" href="#task-${t.id}">#${t.id} ${esc(t.title)} · ${t.status.replace('_', ' ')}</a>`).join('')
      : `<span class="meta">${queen ? 'Leading the colony' : 'No active task'}</span>`;
    const drones = a.subagents.length ? `<ul class="drones" aria-label="Drones (subagents) of ${esc(a.name)}">
      ${a.subagents.map((s) => `<li class="drone ${s.status === 'running' ? '' : 'done'}">
        <div class="drone-head">${ICON.drone}<strong>Drone · ${esc(s.name)}</strong>
          <span class="drone-time" data-run-start="${s.started_at}" data-run-end="${s.ended_at ?? ''}"></span></div>
        ${s.purpose ? `<div class="drone-purpose">${esc(s.purpose)}</div>` : ''}
        <div class="stripe" aria-hidden="true"></div>
      </li>`).join('')}
    </ul>` : '';
    return `<li class="bee ${queen ? 'queen-bee' : ''} ${a.online ? '' : 'away'}" id="agent-${idSafe(a.id)}" tabindex="-1">
      <div class="bee-head">
        <div class="hexav" aria-hidden="true">${initial(a.name)}</div>
        <div class="bee-name">
          <div><strong>${esc(a.name)}</strong>
            ${queen ? `<span class="chip queen-chip">${ICON.crown} Queen</span>` : '<span class="chip">Worker</span>'}
            ${a.host ? '<span class="chip">host</span>' : ''}</div>
          ${status}
        </div>
      </div>
      <div class="bee-task">${tasks}</div>
      ${drones}
      <div class="bee-foot">
        <span class="meta">${a.claims} claimed cell${a.claims === 1 ? '' : 's'}</span>
        ${queen ? '' : `<button type="button" class="btn ghost small" id="mk-leader-${idSafe(a.id)}" data-action="set_leader" data-agent="${esc(a.name)}">Crown ${esc(a.name)}</button>`}
      </div>
    </li>`;
  }).join('');
}

function boardHtml() {
  const byId = new Map(state.tasks.map((t) => [t.id, t]));
  const names = state.agents.map((a) => a.name);
  return COLUMNS.map(([status, label]) => {
    const tasks = state.tasks.filter((t) => t.status === status);
    return `<div class="col">
      <div class="col-head"><h3 id="col-${status}">${label}</h3><span class="count c-${status}">${tasks.length}<span class="visually-hidden"> tasks</span></span></div>
      ${tasks.length ? `<ul aria-labelledby="col-${status}">${tasks.map((t) => taskHtml(t, byId, names)).join('')}</ul>` : '<p class="empty">Empty cells</p>'}
    </div>`;
  }).join('');
}

function taskHtml(t, byId, names) {
  const deps = (t.deps ?? []).map((d) => {
    const id = parseInt(d, 10);
    const dep = byId.get(id);
    const done = dep?.status === 'done';
    return `<a href="#task-${id}" id="dep-${t.id}-${id}" class="dep ${done ? 'ok' : 'wait'}">${done ? `#${id} done` : `waits for #${id}`}</a>`;
  }).join('');
  const opts = (sel) => `<option value="">Choose a bee</option>` + names.map((n) => `<option ${n === sel ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const assignAction = t.status === 'open' || t.status === 'assigned' ? 'assign' : 'reassign';
  const controls = t.status === 'done' ? '' : `
    <div class="row">
      <label for="own-${t.id}">Owner</label>
      <select id="own-${t.id}">${opts(t.owner)}</select>
      <button type="button" class="btn small" id="own-btn-${t.id}" data-action="${assignAction}" data-id="${t.id}" data-from="own-${t.id}">${assignAction === 'assign' ? 'Assign' : 'Reassign'}</button>
    </div>
    <div class="row">
      <label for="st-${t.id}">Status</label>
      <select id="st-${t.id}">
        ${['open', 'assigned', 'in_progress', 'blocked', 'review', 'done'].map((s) => `<option value="${s}" ${s === t.status ? 'selected' : ''}>${s.replace('_', ' ')}</option>`).join('')}
      </select>
      <button type="button" class="btn small" id="st-btn-${t.id}" data-action="set_status" data-id="${t.id}" data-from="st-${t.id}">Set</button>
    </div>
    ${t.status === 'review' ? `<div class="row">
      <button type="button" class="btn honey small" id="ap-${t.id}" data-action="review" data-verdict="approve" data-id="${t.id}">Approve</button>
      <button type="button" class="btn small" id="rq-${t.id}" data-action="review" data-verdict="changes_requested" data-id="${t.id}">Request changes</button>
    </div>` : ''}`;
  const justCapped = t.status === 'done' && prevStatus.size && prevStatus.get(t.id) && prevStatus.get(t.id) !== 'done';
  return `<li class="task s-${t.status} ${justCapped ? 'capped' : ''}" id="task-${t.id}" data-flip="task-${t.id}" tabindex="-1">
    <div class="task-top"><span class="task-id">#${t.id}</span><span>P${t.pri}</span>${t.status === 'blocked' ? '<span class="chip blocked">blocked</span>' : ''}${t.stale ? '<span class="chip blocked">owner silent</span>' : ''}</div>
    <div class="task-title">${esc(t.title)}</div>
    <div class="task-meta">
      <span class="owner"><span class="mini-av" aria-hidden="true">${t.owner ? initial(t.owner) : '·'}</span>${t.owner ? esc(t.owner) : 'unowned'}</span>
      ${deps}
    </div>
    <details id="det-${t.id}">
      <summary id="sum-${t.id}">Details and actions<span class="visually-hidden"> for #${t.id} ${esc(t.title)}</span></summary>
      ${t.description ? `<p class="desc">${esc(t.description)}</p>` : ''}
      ${t.acceptance ? `<p class="desc"><strong>Done when:</strong> ${esc(t.acceptance)}</p>` : ''}
      ${t.files.length ? `<ul class="files" aria-label="Expected files">${t.files.map((f) => `<li><code>${esc(f)}</code></li>`).join('')}</ul>` : ''}
      ${t.branch ? `<div class="meta">Branch <code>${esc(t.branch)}</code></div>` : ''}
      ${t.review_notes ? `<p class="desc"><strong>Review notes:</strong> ${esc(t.review_notes)}</p>` : ''}
      ${controls}
    </details>
  </li>`;
}

const mergeCommand = (branch) => `git checkout main && git pull && git merge --no-ff ${branch} && git push`;

function mergeHtml() {
  const q = state.merge_queue ?? [];
  if (!q.length) return '';
  return `<section class="merge" aria-labelledby="merge-h">
    <h3 id="merge-h">Ready to merge <span class="plain">· approved by the queen, waiting for a human</span></h3>
    <ul>${q.map((m) => `<li class="cell">
      ${ICON.cell}
      <div class="cell-body"><span><a href="#task-${m.id}" id="mq-${m.id}">#${m.id}</a> ${esc(m.title)} · by ${esc(m.owner ?? '?')}</span><code>${esc(m.branch)}</code></div>
      <div class="merge-actions">
        <button type="button" class="btn small" id="mq-copy-${m.id}" data-action="copy_merge" data-branch="${esc(m.branch)}" aria-label="Copy merge command for ${esc(m.branch)}">Copy command</button>
        <button type="button" class="btn honey small" id="mq-done-${m.id}" data-action="mark_merged" data-id="${m.id}" aria-label="Mark #${m.id} as merged">Mark merged</button>
      </div>
    </li>`).join('')}</ul>
  </section>`;
}

function unclaimedHtml() {
  if (!state.unclaimed.length) return '';
  return `<div class="alert">${ICON.warn}<div><strong>Edits outside claimed cells (last hour)</strong>
    <ul>${state.unclaimed.map((u) => `<li><strong>${esc(u.by)}</strong> edited <code>${esc(u.path)}</code>${u.count > 1 ? ` ${u.count} times` : ''}, last at ${clock(u.ts)}</li>`).join('')}</ul></div>
  </div>`;
}

function claimsHtml() {
  if (!state.claims.length) return '<li class="empty">No cells claimed. Every file is free.</li>';
  return state.claims.map((c) => `<li class="cell">
    ${ICON.cell}
    <div class="cell-body"><code>${esc(c.path)}</code>
      <span>${esc(c.by)} · ${c.task ? `<a href="#task-${c.task}" id="ct-${idSafe(c.by + c.path)}">#${c.task}</a>` : 'no task'} · expires in <span data-until="${c.expires_at}"></span></span></div>
    <button type="button" class="btn danger small" id="rel-${idSafe(c.by + ':' + c.path)}" data-action="release" data-path="${esc(c.path)}" aria-label="Unlock ${esc(c.path)} held by ${esc(c.by)}">Unlock</button>
  </li>`).join('');
}

function feedHtml() {
  const items = state.feed.filter(FILTERS[filter]);
  if (!items.length) return `<li class="empty">${filter === 'all' ? 'The hive is quiet.' : 'Nothing here yet.'}</li>`;
  return items.map((f) => {
    const fresh = seenFeedId !== null && f.id > seenFeedId;
    return `<li class="k-${f.kind} ${f.flag ? 'flagged' : ''} ${fresh ? 'enter' : ''}">
      <time datetime="${new Date(f.ts).toISOString()}">${clock(f.ts)}</time>
      <span>${f.flag ? '<span class="flag-label">Flagged:</span> ' : ''}<strong>${esc(f.who ?? 'hive')}</strong> <span class="text">${esc(f.text)}</span>${f.task && !/#\d/.test(f.text) ? ` <a id="fl-${f.id}" href="#task-${f.task}">#${f.task}</a>` : ''}</span>
    </li>`;
  }).join('');
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
    el.textContent = `${el.dataset.runEnd ? 'ran ' : ''}${dur(end - Number(el.dataset.runStart))}`;
  }
}
setInterval(tick, 1000);

// ───────────── actions ─────────────

function toast(msg) {
  $('toast').hidden = false;
  $('toast-msg').textContent = '';
  setTimeout(() => { $('toast-msg').textContent = msg; }, 50); // announce even when the text repeats
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
  if (!res) return toast("Can't reach the hive host. Check the connection.");
  if (res.status === 401) return showLogin();
  const r = await res.json().catch(() => ({}));
  if (!r.ok) toast(`${r.message ?? r.error ?? 'Action failed'}${r.do ? `. ${r.do}` : ''}`);
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
      if (!agent) return toast('Choose a bee first.');
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
    case 'copy_merge': {
      const cmd = mergeCommand(d.branch);
      try { await navigator.clipboard.writeText(cmd); announce('Merge command copied'); btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy command'; }, 1800); }
      catch { toast(cmd); } // plain http on a LAN: clipboard may be blocked, so show it instead
      return;
    }
    case 'mark_merged':
      return act({ action: 'mark_merged', id }, `Task ${id} marked as merged`);
    case 'release':
      if (!confirm(`Unlock ${d.path}? The bee holding it will be told.`)) return;
      return act({ action: 'release', path: d.path }, `Unlocked ${d.path}`);
    case 'set_leader':
      if (!confirm(`Make ${d.agent} the queen (leader)?`)) return;
      return act({ action: 'set_leader', agent: d.agent }, `${d.agent} is now the queen`);
  }
});

$('indep').addEventListener('click', () => {
  const on = $('indep').getAttribute('aria-checked') !== 'true';
  $('indep').setAttribute('aria-checked', String(on)); // optimistic; the next snapshot confirms
  act({ action: 'independent_queen', on }, on ? 'Independent queen on: the queen may approve her own tasks'
    : "Independent queen off: the queen's tasks need another reviewer");
});

$('rotate').addEventListener('click', () => {
  if (!confirm('Generate a new join code? The old one stops working for new joins. Bees already inside stay connected.')) return;
  act({ action: 'rotate_code' }, 'New join code generated');
});

$('copy-code').addEventListener('click', async () => {
  const code = $('join-code').textContent;
  try {
    await navigator.clipboard.writeText(code);
    $('copy-code').textContent = 'Copied';
    announce('Join code copied');
  } catch {
    $('copy-code').textContent = code; // insecure context (plain http on LAN): show it big instead
  }
  setTimeout(() => { $('copy-code').textContent = 'Copy'; }, 1800);
});

$('pause').addEventListener('click', () => {
  paused = !paused;
  $('pause').setAttribute('aria-pressed', String(paused));
  document.body.classList.toggle('paused', paused);
  if (!paused && latest) { state = latest; render(); setConn('live', 'live'); }
  announce(paused ? 'Live updates paused' : 'Live updates resumed');
});

for (const b of document.querySelectorAll('.segmented button')) {
  b.addEventListener('click', () => {
    filter = b.dataset.filter;
    for (const x of document.querySelectorAll('.segmented button')) x.setAttribute('aria-pressed', String(x === b));
    if (state) patch('feed-list', feedHtml());
  });
}

for (const b of document.querySelectorAll('.tabbar button')) {
  b.addEventListener('click', () => {
    document.body.dataset.view = b.dataset.view;
    for (const x of document.querySelectorAll('.tabbar button')) {
      if (x === b) x.setAttribute('aria-current', 'true'); else x.removeAttribute('aria-current');
    }
    window.scrollTo({ top: 0 });
    $(`${b.dataset.view}-h`)?.focus({ preventScroll: true });
  });
}

// Jumping to a task from anywhere (e.g. the colony on a phone) switches to the comb tab and
// moves focus there, even when the same link is used twice (no hashchange in that case).
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="#task-"]');
  if (!a) return;
  e.preventDefault();
  if (innerWidth < 900) document.querySelector('.tabbar button[data-view="comb"]').click();
  const el = document.querySelector(a.hash);
  el?.scrollIntoView({ block: 'center' });
  el?.focus({ preventScroll: true });
  history.replaceState(null, '', a.hash);
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
    setConn(paused ? 'Paused' : 'Live · humming', paused ? 'paused' : 'live');
  };
  source.onmessage = (ev) => {
    latest = JSON.parse(ev.data);
    serverSkew = latest.now - Date.now();
    if (paused) { setConn('Paused', 'paused'); return; }
    state = latest;
    render();
  };
  source.onerror = async () => {
    if (!$('conn').classList.contains('down')) announce('Connection lost, reconnecting');
    setConn('Reconnecting…', 'down');
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
  if (!res) return loginError("Can't reach the hive host. Check your connection and try again.");
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
