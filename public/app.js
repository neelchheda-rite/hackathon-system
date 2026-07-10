const $ = (s, el = document) => el.querySelector(s);
let ME = null, STATE = {}, TAB = null;

// ---- API helper ----
async function api(url, method = 'GET', body) {
  const r = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Error');
  return r.json();
}
function toast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  document.body.appendChild(t); setTimeout(() => t.remove(), 2200);
}

// Sage confetti burst — the celebration moment when an epic reaches Done.
function confetti() {
  const colors = ['#7fa06a', '#8fae7a', '#a3bd8f', '#c0592f'];
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:200;overflow:hidden';
  for (let i = 0; i < 60; i++) {
    const p = document.createElement('div');
    const size = 6 + (i % 4) * 2;
    p.style.cssText = `position:absolute;top:-12px;left:${(i * 137) % 100}%;width:${size}px;height:${size}px;
      background:${colors[i % colors.length]};border-radius:1px;opacity:.95;
      animation:cfall ${1.4 + (i % 5) * .25}s cubic-bezier(.3,.6,.5,1) ${(i % 8) * 40}ms forwards`;
    p.style.setProperty('--rot', (i * 47 % 360) + 'deg');
    wrap.appendChild(p);
  }
  document.body.appendChild(wrap);
  setTimeout(() => wrap.remove(), 3200);
}
// inject the confetti keyframes once
(function () {
  const s = document.createElement('style');
  s.textContent = '@keyframes cfall{to{transform:translateY(105vh) rotate(var(--rot,220deg));opacity:0}}';
  document.head.appendChild(s);
})();

// ---- Notifications (bell + dropdown + polling + browser push) ----
let NOTIF_POLL = null;         // interval handle so we don't stack pollers across re-renders
let NOTIF_SEEN_MAX = 0;        // highest notification id we've already shown a push for
let NOTIF_PANEL_OPEN = false;

function setupNotifications() {
  const bell = $('#notif-bell');
  const panel = $('#notif-panel');
  if (!bell || !panel) return;

  bell.onclick = async (e) => {
    e.stopPropagation();
    NOTIF_PANEL_OPEN = !NOTIF_PANEL_OPEN;
    if (NOTIF_PANEL_OPEN) { await renderNotifPanel(); }
    panel.hidden = !NOTIF_PANEL_OPEN;
  };
  // Close the panel when clicking outside it.
  document.addEventListener('click', (e) => {
    if (NOTIF_PANEL_OPEN && !e.target.closest('.notif-wrap')) {
      NOTIF_PANEL_OPEN = false; panel.hidden = true;
    }
  });

  // Ask for browser-push permission (best effort; ignored if already decided/denied).
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  // Poll immediately, then every 15s. Clear any prior interval first.
  if (NOTIF_POLL) clearInterval(NOTIF_POLL);
  refreshNotifBadge();
  NOTIF_POLL = setInterval(refreshNotifBadge, 15000);
}

async function fetchNotifications() {
  try { return await api('/api/notifications'); }
  catch (e) { return { items: [], unread: 0 }; }
}

async function refreshNotifBadge() {
  const { items, unread } = await fetchNotifications();
  const dot = $('#notif-dot');
  if (dot) {
    if (unread > 0) { dot.hidden = false; dot.textContent = unread > 9 ? '9+' : unread; }
    else dot.hidden = true;
  }
  // Browser push for any notification newer than what we've already surfaced.
  const fresh = items.filter(n => n.id > NOTIF_SEEN_MAX);
  if (NOTIF_SEEN_MAX > 0 && fresh.length && 'Notification' in window && Notification.permission === 'granted') {
    // Show at most the newest few so a burst doesn't spam the OS.
    fresh.slice(0, 3).forEach(n => {
      try { new Notification('Hackathon 2026', { body: n.message, tag: 'notif-' + n.id }); } catch (e) {}
    });
  }
  if (items.length) NOTIF_SEEN_MAX = Math.max(NOTIF_SEEN_MAX, items[0].id);
  // If the panel is open, keep it live.
  if (NOTIF_PANEL_OPEN) renderNotifPanel(items);
}

