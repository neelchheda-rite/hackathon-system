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
// Overall lifecycle. The three review stages (acceptance/PR/UI) run in PARALLEL
// once a PR is submitted — see stageChips() for per-stage state.
const FLOW = ['picked', 'in_development', 'in_review', 'done'];
const LABELS = {
  picked: 'Chit Picked', in_development: 'In Development', in_review: 'In Review',
  done: 'Done ✓',
  // legacy overall values (kept so old data / audit still render)
  acceptance: 'Acceptance Review', pr_review: 'PR Review', ui_review: 'UI Review'
};
function badge(s) { return `<span class="badge b-${s}">${LABELS[s] || s}</span>`; }
function pipe(status) {
  const idx = FLOW.indexOf(status);
  const isDone = status === 'done';
  return `<div class="pipe">${FLOW.slice(1).map((s, i) =>
    `<div class="step ${i + 1 <= idx ? (isDone ? 'done' : 'on') : ''}"></div>`).join('')}</div>`;
}

// The three parallel review stages, shown as independent chips on an assignment.
const STAGE_META = [
  { key: 'ba_status', label: 'Acceptance' },
  { key: 'pr_status', label: 'PR' },
  { key: 'ui_status', label: 'UI' },
];
function stageChip(label, st) {
  // st: pending | open | passed | failed | rated
  const text = { pending: '—', open: 'reviewing', passed: 'passed', failed: 'rejected', rated: 'rated' }[st] || st;
  return `<span class="stage-chip s-${st}" title="${label}: ${text}"><b>${label}</b> ${text}</span>`;
}
function stageChips(x) {
  // Only meaningful once review has started; before that everything is pending.
  return `<div class="stage-chips">${STAGE_META.map(m => stageChip(m.label, x[m.key])).join('')}</div>`;
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
  lead: ['my-epics', 'pipeline'],
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
      ${(x.status === 'in_review' || x.status === 'done') ? stageChips(x) : ''}
      ${x.pr_link ? `<div class="sub">PR: <a href="${x.pr_link}" target="_blank">${x.pr_link}</a></div>` : ''}
    </div>`).join('')}</div>`;
}