async function renderNotifPanel(preItems) {
  const panel = $('#notif-panel');
  if (!panel) return;
  const data = preItems ? { items: preItems } : await fetchNotifications();
  const items = data.items || [];
  panel.innerHTML = `
    <div class="notif-head">
      <b>Notifications</b>
      ${items.some(n => !n.read) ? `<button class="notif-clear" id="notif-clear">Mark all read</button>` : ''}
    </div>
    <div class="notif-list">${items.length ? items.map(n => `
      <div class="notif-item ${n.read ? '' : 'unread'}">
        <div class="notif-msg">${(n.message || '').replace(/</g, '&lt;')}</div>
        <div class="notif-time">${n.created_at}</div>
      </div>`).join('') : `<div class="notif-empty">No notifications yet.</div>`}</div>`;
  const clear = $('#notif-clear');
  if (clear) clear.onclick = async () => {
    await api('/api/notifications/read', 'POST', {});
    await refreshNotifBadge();
    renderNotifPanel();
  };
}

// ---- Pipeline meta ----
const FLOW = ['picked', 'in_development', 'acceptance', 'pr_review', 'ui_review', 'integration', 'done'];
const LABELS = {
  picked: 'Chit Picked', in_development: 'In Development', acceptance: 'Acceptance Review',
  pr_review: 'PR Review', ui_review: 'UI Review', integration: 'Integration Test', done: 'Done ✓'
};
function badge(s) { return `<span class="badge b-${s}">${LABELS[s] || s}</span>`; }
function pipe(status) {
  const idx = FLOW.indexOf(status);
  const isDone = status === 'done';
  return `<div class="pipe">${FLOW.slice(1).map((s, i) =>
    `<div class="step ${i + 1 <= idx ? (isDone ? 'done' : 'on') : ''}"></div>`).join('')}</div>`;
}
function starsRO(n) {
  return `<div class="stars ro">${[1, 2, 3, 4, 5].map(i => `<span class="${i <= n ? 'on' : ''}">★</span>`).join('')}</div>`;
}

// ---- Session persistence (survives reloads & browser restarts) ----
const SESSION_KEY = 'hackathon-user';
function saveSession(user) {
  try { user ? localStorage.setItem(SESSION_KEY, JSON.stringify(user)) : localStorage.removeItem(SESSION_KEY); } catch (e) {}
}
function loadSession() {
  try { const s = localStorage.getItem(SESSION_KEY); return s ? JSON.parse(s) : null; } catch (e) { return null; }
}

// ---- Boot ----
async function boot() {
  // 1) Render instantly from the cached user so nobody waits on a round-trip.
  const cached = loadSession();
  if (cached) { ME = cached; renderShell(); }

  // 2) Revalidate against the server session in the background.
  let fresh = null;
  try { fresh = await api('/api/me'); } catch (e) { /* offline: keep cached view */ if (cached) return; }
  if (fresh) {
    ME = fresh; saveSession(fresh);
    if (!cached) renderShell();       // only re-render if we hadn't already
  } else {
    // Server has no session (e.g. cookie expired) — clear cache and force login.
    ME = null; saveSession(null); renderLogin();
  }
}
boot();

// ========== LOGIN ==========
function renderLogin() {
  document.getElementById('app').innerHTML = `
    <div class="login-wrap"><div class="login-card fade-up">
      <div class="login-form">
        <span class="logo"></span>
        <h1>Welcome back.</h1>
        <p class="lead">Sign in to the review hub to continue.</p>
        <div class="field"><label>Username</label><input id="u" autofocus></div>
        <div class="field"><label>Password</label><input id="p" type="password"></div>
        <button class="btn block" id="go">Sign in</button>
        <div class="err" id="err"></div>
        <div class="hint">
          <b>Sign-in help</b><br>
          Your username is your first name; your organizer shares your password.
        </div>
      </div>
      <div class="login-hero">
        <div class="eyebrow">Hackathon 2026 · Review Hub</div>
        <div class="quote">Pick a chit. Build the epic. Pass the gates.</div>
        <div class="meta">28 epics · 7 teams · 4 rounds</div>
      </div>
    </div></div>`;
  const go = async () => {
    try {
      ME = await api('/api/login', 'POST', { username: $('#u').value.trim(), password: $('#p').value });
      saveSession(ME);
      renderShell();
    } catch (e) { $('#err').textContent = e.message; }
  };
  $('#go').onclick = go;
  $('#p').onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#u').onkeydown = e => { if (e.key === 'Enter') $('#p').focus(); };
}

// ========== SHELL ==========
const TABS_BY_ROLE = {
  admin: ['dashboard', 'review', 'pipeline', 'admin', 'leaderboard', 'audit'],
  lead: ['my-epics', 'pipeline', 'leaderboard'],
  ba: ['review', 'pipeline', 'leaderboard'],
  pr: ['review', 'pipeline', 'leaderboard'],
  ui: ['review', 'pipeline', 'leaderboard'],
  integration: ['review', 'pipeline', 'leaderboard']
};
const TAB_NAMES = { dashboard: 'Dashboard', pipeline: 'Live Pipeline', admin: 'Organizer', leaderboard: 'Leaderboard',
  'my-epics': 'My Epics', review: 'My Review Queue', audit: 'Audit Log' };

async function renderShell() {
  const tabs = TABS_BY_ROLE[ME.role];
  if (!TAB || !tabs.includes(TAB)) TAB = tabs[0];
  document.getElementById('app').innerHTML = `
    <div class="topbar">
      <div class="brand"><span class="dot"></span> Hackathon 2026</div>
      <div class="spacer"></div>
      <div class="who">${ME.role === 'lead' && ME.team_name ? `<b>${ME.team_name}</b>` : `Hi, <b>${ME.name}</b>`}</div>
      <span class="role-chip">${ME.role === 'lead' ? 'Team' : ME.role}</span>
      <div class="notif-wrap">
        <button class="btn sm ghost notif-bell" id="notif-bell" title="Notifications">🔔<span class="notif-dot" id="notif-dot" hidden></span></button>
        <div class="notif-panel" id="notif-panel" hidden></div>
      </div>
      <button class="btn sm ghost" id="dl-env" title="Download the shared backend .env">⬇ .env</button>
      <button class="btn sm ghost" id="logout">Logout</button>
    </div>
    <div class="container">
      <div class="tabs">${tabs.map(t =>
        `<div class="tab ${t === TAB ? 'active' : ''}" data-t="${t}">${TAB_NAMES[t]}</div>`).join('')}</div>
      <div id="view"></div>
    </div>`;
  $('#dl-env').onclick = () => { window.location.href = '/api/download/env'; toast('Downloading .env…'); };
  $('#logout').onclick = async () => { await api('/api/logout', 'POST'); ME = null; saveSession(null); renderLogin(); };
  document.querySelectorAll('.tab').forEach(el => el.onclick = () => { TAB = el.dataset.t; renderShell(); });
  setupNotifications();
  await loadState();
  renderView();
}

async function loadState() {
  const [assignments, epics, teams] = await Promise.all([
    api('/api/assignments'), api('/api/epics'), api('/api/teams')
  ]);
  STATE = { assignments, epics, teams };
}

function renderView() {
  const v = $('#view');
  if (TAB === 'dashboard') return renderDashboard(v);
  if (TAB === 'pipeline') return renderPipeline(v);
  if (TAB === 'leaderboard') return renderLeaderboard(v);
  if (TAB === 'my-epics') return renderMyEpics(v);
  if (TAB === 'review') return renderReviewQueue(v);
  if (TAB === 'admin') return renderAdmin(v);
  if (TAB === 'audit') return renderAudit(v);
}

// ========== AUDIT LOG ==========
async function renderAudit(v) {
  const logs = await api('/api/admin/audit');
  v.innerHTML = `<div class="section-title">Every action — logins, reviews, admin changes (latest 500)</div>
    <table><thead><tr><th>Time</th><th>User</th><th>Role</th><th>Action</th><th>Detail</th><th>IP</th></tr></thead>
    <tbody>${logs.map(l => `<tr>
      <td style="white-space:nowrap;color:var(--muted)">${l.created_at}</td>
      <td><b>${l.username || '—'}</b></td>
      <td>${l.role ? `<span class="role-chip">${l.role}</span>` : '—'}</td>
      <td><span class="badge b-acceptance">${l.action}</span></td>
      <td>${(l.detail || '').replace(/</g,'&lt;')}</td>
      <td style="color:var(--muted);font-size:12px">${l.ip || ''}</td>
    </tr>`).join('') || `<tr><td colspan="6" class="empty">No activity yet.</td></tr>`}</tbody></table>`;
}

// ========== LIVE PIPELINE (everyone) ==========
function renderPipeline(v) {
  const a = STATE.assignments;
  if (!a.length) return v.innerHTML = `<div class="empty">No epics picked yet. The organizer will register chit pickups.</div>`;
  v.innerHTML = `<div class="page-title">Live pipeline</div>
    <div class="section-title">Every epic, by stage</div>
    <div class="grid">${a.map((x, i) => `
    <div class="card fade-up" style="animation-delay:${Math.min(i, 8) * 80}ms">
      <div class="row" style="justify-content:space-between">
        <h3>${x.team_name}</h3>${badge(x.status)}
      </div>
      <div class="sub">Round ${x.round} · ${x.epic_number || 'epic not assigned'} ${x.attempts > 1 ? `<span class="attempts">· attempt ${x.attempts}</span>` : ''}</div>
      <div><b>${x.epic_title || '—'}</b></div>
      ${pipe(x.status)}
      ${x.pr_link ? `<div class="sub">PR: <a href="${x.pr_link}" target="_blank">${x.pr_link}</a></div>` : ''}
    </div>`).join('')}</div>`;
}