// ========== LEADERBOARD ==========
async function renderLeaderboard(v) {
  const lb = await api('/api/leaderboard');
  v.innerHTML = `<div class="page-title">Leaderboard</div>
    <div class="section-title">Final average score across all reviews (Acceptance + PR + UI)</div>
    <table><thead><tr><th>#</th><th>Team</th><th>Acceptance ★</th><th>PR ★</th><th>UI ★</th>
    <th>Bonus ★</th><th>Total ★</th><th>Avg score</th><th>Epics Done</th><th>Rejections</th></tr></thead><tbody>
    ${lb.map((r, i) => `<tr>
      <td><span class="rank ${i === 0 ? '' : 'low'}">${i + 1}</span></td><td><b>${r.team}</b></td>
      <td style="color:var(--star)">${r.acceptance_stars}</td><td style="color:var(--star)">${r.pr_stars}</td><td style="color:var(--star)">${r.ui_stars}</td>
      <td style="color:${r.bonus_stars ? 'var(--success)' : 'var(--muted)'}">${r.bonus_stars ? '+' + r.bonus_stars : '—'}</td>
      <td><b>${r.total}</b></td><td class="big" style="color:var(--star)">${r.avg_score}</td><td>${r.epics_done}</td>
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
  const inReview = summary.byStatus.in_review || 0;
  const inDev = summary.byStatus.in_development || 0;
  const totalStars = lb.reduce((s, r) => s + r.total, 0);
  const kpis = [
    ['Total epics', summary.total, ''], ['Done', done, 'done'],
    ['In review', inReview, ''], ['In development', inDev, ''], ['Total ★ awarded', totalStars, '']
  ];

  // --- Parallel review-stage bars: how many epics are still being reviewed vs
  //     cleared at each of the three independent gates. ---
  const bs = summary.byStage || { acceptance: {}, pr: {}, ui: {} };
  const stageDefs = [
    ['Acceptance', bs.acceptance], ['PR review', bs.pr], ['UI review', bs.ui]
  ];
  const maxCount = Math.max(1, ...stageDefs.map(([, d]) => (d.open || 0) + (d.cleared || 0)));
  const stageBars = stageDefs.map(([label, d]) => {
    const open = d.open || 0, cleared = d.cleared || 0, total = open + cleared;
    const pct = Math.round((total / maxCount) * 100);
    const clearedPct = total ? Math.round((cleared / total) * 100) : 0;
    return `<div class="stage-bar">
      <div class="lbl">${label}</div>
      <div class="track"><div class="fill mid" style="width:${total ? pct : 0}%">
        <div class="fill done" style="width:${clearedPct}%"></div></div></div>
      <div class="cnt">${cleared}/${total}</div>
    </div>`;
  }).join('');

  // --- Per-round breakdown table (overall lifecycle) ---
  const lifecycle = ['in_development', 'in_review', 'done'];
  const rounds = Object.keys(summary.byRound).sort();
  const roundTable = `<table><thead><tr><th>Round</th>${lifecycle.map(s => `<th>${LABELS[s]}</th>`).join('')}</tr></thead>
    <tbody>${rounds.map(rd => `<tr><td><b>Round ${rd}</b></td>${
      lifecycle.map(s => `<td>${summary.byRound[rd][s] || 0}</td>`).join('')}</tr>`).join('')
      || `<tr><td colspan="${lifecycle.length + 1}" class="empty">No epics yet.</td></tr>`}</tbody></table>`;

  // --- Standings ---
  const standings = `<table><thead><tr><th>#</th><th>Team</th><th>Acceptance ★</th><th>PR ★</th><th>UI ★</th><th>Total ★</th><th>Avg score</th><th>Done</th><th>Rejections</th><th></th></tr></thead>
    <tbody>${lb.map((r, i) => {
      const team = STATE.teams.find(t => t.name === r.team);
      return `<tr>
        <td><span class="rank ${i === 0 ? '' : 'low'}">${i + 1}</span></td><td><b>${r.team}</b></td>
        <td style="color:var(--star)">${r.acceptance_stars}</td><td style="color:var(--star)">${r.pr_stars}</td><td style="color:var(--star)">${r.ui_stars}</td>
        <td>${r.total}</td><td class="big" style="color:var(--star)">${r.avg_score}</td>
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
// Which of this epic's parallel stages were rejected (need a resubmission).
function leadFailedStages(x) {
  const out = [];
  if (x.ba_status === 'failed') out.push('Acceptance');
  if (x.pr_status === 'failed') out.push('PR');
  return out;
}
// Show the submit/resubmit form when in development, or when any stage was rejected.
function leadNeedsSubmit(x) {
  return x.status === 'in_development' || leadFailedStages(x).length > 0;
}
// Show the per-stage chips once the epic has entered (or passed through) review.
function leadShowStages(x) {
  return x.status === 'in_review' || x.status === 'done' || leadFailedStages(x).length > 0;
}
function renderMyEpics(v) {
  const mine = STATE.assignments.filter(x => x.team_id === ME.team_id);
  if (!mine.length) return v.innerHTML = `<div class="empty">No epics yet. Pick a chit and ask the organizer to register it.</div>`;
  v.innerHTML = `<div class="page-title">My epics</div>
    <div class="section-title">Your team's work in flight</div>
    <div class="grid">${mine.map((x, i) => `
    <div class="card fade-up" style="animation-delay:${Math.min(i, 8) * 80}ms">
      <div class="row" style="justify-content:space-between"><h3>${x.epic_title || x.epic_number || 'Epic pending'}</h3>${badge(x.status)}</div>
      <div class="sub">${x.epic_number ? x.epic_number + ' · ' : ''}Round ${x.round} ${x.attempts > 1 ? `<span class="attempts">· attempt ${x.attempts}</span>` : ''}</div>
      ${pipe(x.status)}
      ${leadShowStages(x) ? stageChips(x) : ''}
      ${leadNeedsSubmit(x) ? `
        ${leadFailedStages(x).length ? `<div class="sub" style="color:var(--fail)">Rejected: ${leadFailedStages(x).join(', ')} — fix & resubmit. Only these stages will re-review.</div>` : ''}
        <div class="field" style="margin-top:8px"><label>PR link</label><input id="pr-${x.id}" placeholder="https://github.com/..." value="${(x.pr_link || '').replace(/"/g,'&quot;')}"></div>
        <button class="btn ok" onclick="submitPR(${x.id})">${x.status === 'in_development' && x.attempts === 1 ? 'Mark completed & submit PR' : 'Resubmit PR'}</button>` : ''}
      ${x.status === 'picked' ? `<div class="sub">⏳ Waiting for organizer to assign your epic number.</div>` : ''}
      ${x.pr_link && !leadNeedsSubmit(x) ? `<div class="sub">PR: <a href="${x.pr_link}" target="_blank">link</a></div>` : ''}
    </div>`).join('')}</div>`;
}
async function submitPR(id) {
  const link = $('#pr-' + id).value.trim();
  if (!link) return toast('Enter the PR link');
  await api('/api/lead/submit-pr', 'POST', { assignment_id: id, pr_link: link });
  toast('Submitted for Acceptance review'); await loadState(); renderView();
}

// ========== REVIEWERS: QUEUE ==========
// Each role owns one parallel stage; a stage is actionable when its column is 'open'.
const ROLE_STAGE = { ba: 'acceptance', pr: 'pr_review', ui: 'ui_review' };
const STAGE_COL = { acceptance: 'ba_status', pr_review: 'pr_status', ui_review: 'ui_status' };
const REVIEW_STAGES = ['acceptance', 'pr_review', 'ui_review'];
const STAGE_TITLE = { acceptance: 'Acceptance Criteria', pr_review: 'PR Review', ui_review: 'UI Review' };
// Is the given review stage open for action on this assignment?
function stageOpen(x, stage) { return x[STAGE_COL[stage]] === 'open'; }

function renderReviewQueue(v) {
  const isAdmin = ME.role === 'admin';
  // A reviewer sees every epic whose OWN stage is open — independent of the other
  // stages, so BA/PR/UI all work in parallel. Admin sees anything with any open stage.
  const myStage = ROLE_STAGE[ME.role];
  const queue = STATE.assignments.filter(x =>
    isAdmin ? REVIEW_STAGES.some(s => stageOpen(x, s)) : stageOpen(x, myStage));
  const heading = isAdmin ? `All epics in review` : STAGE_TITLE[myStage];
  v.innerHTML = `<div class="page-title">${heading}</div>
    <div class="section-title">${queue.length} item${queue.length === 1 ? '' : 's'} in the queue</div>` +
    (isAdmin ? `<div class="sub" style="margin-bottom:12px;color:var(--ink-soft)">As organizer you can act on any open stage on behalf of the assigned reviewer.</div>`
             : `<div class="sub" style="margin-bottom:12px;color:var(--ink-soft)">All review stages run in parallel — you can review as soon as the PR is submitted, regardless of the other stages.</div>`) +
    (queue.length ? `<div class="grid">${queue.map((x, i) => `
      <div class="card fade-up" style="animation-delay:${Math.min(i, 8) * 80}ms">
        <div class="row" style="justify-content:space-between"><h3>${x.epic_number}</h3>${badge(x.status)}</div>
        <div class="sub">${x.team_name} · Round ${x.round} ${x.attempts > 1 ? `<span class="attempts">· attempt ${x.attempts}</span>` : ''}</div>
        <div><b>${x.epic_title}</b></div>
        <div class="sub">${x.epic_desc || ''}</div>
        ${stageChips(x)}
        ${x.pr_link ? `<div class="sub">PR: <a href="${x.pr_link}" target="_blank">open PR</a></div>` : ''}
        <div class="act-btns">${isAdmin
          ? REVIEW_STAGES.filter(s => stageOpen(x, s)).map(s =>
              `<button class="btn sm" onclick="openReview(${x.id},'${s}')">Review: ${STAGE_TITLE[s]}</button>`).join('')
          : `<button class="btn block" onclick="openReview(${x.id},'${myStage}')">Review this epic</button>`}</div>
      </div>`).join('')}</div>`
      : `<div class="empty">🎉 Nothing in the queue right now.</div>`);
}

function openReview(id, stage) {
  const x = STATE.assignments.find(a => a.id === id);
  const bg = document.createElement('div'); bg.className = 'modal-bg';
  // The stage to review is passed explicitly (a reviewer's own stage, or the one
  // an admin clicked) — stages are independent, so we don't derive it from status.
  if (!stage) stage = ROLE_STAGE[ME.role];
  let inner = '';
  if (stage === 'acceptance') {
    inner = `
      <div class="field"><label>Acceptance rating</label>${starPicker('acceptance')}</div>
      <div class="field"><label>Comment (required if rejecting)</label><textarea id="cmt" rows="3"></textarea></div>
      <div class="row">
        <button class="btn ok" onclick="doPassFail(${id},'pass','acceptance')">Pass</button>
        <button class="btn bad" onclick="doPassFail(${id},'fail','acceptance')">Reject</button>
      </div>
      <p class="sub" style="margin-top:12px">Reject → only the Acceptance stage reopens; the team fixes & resubmits. Other stages keep their results.</p>`;
  } else if (stage === 'pr_review') {
    inner = `
      <div class="field"><label>PR rating</label>${starPicker('pr')}</div>
      <div class="field"><label>Comment (required if rejecting)</label><textarea id="cmt" rows="3"></textarea></div>
      <div class="row">
        <button class="btn ok" onclick="doPassFail(${id},'pass','pr_review')">Pass</button>
        <button class="btn bad" onclick="doPassFail(${id},'fail','pr_review')">Reject</button>
      </div>
      <p class="sub" style="margin-top:12px">Reject → only the PR stage reopens; the team fixes & resubmits. Other stages keep their results.</p>`;
  } else if (stage === 'ui_review') {
    inner = `
      <div class="field"><label>Design rating</label>${starPicker('ui')}</div>
      <div class="field"><label>Comment</label><textarea id="cmt" rows="2"></textarea></div>
      <button class="btn ok" onclick="doUI(${id})">Submit rating</button>
      <p class="sub" style="margin-top:8px">UI never fails — 0 stars allowed. The epic is marked Done once Acceptance, PR and UI have all cleared.</p>`;
  } else {
    inner = `<p class="sub">This stage is not open for review right now.</p>`;
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

async function doPassFail(id, outcome, stage) {
  const comment = $('#cmt').value.trim();
  if (outcome === 'fail' && !comment) return toast('Add a reason for rejection');
  const ep = stage === 'acceptance' ? 'acceptance' : 'pr';
  const payload = { assignment_id: id, outcome, comment };
  if (ep === 'acceptance') payload.stars = PICK.acceptance || 0;
  if (ep === 'pr') payload.stars = PICK.pr || 0;
  await api('/api/review/' + ep, 'POST', payload);
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
  document.querySelector('.modal-bg').remove();
  await loadState();
  // Confetti only when the UI rating actually completed the epic (all stages cleared).
  const x = STATE.assignments.find(a => a.id === id);
  if (x && x.status === 'done') { confetti(); toast('Rated — all stages cleared, epic done 🎉'); }
  else toast('UI rated ✓ (awaiting other stages)');
  renderView();
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
        <button class="btn" onclick="doPickup()">Register pickup</button>
      </div>
      <div class="card">
        <h3>② Assign epic number</h3>
        <div class="sub">Pick a waiting assignment and the epic drawn from the chit.</div>
        <div class="field"><label>Waiting assignment</label><select id="as-assign">${
          STATE.assignments.filter(a => a.status === 'picked').map(a =>
          `<option value="${a.id}">${a.team_name}</option>`).join('') || '<option value="">— none —</option>'}</select></div>
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

    <div class="section-title" style="margin-top:28px">Bonus points (team-wise)</div>
    <div class="sub" style="color:var(--ink-soft);margin-bottom:12px">Award extra weighted points for predefined criteria. Awards are editable — award again to update, or remove.</div>
    <div id="bonus-manager"></div>

    <div class="section-title" style="margin-top:28px">Master epic list (28)</div>
    <div id="epic-editor"></div>`;
  renderBonusManager();
  renderEpicEditor();
}

// ---- Bonus points manager (Organizer) ----
async function renderBonusManager() {
  const el = $('#bonus-manager');
  if (!el) return;
  const [criteria, bonuses] = await Promise.all([
    api('/api/bonus-criteria').catch(() => []),
    api('/api/bonuses').catch(() => ({ byTeam: {}, totals: {} }))
  ]);
  BONUS_CRITERIA_CACHE = criteria;
  const critOpts = criteria.map(c => `<option value="${c.key}">${c.label}</option>`).join('');
  el.innerHTML = STATE.teams.map(t => {
    const awarded = (bonuses.byTeam[t.id] || []);
    const total = bonuses.totals[t.id] || 0;
    const chips = awarded.map(b => `
      <span class="bonus-chip" title="${(b.note || '').replace(/"/g, '&quot;')}">
        ${b.label} <b>+${b.stars}★</b>
        <button class="bonus-x" title="Remove" onclick="removeBonus(${t.id},'${b.criterion}')">×</button>
      </span>`).join('') || `<span class="muted" style="color:var(--muted)">No bonuses yet.</span>`;
    return `<div class="bonus-team boxed">
      <div class="bonus-team-head">
        <b>${t.name}</b>
        <span class="bonus-total">Bonus total: <b>+${Math.round(total * 10) / 10}★</b></span>
      </div>
      <div class="bonus-chips">${chips}</div>
      <div class="bonus-form">
        <select id="bc-crit-${t.id}" onchange="onBonusCritChange(${t.id})">${critOpts}</select>
        <input id="bc-units-${t.id}" type="number" min="1" placeholder="count" style="display:none">
        <input id="bc-stars-${t.id}" type="number" min="0" step="0.5" placeholder="stars (auto)">
        <input id="bc-note-${t.id}" type="text" placeholder="note (optional)">
        <button class="btn sm ok" onclick="awardBonus(${t.id})">Award / Update</button>
      </div>
    </div>`;
  }).join('');
  STATE.teams.forEach(t => onBonusCritChange(t.id));
}
let BONUS_CRITERIA_CACHE = [];
function onBonusCritChange(teamId) {
  const key = $('#bc-crit-' + teamId).value;
  const crit = BONUS_CRITERIA_CACHE.find(c => c.key === key);
  const unitsEl = $('#bc-units-' + teamId);
  const starsEl = $('#bc-stars-' + teamId);
  if (crit && crit.type === 'scaled') {
    unitsEl.style.display = '';
    unitsEl.max = crit.maxUnits;
    unitsEl.placeholder = `1-${crit.maxUnits} ${crit.unitLabel || ''}`.trim();
    starsEl.placeholder = `auto (${crit.perUnit}/${crit.unitLabel || 'unit'})`;
  } else {
    unitsEl.style.display = 'none';
    starsEl.placeholder = crit ? `auto (${crit.weight}★)` : 'stars';
  }
}
async function awardBonus(teamId) {
  const criterion = $('#bc-crit-' + teamId).value;
  const unitsEl = $('#bc-units-' + teamId);
  const stars = $('#bc-stars-' + teamId).value.trim();
  const note = $('#bc-note-' + teamId).value.trim();
  const body = { team_id: teamId, criterion, note };
  if (stars !== '') body.stars = stars;
  if (unitsEl.style.display !== 'none') {
    const u = unitsEl.value.trim();
    if (u === '' && stars === '') return toast('Enter a platform count');
    if (u !== '') body.units = u;
  }
  try {
    await api('/api/admin/bonus', 'POST', body);
    toast('Bonus saved'); renderBonusManager();
  } catch (e) { toast(e.message || 'Failed'); }
}
async function removeBonus(teamId, criterion) {
  await api('/api/admin/bonus', 'DELETE', { team_id: teamId, criterion });
  toast('Bonus removed'); renderBonusManager();
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
  await api('/api/admin/pickup', 'POST', { team_id: +$('#pk-team').value });
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