// ========== LEADERBOARD ==========
async function renderLeaderboard(v) {
  const lb = await api('/api/leaderboard');
  v.innerHTML = `<div class="page-title">Leaderboard</div>
    <div class="section-title">Aggregated stars across all epics</div>
    <table><thead><tr><th>#</th><th>Team</th><th>UI ★</th><th>Integration ★</th>
    <th>Total ★</th><th>Epics Done</th><th>Rejections</th></tr></thead><tbody>
    ${lb.map((r, i) => `<tr>
      <td><span class="rank ${i === 0 ? '' : 'low'}">${i + 1}</span></td><td><b>${r.team}</b></td>
      <td style="color:var(--star)">${r.ui_stars}</td><td style="color:var(--star)">${r.integration_stars}</td>
      <td class="big">${r.total}</td><td>${r.epics_done}</td>
      <td style="color:${r.rejections ? 'var(--fail)' : 'var(--muted)'}">${r.rejections}</td>
    </tr>`).join('')}</tbody></table>`;
}

// ========== ORG DASHBOARD (admin) ==========
async function renderDashboard(v) {
  const [summary, lb] = await Promise.all([
    api('/api/admin/pipeline-summary'),
    api('/api/leaderboard')
  ]);

  // --- KPI tiles ---
  const done = summary.byStatus.done || 0;
  const inReview = REVIEW_STAGES.reduce((s, st) => s + (summary.byStatus[st] || 0), 0);
  const inDev = summary.byStatus.in_development || 0;
  const totalStars = lb.reduce((s, r) => s + r.total, 0);
  const kpis = [
    ['Total epics', summary.total, ''], ['Done', done, 'done'],
    ['In review', inReview, ''], ['In development', inDev, ''], ['Total ★ awarded', totalStars, '']
  ];

  // --- Pipeline-by-stage horizontal bars ---
  const stageOrder = FLOW.slice(1); // skip 'picked'
  const maxCount = Math.max(1, ...stageOrder.map(st => summary.byStatus[st] || 0));
  const stageBars = stageOrder.map(st => {
    const n = summary.byStatus[st] || 0;
    const pct = Math.round((n / maxCount) * 100);
    const fillCls = st === 'done' ? 'done' : (REVIEW_STAGES.includes(st) ? 'mid' : '');
    return `<div class="stage-bar">
      <div class="lbl">${LABELS[st].replace(' ✓','')}</div>
      <div class="track"><div class="fill ${fillCls}" style="width:${n ? pct : 0}%"></div></div>
      <div class="cnt">${n}</div>
    </div>`;
  }).join('');

  // --- Per-round breakdown table ---
  const rounds = Object.keys(summary.byRound).sort();
  const roundTable = `<table><thead><tr><th>Round</th>${stageOrder.map(s => `<th>${LABELS[s]}</th>`).join('')}</tr></thead>
    <tbody>${rounds.map(rd => `<tr><td><b>Round ${rd}</b></td>${
      stageOrder.map(s => `<td>${summary.byRound[rd][s] || 0}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${stageOrder.length + 1}" class="empty">No epics yet.</td></tr>`}</tbody></table>`;

  // --- Standings ---
  const standings = `<table><thead><tr><th>#</th><th>Team</th><th>UI ★</th><th>Integration ★</th><th>Total ★</th><th>Done</th><th>Rejections</th><th></th></tr></thead>
    <tbody>${lb.map((r, i) => {
      const team = STATE.teams.find(t => t.name === r.team);
      return `<tr>
        <td><span class="rank ${i === 0 ? '' : 'low'}">${i + 1}</span></td><td><b>${r.team}</b></td>
        <td style="color:var(--star)">${r.ui_stars}</td><td style="color:var(--star)">${r.integration_stars}</td>
        <td class="big">${r.total}</td>
        <td>${r.epics_done}</td>
        <td style="color:${r.rejections ? 'var(--fail)' : 'var(--muted)'}">${r.rejections}</td>
        <td>${team ? `<button class="btn sm ghost" onclick="openTeamReport(${team.id})">Report</button>` : ''}</td>
      </tr>`;
    }).join('')}</tbody></table>`;

  v.innerHTML = `
    <div class="page-title">Organizer dashboard</div>
    <div class="section-title">At a glance</div>
    <div class="kpi-row fade-up">${kpis.map(([l, n, cls]) =>
      `<div class="kpi ${cls}"><div class="kpi-n" data-count="${n}">${n}</div><div class="kpi-l">${l}</div></div>`).join('')}</div>

    <div class="section-title" style="margin-top:28px">Pipeline by stage</div>
    <div class="card fade-up"><div class="stage-bars">${stageBars}</div></div>
    <div style="margin-top:16px">${roundTable}</div>

    <div class="section-title" style="margin-top:28px">Team standings</div>
    ${standings}`;
  countUp(v);
}

// Tween KPI numbers 0 -> target on load (~1.1s, smoothstep ease).
function countUp(scope) {
  scope.querySelectorAll('.kpi-n[data-count]').forEach(el => {
    const target = +el.dataset.count || 0;
    if (target === 0) return;
    const start = performance.now(), dur = 1100;
    const tick = now => {
      const t = Math.min(1, (now - start) / dur);
      const e = t * t * (3 - 2 * t); // smoothstep
      el.textContent = Math.round(e * target);
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}

async function openTeamReport(teamId) {
  const { team, assignments } = await api('/api/admin/team-report/' + teamId);
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  const body = assignments.length ? assignments.map(a => {
    const reviews = (a.reviews || []).map(r => {
      let detail = r.outcome === 'rated' ? `${r.stars || 0}★` : (r.outcome || '').toUpperCase();
      // Integration: show the combined star rating, with the per-platform breakdown as a hint.
      let extra = '';
      if (r.stage === 'integration' && r.platform_stars) {
        extra = `<span class="sub"> (${Object.entries(JSON.parse(r.platform_stars)).map(([k, v]) => `${k}:${v}`).join(', ')})</span>`;
      }
      const cls = r.outcome === 'fail' ? 'bad' : (r.outcome === 'pass' || r.outcome === 'rated' ? 'ok' : '');
      const badgeStage = { pr: 'pr_review', ui: 'ui_review', acceptance: 'acceptance', integration: 'integration' }[r.stage] || r.stage;
      return `<div class="rev-line"><span class="badge b-${badgeStage}">${r.stage}</span>
        <b class="${cls}">${detail}</b>${extra} · ${r.reviewer_name}
        ${r.comment ? `<span class="sub">— ${r.comment.replace(/</g, '&lt;')}</span>` : ''}</div>`;
    }).join('') || `<div class="sub">No reviews yet.</div>`;
    return `<div class="card" style="margin-bottom:12px">
      <div class="row" style="justify-content:space-between"><h3>${a.epic_number || 'Epic pending'}</h3>${badge(a.status)}</div>
      <div class="sub">Round ${a.round} ${a.attempts > 1 ? `· attempt ${a.attempts}` : ''} · <b>${a.epic_title || '—'}</b></div>
      ${pipe(a.status)}
      <div style="margin-top:8px">${reviews}</div>
    </div>`;
  }).join('') : `<div class="empty">No epics for this team yet.</div>`;
  bg.innerHTML = `<div class="modal" style="max-width:640px">
    <h3>${team.name} — full report</h3>
    <div style="max-height:70vh;overflow:auto;margin-top:12px">${body}</div>
    <button class="btn ghost sm" style="margin-top:14px" onclick="this.closest('.modal-bg').remove()">Close</button>
  </div>`;
  document.body.appendChild(bg);
}

// ========== TEAM LEAD: MY EPICS ==========
function renderMyEpics(v) {
  const mine = STATE.assignments.filter(x => x.team_id === ME.team_id);
  if (!mine.length) return v.innerHTML = `<div class="empty">No epics yet. Pick a chit and ask the organizer to register it.</div>`;
  v.innerHTML = `<div class="page-title">My epics</div>
    <div class="section-title">Your team's work in flight</div>
    <div class="grid">${mine.map((x, i) => `
    <div class="card fade-up" style="animation-delay:${Math.min(i, 8) * 80}ms">
      <div class="row" style="justify-content:space-between"><h3>${x.epic_number || 'Epic pending'}</h3>${badge(x.status)}</div>
      <div class="sub">Round ${x.round} ${x.attempts > 1 ? `<span class="attempts">· attempt ${x.attempts}</span>` : ''}</div>
      <div><b>${x.epic_title || '—'}</b></div>
      <div class="sub">${x.epic_desc || ''}</div>
      ${pipe(x.status)}
      ${(x.status === 'in_development') ? `
        <div class="field" style="margin-top:8px"><label>PR link</label><input id="pr-${x.id}" placeholder="https://github.com/..."></div>
        <button class="btn ok" onclick="submitPR(${x.id})">Mark completed & submit PR</button>` : ''}
      ${x.status === 'picked' ? `<div class="sub">⏳ Waiting for organizer to assign your epic number.</div>` : ''}
      ${x.pr_link ? `<div class="sub">PR: <a href="${x.pr_link}" target="_blank">link</a></div>` : ''}
    </div>`).join('')}</div>`;
}
async function submitPR(id) {
  const link = $('#pr-' + id).value.trim();
  if (!link) return toast('Enter the PR link');
  await api('/api/lead/submit-pr', 'POST', { assignment_id: id, pr_link: link });
  toast('Submitted for Acceptance review'); await loadState(); renderView();
}

// ========== REVIEWERS: QUEUE ==========
const ROLE_STAGE = { ba: 'acceptance', pr: 'pr_review', ui: 'ui_review', integration: 'integration' };
// Which pipeline statuses are actionable review stages (in flow order).
const REVIEW_STAGES = ['acceptance', 'pr_review', 'ui_review', 'integration'];
const STAGE_TITLE = { acceptance: 'Acceptance Criteria', pr_review: 'PR Review', ui_review: 'UI Review', integration: 'Integration Testing' };

function renderReviewQueue(v) {
  const isAdmin = ME.role === 'admin';
  // Admin sees every epic at any review stage; a reviewer sees only their stage.
  const queue = STATE.assignments.filter(x =>
    isAdmin ? REVIEW_STAGES.includes(x.status) : x.status === ROLE_STAGE[ME.role]);
  const heading = isAdmin
    ? `All epics in review`
    : STAGE_TITLE[ROLE_STAGE[ME.role]];
  v.innerHTML = `<div class="page-title">${heading}</div>
    <div class="section-title">${queue.length} item${queue.length === 1 ? '' : 's'} in the queue</div>` +
    (isAdmin ? `<div class="sub" style="margin-bottom:12px;color:var(--ink-soft)">As organizer you can act on any stage on behalf of the assigned reviewer.</div>` : '') +
    (queue.length ? `<div class="grid">${queue.map((x, i) => `
      <div class="card fade-up" style="animation-delay:${Math.min(i, 8) * 80}ms">
        <div class="row" style="justify-content:space-between"><h3>${x.epic_number}</h3>${badge(x.status)}</div>
        <div class="sub">${x.team_name} · Round ${x.round} ${x.attempts > 1 ? `<span class="attempts">· attempt ${x.attempts}</span>` : ''}</div>
        <div><b>${x.epic_title}</b></div>
        <div class="sub">${x.epic_desc || ''}</div>
        ${x.pr_link ? `<div class="sub">PR: <a href="${x.pr_link}" target="_blank">open PR</a></div>` : ''}
        <button class="btn" onclick="openReview(${x.id})">Review this epic</button>
      </div>`).join('')}</div>`
      : `<div class="empty">🎉 Nothing in the queue right now.</div>`);
}

function openReview(id) {
  const x = STATE.assignments.find(a => a.id === id);
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  // Decide the review UI from the epic's CURRENT stage, so admin can act on any stage.
  const stage = x.status;
  let inner = '';
  if (stage === 'acceptance' || stage === 'pr_review') {
    inner = `
      <div class="field"><label>Comment (required if rejecting)</label><textarea id="cmt" rows="3"></textarea></div>
      <div class="row">
        <button class="btn ok" onclick="doPassFail(${id},'pass')">Pass</button>
        <button class="btn bad" onclick="doPassFail(${id},'fail')">Reject</button>
      </div>
      <p class="sub" style="margin-top:12px">Reject → epic returns to development (attempt +1) and must re-do from acceptance.</p>`;
  } else if (stage === 'ui_review') {
    inner = `
      <div class="field"><label>Design rating</label>${starPicker('ui')}</div>
      <div class="field"><label>Comment</label><textarea id="cmt" rows="2"></textarea></div>
      <button class="btn ok" onclick="doUI(${id})">Submit rating & merge branch</button>
      <p class="sub" style="margin-top:8px">UI never fails — 0 stars allowed. Branch merges after rating.</p>`;
  } else if (stage === 'integration') {
    const plats = ['windows', 'web', 'android', 'ios', 'backend'];
    inner = `<div class="plat-grid">${plats.map(p =>
      `<div style="text-transform:capitalize;font-weight:600">${p}</div>${starPicker(p)}`).join('')}</div>
      <div class="field"><label>Comment</label><textarea id="cmt" rows="2"></textarea></div>
      <button class="btn ok" onclick="doIntegration(${id})">Submit & complete</button>
      <p class="sub" style="margin-top:8px">0 stars = broken platform. Never blocks the epic.</p>`;
  } else {
    inner = `<p class="sub">This epic is not at a review stage right now.</p>`;
  }
  bg.innerHTML = `<div class="modal">
    <h3>${x.epic_number} — ${x.epic_title}</h3>
    <div class="sub">${x.team_name} · Round ${x.round} · ${badge(x.status)}</div>
    ${inner}
    <button class="btn ghost sm" style="margin-top:14px" onclick="this.closest('.modal-bg').remove()">Cancel</button>
  </div>`;
  document.body.appendChild(bg);
}

const PICK = {};
function starPicker(key) {
  PICK[key] = 0;
  return `<div class="stars" data-k="${key}">${[1, 2, 3, 4, 5].map(i =>
    `<span onclick="setStar('${key}',${i})">★</span>`).join('')}</div>`;
}
function setStar(key, n) {
  PICK[key] = (PICK[key] === n) ? 0 : n; // click same star again -> 0
  document.querySelectorAll(`.stars[data-k="${key}"] span`).forEach((s, i) => {
    const on = i < PICK[key];
    s.classList.toggle('on', on);
    if (on) { s.classList.add('pop'); setTimeout(() => s.classList.remove('pop'), 140); }
  });
}

async function doPassFail(id, outcome) {
  const comment = $('#cmt').value.trim();
  if (outcome === 'fail' && !comment) return toast('Add a reason for rejection');
  const x = STATE.assignments.find(a => a.id === id);
  const ep = x && x.status === 'acceptance' ? 'acceptance' : 'pr';
  await api('/api/review/' + ep, 'POST', { assignment_id: id, outcome, comment });
  // Stamp-style badge presses in before the modal closes.
  const modal = document.querySelector('.modal');
  if (modal) modal.innerHTML = `<div style="text-align:center;padding:26px 0">
    <div class="stamp ${outcome === 'pass' ? 'pass' : 'fail'}">${outcome === 'pass' ? 'PASS' : 'FAIL'}</div></div>`;
  setTimeout(async () => {
    const bg = document.querySelector('.modal-bg'); if (bg) bg.remove();
    toast(outcome === 'pass' ? 'Passed ✓' : 'Rejected & logged');
    await loadState(); renderView();
  }, 750);
}
async function doUI(id) {
  await api('/api/review/ui', 'POST', { assignment_id: id, stars: PICK.ui, comment: $('#cmt').value.trim() });
  document.querySelector('.modal-bg').remove(); toast('Rated & merged ✓'); await loadState(); renderView();
}
async function doIntegration(id) {
  const platform_stars = { windows: PICK.windows, web: PICK.web, android: PICK.android, ios: PICK.ios, backend: PICK.backend };
  await api('/api/review/integration', 'POST', { assignment_id: id, platform_stars, comment: $('#cmt').value.trim() });
  document.querySelector('.modal-bg').remove(); confetti(); toast('Integration recorded — epic done 🎉'); await loadState(); renderView();
}

// ========== ADMIN / ORGANIZER ==========
async function renderAdmin(v) {
  const users = await api('/api/admin/users').catch(() => []);
  const leads = users.filter(u => u.role === 'lead');
  const reviewers = users.filter(u => ['ba', 'pr', 'ui', 'integration'].includes(u.role));
  const roleLabel = { ba: 'BA', pr: 'PR', ui: 'UI', integration: 'Integration' };

  v.innerHTML = `
    <div class="page-title">Organizer</div>
    <div class="grid">
      <div class="card">
        <h3>① Register a chit pickup</h3>
        <div class="sub">Team lead picked a chit — log it, then assign the epic number below.</div>
        <div class="field"><label>Team</label><select id="pk-team">${STATE.teams.map(t => `<option value="${t.id}">${t.name}</option>`).join('')}</select></div>
        <div class="field"><label>Round</label><select id="pk-round">${[1,2,3,4].map(r => `<option>${r}</option>`).join('')}</select></div>
        <button class="btn" onclick="doPickup()">Register pickup</button>
      </div>
      <div class="card">
        <h3>② Assign epic number</h3>
        <div class="sub">Pick a waiting assignment and the epic drawn from the chit.</div>
        <div class="field"><label>Waiting assignment</label><select id="as-assign">${
          STATE.assignments.filter(a => a.status === 'picked').map(a =>
          `<option value="${a.id}">${a.team_name} · Round ${a.round}</option>`).join('') || '<option value="">— none —</option>'}</select></div>
        <div class="field"><label>Epic</label><select id="as-epic">${
          STATE.epics.map(e => `<option value="${e.id}">${e.epic_number} — ${e.title}</option>`).join('')}</select></div>
        <button class="btn ok" onclick="doAssign()">Assign & start development</button>
      </div>
    </div>
    <div class="section-title" style="margin-top:28px">Rename teams</div>
    <div class="boxed"><table><thead><tr><th>Team</th><th style="width:120px"></th></tr></thead><tbody>
      ${STATE.teams.map(t => `<tr>
        <td><input id="tm-${t.id}" value="${t.name.replace(/"/g, '&quot;')}"></td>
        <td><button class="btn sm ghost" onclick="saveTeam(${t.id})">Save</button></td>
      </tr>`).join('')}</tbody></table></div>

    <div class="section-title" style="margin-top:28px">Assign real names to people</div>
    <div class="sub" style="color:var(--ink-soft);margin-bottom:12px">Team Leads appear as their team name across the app; these names show on reviews & audit only.</div>
    <div class="boxed"><table><thead><tr><th>Role</th><th>Team</th><th>Real name</th><th style="width:120px"></th></tr></thead><tbody>
      ${leads.map(u => { const tm = STATE.teams.find(t => t.id === u.team_id);
        return `<tr>
        <td><span class="role-chip">Lead</span></td>
        <td><b>${tm ? tm.name : '—'}</b></td>
        <td><input id="un-${u.id}" value="${(u.name || '').replace(/"/g, '&quot;')}"></td>
        <td><button class="btn sm ghost" onclick="saveUserName(${u.id})">Save</button></td>
      </tr>`; }).join('')}
      ${reviewers.map(u => `<tr>
        <td><span class="role-chip">${roleLabel[u.role]}</span></td>
        <td style="color:var(--muted)">${u.username}</td>
        <td><input id="un-${u.id}" value="${(u.name || '').replace(/"/g, '&quot;')}"></td>
        <td><button class="btn sm ghost" onclick="saveUserName(${u.id})">Save</button></td>
      </tr>`).join('')}
    </tbody></table></div>

    <div class="section-title" style="margin-top:28px">Master epic list (28)</div>
    <div id="epic-editor"></div>`;
  renderEpicEditor();
}
async function saveTeam(id) {
  const name = $('#tm-' + id).value.trim();
  if (!name) return toast('Name required');
  await api('/api/admin/teams/' + id, 'PUT', { name });
  toast('Team renamed'); await loadState(); renderView();
}
async function saveUserName(id) {
  const name = $('#un-' + id).value.trim();
  if (!name) return toast('Name required');
  await api('/api/admin/users/' + id, 'PUT', { name });
  toast('Name saved');
}
function renderEpicEditor() {
  $('#epic-editor').innerHTML = `<table><thead><tr><th>Epic #</th><th>Round</th><th>Title</th><th>Description</th><th></th></tr></thead>
    <tbody>${STATE.epics.map(e => `<tr>
      <td><input value="${e.epic_number}" id="e-num-${e.id}" style="width:90px"></td>
      <td><input value="${e.round}" id="e-rnd-${e.id}" style="width:50px"></td>
      <td><input value="${e.title.replace(/"/g,'&quot;')}" id="e-ttl-${e.id}"></td>
      <td><input value="${(e.description||'').replace(/"/g,'&quot;')}" id="e-dsc-${e.id}"></td>
      <td><button class="btn sm ghost" onclick="saveEpic(${e.id})">Save</button></td>
    </tr>`).join('')}</tbody></table>`;
}
async function doPickup() {
  await api('/api/admin/pickup', 'POST', { team_id: +$('#pk-team').value, round: +$('#pk-round').value });
  toast('Pickup registered'); await loadState(); renderView();
}
async function doAssign() {
  const aid = $('#as-assign').value;
  if (!aid) return toast('No waiting assignment');
  await api('/api/admin/assign-epic', 'POST', { assignment_id: +aid, epic_id: +$('#as-epic').value });
  toast('Epic assigned — development started'); await loadState(); renderView();
}
async function doAddUser() {
  try {
    await api('/api/admin/users', 'POST', {
      name: $('#nu-name').value, username: $('#nu-user').value, password: $('#nu-pass').value,
      role: $('#nu-role').value, team_id: $('#nu-team').value || null
    });
    toast('User created');
  } catch (e) { toast(e.message); }
}
async function saveEpic(id) {
  await api('/api/admin/epics/' + id, 'PUT', {
    epic_number: $('#e-num-' + id).value, round: +$('#e-rnd-' + id).value,
    title: $('#e-ttl-' + id).value, description: $('#e-dsc-' + id).value
  });
  toast('Epic saved'); await loadState();
}
