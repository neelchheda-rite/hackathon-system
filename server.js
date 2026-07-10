require('./loadenv'); // populate process.env from .env before anything reads it
const express = require('express');
const session = require('express-session');
const path = require('path');
const db = require('./db');
const config = require('./config');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: 'hackathon-2026-secret',
  resave: false,
  saveUninitialized: false,
  rolling: true, // refresh the cookie's expiry on every request so active users stay signed in
  cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 } // 7 days
}));

// ---- Pipeline definition ----
// status flow. "attempts" increments on every fail-reset back to development.
const STAGE_OF_STATUS = {
  acceptance: 'acceptance',
  pr_review: 'pr',
  ui_review: 'ui',
  integration: 'integration'
};

// ---- Audit logging: records EVERY action, including logins ----
const _audit = db.prepare(
  'INSERT INTO audit_log (user_id,username,role,action,detail,ip) VALUES (?,?,?,?,?,?)'
);
function audit(req, action, detail) {
  const u = req.session && req.session.user;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
  _audit.run(u ? u.id : null, u ? u.name : (req.body && req.body.username) || null,
    u ? u.role : null, action, detail || null, ip);
}

// ---- Notifications: alert a team's lead whenever their epic changes status ----
const _notify = db.prepare(
  'INSERT INTO notifications (user_id,assignment_id,type,message) VALUES (?,?,?,?)'
);
// Find the lead user for a team (leads have role='lead' and a team_id).
const _leadOfTeam = db.prepare("SELECT id FROM users WHERE role='lead' AND team_id=?");
// Notify the lead(s) of the team that owns the given assignment.
function notifyTeamLead(assignmentId, type, message) {
  const a = db.prepare('SELECT team_id FROM assignments WHERE id=?').get(assignmentId);
  if (!a) return;
  for (const lead of _leadOfTeam.all(a.team_id)) {
    _notify.run(lead.id, assignmentId, type, message);
  }
}
// A short human label for an assignment ("Epic 12 (Round 2)"), for notification text.
function assignmentLabel(assignmentId) {
  const a = db.prepare(`
    SELECT a.round, e.epic_number FROM assignments a
    LEFT JOIN epics e ON e.id = a.epic_id WHERE a.id=?`).get(assignmentId);
  if (!a) return `assignment #${assignmentId}`;
  return `${a.epic_number ? 'Epic ' + a.epic_number : 'Your epic'} (Round ${a.round})`;
}

function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Not logged in' });
  next();
}
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role))
      return res.status(403).json({ error: 'Forbidden' });
    next();
  };
}

// ---------- AUTH ----------
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE username=? AND password=?').get(username, password);
  if (!u) { audit(req, 'login_failed', `attempted username: ${username}`); return res.status(401).json({ error: 'Invalid credentials' }); }
  const team = u.team_id ? db.prepare('SELECT name FROM teams WHERE id=?').get(u.team_id) : null;
  req.session.user = { id: u.id, name: u.name, role: u.role, team_id: u.team_id, team_name: team ? team.name : null };
  audit(req, 'login', `${u.name} (${u.role}) signed in`);
  res.json(req.session.user);
});
app.post('/api/logout', (req, res) => { audit(req, 'logout', 'signed out'); req.session.destroy(() => res.json({ ok: true })); });
app.get('/api/me', (req, res) => res.json(req.session.user || null));

// ---------- ENV DOWNLOAD (any logged-in user) ----------
// Serves the shared backend .env so teams can drop it into their own repos.
// Login-gated: the file lives outside public/ and is never statically served.
app.get('/api/download/env', requireAuth, (req, res) => {
  const envPath = path.join(__dirname, '.env');
  audit(req, 'download_env', `${req.session.user.name} downloaded the shared .env`);
  // res.download uses sendFile, whose dotfiles option defaults to "ignore" —
  // that silently 404s any file starting with "." (e.g. .env). Allow it explicitly.
  res.download(envPath, '.env', { dotfiles: 'allow' }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: '.env not found on server' });
  });
});

// ---------- SHARED DATA ----------
function assignmentView() {
  return db.prepare(`
    SELECT a.*, t.name AS team_name,
           e.epic_number, e.title AS epic_title, e.description AS epic_desc
    FROM assignments a
    JOIN teams t ON t.id = a.team_id
    LEFT JOIN epics e ON e.id = a.epic_id
    ORDER BY a.round, t.name
  `).all();
}

app.get('/api/teams', requireAuth, (req, res) => res.json(db.prepare('SELECT * FROM teams ORDER BY name').all()));
app.get('/api/epics', requireAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM epics ORDER BY round, epic_number').all());
});
app.get('/api/assignments', requireAuth, (req, res) => {
  res.json(assignmentView());
});

app.get('/api/reviews/:aid', requireAuth, (req, res) => {
  res.json(db.prepare(`
    SELECT r.*, u.name AS reviewer_name FROM reviews r
    JOIN users u ON u.id = r.reviewer_id
    WHERE r.assignment_id=? ORDER BY r.created_at`).all(req.params.aid));
});

// ---------- ADMIN ----------
app.post('/api/admin/users', requireRole('admin'), (req, res) => {
  const { username, password, name, role, team_id } = req.body;
  try {
    const r = db.prepare('INSERT INTO users (username,password,name,role,team_id) VALUES (?,?,?,?,?)')
      .run(username, password, name, role, team_id || null);
    audit(req, 'create_user', `created ${role} "${username}" (${name})`);
    res.json({ id: r.lastInsertRowid });
  } catch (e) { res.status(400).json({ error: 'Username already exists' }); }
});
app.get('/api/admin/users', requireRole('admin'), (req, res) =>
  res.json(db.prepare('SELECT id,username,name,role,team_id FROM users ORDER BY role,name').all()));

// Rename a team (used everywhere the team is surfaced)
app.put('/api/admin/teams/:id', requireRole('admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE teams SET name=? WHERE id=?').run(name, req.params.id);
  audit(req, 'rename_team', `renamed team #${req.params.id} to "${name}"`);
  res.json({ ok: true });
});
// Rename a user (real name for reviewers/leads)
app.put('/api/admin/users/:id', requireRole('admin'), (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE users SET name=? WHERE id=?').run(name, req.params.id);
  audit(req, 'rename_user', `renamed user #${req.params.id} to "${name}"`);
  res.json({ ok: true });
});

app.post('/api/admin/epics', requireRole('admin'), (req, res) => {
  const { epic_number, round, title, description } = req.body;
  const r = db.prepare('INSERT INTO epics (epic_number,round,title,description) VALUES (?,?,?,?)')
    .run(epic_number, round, title, description);
  audit(req, 'create_epic', `added epic ${epic_number} (${title})`);
  res.json({ id: r.lastInsertRowid });
});
app.put('/api/admin/epics/:id', requireRole('admin'), (req, res) => {
  const { epic_number, round, title, description } = req.body;
  db.prepare('UPDATE epics SET epic_number=?,round=?,title=?,description=? WHERE id=?')
    .run(epic_number, round, title, description, req.params.id);
  audit(req, 'edit_epic', `edited epic ${epic_number} (${title})`);
  res.json({ ok: true });
});

// Org assigns the picked epic number to a team's assignment (after chit pickup)
app.post('/api/admin/assign-epic', requireRole('admin'), (req, res) => {
  const { assignment_id, epic_id } = req.body;
  const ep = db.prepare('SELECT epic_number, round FROM epics WHERE id=?').get(epic_id);
  db.prepare('UPDATE assignments SET epic_id=?, round=?, status=? WHERE id=?')
    .run(epic_id, ep ? ep.round : null, 'in_development', assignment_id);
  audit(req, 'assign_epic', `assigned ${ep ? ep.epic_number : epic_id} to assignment #${assignment_id}`);
  notifyTeamLead(assignment_id, 'assigned',
    `${assignmentLabel(assignment_id)} was assigned — development can start.`);
  res.json({ ok: true });
});
// Org confirms a chit pickup: creates the assignment row for a team (round set when epic is assigned)
app.post('/api/admin/pickup', requireRole('admin'), (req, res) => {
  const { team_id } = req.body;
  const r = db.prepare('INSERT INTO assignments (team_id,status) VALUES (?,?)')
    .run(team_id, 'picked');
  const tm = db.prepare('SELECT name FROM teams WHERE id=?').get(team_id);
  audit(req, 'register_pickup', `${tm ? tm.name : team_id} picked a chit`);
  res.json({ id: r.lastInsertRowid });
});

// ---------- TEAM LEAD ----------
app.post('/api/lead/submit-pr', requireRole('lead'), (req, res) => {
  const { assignment_id, pr_link } = req.body;
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment_id);
  if (!a || a.team_id !== req.session.user.team_id) return res.status(403).json({ error: 'Not your assignment' });
  db.prepare('UPDATE assignments SET pr_link=?, status=? WHERE id=?')
    .run(pr_link, 'acceptance', assignment_id);
  audit(req, 'submit_pr', `submitted PR for assignment #${assignment_id} (attempt ${a.attempts}): ${pr_link}`);
  res.json({ ok: true });
});

// ---------- REVIEWERS ----------
// Acceptance (BA) — pass/fail
app.post('/api/review/acceptance', requireRole('ba', 'admin'), (req, res) => {
  const { assignment_id, outcome, comment } = req.body; // pass|fail
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment_id);
  if (!a || a.status !== 'acceptance') return res.status(400).json({ error: 'Not at acceptance stage' });
  db.prepare(`INSERT INTO reviews (assignment_id,stage,reviewer_id,outcome,comment,attempt)
              VALUES (?,?,?,?,?,?)`)
    .run(assignment_id, 'acceptance', req.session.user.id, outcome, comment, a.attempts);
  if (outcome === 'pass') {
    db.prepare('UPDATE assignments SET status=? WHERE id=?').run('pr_review', assignment_id);
  } else {
    db.prepare('UPDATE assignments SET status=?, attempts=attempts+1 WHERE id=?').run('in_development', assignment_id);
  }
  audit(req, 'review_acceptance', `${outcome.toUpperCase()} acceptance for assignment #${assignment_id}${comment ? ' — ' + comment : ''}`);
  if (outcome === 'pass') {
    notifyTeamLead(assignment_id, 'acceptance_pass',
      `${assignmentLabel(assignment_id)} passed Acceptance — now in PR review.`);
  } else {
    notifyTeamLead(assignment_id, 'acceptance_fail',
      `${assignmentLabel(assignment_id)} was rejected at Acceptance — back to development. Reason: ${comment}`);
  }
  res.json({ ok: true });
});

// PR review — pass/fail (fail = full reset to development, must redo acceptance)
app.post('/api/review/pr', requireRole('pr', 'admin'), (req, res) => {
  const { assignment_id, outcome, comment } = req.body;
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment_id);
  if (!a || a.status !== 'pr_review') return res.status(400).json({ error: 'Not at PR stage' });
  db.prepare(`INSERT INTO reviews (assignment_id,stage,reviewer_id,outcome,comment,attempt)
              VALUES (?,?,?,?,?,?)`)
    .run(assignment_id, 'pr', req.session.user.id, outcome, comment, a.attempts);
  if (outcome === 'pass') {
    db.prepare('UPDATE assignments SET status=? WHERE id=?').run('ui_review', assignment_id);
  } else {
    db.prepare('UPDATE assignments SET status=?, attempts=attempts+1 WHERE id=?').run('in_development', assignment_id);
  }
  audit(req, 'review_pr', `${outcome.toUpperCase()} PR review for assignment #${assignment_id}${comment ? ' — ' + comment : ''}`);
  if (outcome === 'pass') {
    notifyTeamLead(assignment_id, 'pr_pass',
      `${assignmentLabel(assignment_id)} passed PR review — now in UI review.`);
  } else {
    notifyTeamLead(assignment_id, 'pr_fail',
      `${assignmentLabel(assignment_id)} was rejected at PR review — back to development. Reason: ${comment}`);
  }
  res.json({ ok: true });
});

// UI review — 0-5 stars, never fails; then branch merged
app.post('/api/review/ui', requireRole('ui', 'admin'), (req, res) => {
  const { assignment_id, stars, comment } = req.body;
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment_id);
  if (!a || a.status !== 'ui_review') return res.status(400).json({ error: 'Not at UI stage' });
  db.prepare(`INSERT INTO reviews (assignment_id,stage,reviewer_id,outcome,stars,comment,attempt)
              VALUES (?,?,?,?,?,?,?)`)
    .run(assignment_id, 'ui', req.session.user.id, 'rated', stars, comment, a.attempts);
  db.prepare('UPDATE assignments SET status=? WHERE id=?').run('integration', assignment_id);
  audit(req, 'review_ui', `rated UI ${stars}★ for assignment #${assignment_id} & merged`);
  notifyTeamLead(assignment_id, 'ui_rated',
    `${assignmentLabel(assignment_id)} got ${stars}★ in UI review & merged — now in Integration testing.`);
  res.json({ ok: true });
});

// Integration — stars per platform, never blocks; then done
app.post('/api/review/integration', requireRole('integration', 'admin'), (req, res) => {
  const { assignment_id, platform_stars, comment } = req.body; // {windows,web,android,ios,backend}
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment_id);
  if (!a || a.status !== 'integration') return res.status(400).json({ error: 'Not at integration stage' });
  // Combine the per-platform stars into ONE overall stage rating (average, 0-5).
  const vals = Object.values(platform_stars || {}).map(v => Number(v) || 0);
  const avg = vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : 0;
  db.prepare(`INSERT INTO reviews (assignment_id,stage,reviewer_id,outcome,stars,platform_stars,comment,attempt)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(assignment_id, 'integration', req.session.user.id, 'rated', avg, JSON.stringify(platform_stars), comment, a.attempts);
  db.prepare('UPDATE assignments SET status=? WHERE id=?').run('done', assignment_id);
  audit(req, 'review_integration', `integration for assignment #${assignment_id}: ${avg}★ (avg of ${JSON.stringify(platform_stars)})`);
  notifyTeamLead(assignment_id, 'integration_done',
    `${assignmentLabel(assignment_id)} finished Integration testing (${avg}★) — Done ✓`);
  res.json({ ok: true });
});

// ---------- NOTIFICATIONS (per logged-in user) ----------
// List this user's notifications (newest first) with the unread count.
app.get('/api/notifications', requireAuth, (req, res) => {
  const items = db.prepare(
    'SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50'
  ).all(req.session.user.id);
  const unread = db.prepare(
    'SELECT COUNT(*) c FROM notifications WHERE user_id=? AND read=0'
  ).get(req.session.user.id).c;
  res.json({ items, unread });
});
// Mark notifications read — a specific id, or all of this user's if no id given.
app.post('/api/notifications/read', requireAuth, (req, res) => {
  const { id } = req.body || {};
  if (id) {
    db.prepare('UPDATE notifications SET read=1 WHERE id=? AND user_id=?').run(id, req.session.user.id);
  } else {
    db.prepare('UPDATE notifications SET read=1 WHERE user_id=?').run(req.session.user.id);
  }
  res.json({ ok: true });
});

// ---------- AUDIT LOG (admin only) ----------
app.get('/api/admin/audit', requireRole('admin'), (req, res) => {
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 500').all());
});

// ---------- LEADERBOARD ----------
app.get('/api/leaderboard', requireAuth, (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY name').all();
  const out = teams.map(t => {
    const rows = db.prepare(`
      SELECT r.stage, r.stars, r.platform_stars FROM reviews r
      JOIN assignments a ON a.id = r.assignment_id
      WHERE a.team_id=? AND r.outcome='rated'`).all(t.id);
    let ui = 0, integ = 0;
    for (const r of rows) {
      if (r.stage === 'ui') ui += r.stars || 0;
      // Integration stage now stores one combined (average) star rating per review.
      if (r.stage === 'integration') integ += r.stars || 0;
    }
    integ = Math.round(integ * 10) / 10;
    const doneCount = db.prepare(`SELECT COUNT(*) c FROM assignments WHERE team_id=? AND status='done'`).get(t.id).c;
    const failCount = db.prepare(`
      SELECT COUNT(*) c FROM reviews r JOIN assignments a ON a.id=r.assignment_id
      WHERE a.team_id=? AND r.outcome='fail'`).get(t.id).c;
    return { team: t.name, ui_stars: ui, integration_stars: integ, total: ui + integ, epics_done: doneCount, rejections: failCount };
  }).sort((a, b) => b.total - a.total);
  res.json(out);
});

// ---------- ORG DASHBOARD (admin only) ----------
// Pipeline summary: counts by status, split by round.
app.get('/api/admin/pipeline-summary', requireRole('admin'), (req, res) => {
  const rows = db.prepare(`SELECT status, round, COUNT(*) c FROM assignments GROUP BY status, round`).all();
  const byStatus = {};
  const byRound = {};
  for (const r of rows) {
    byStatus[r.status] = (byStatus[r.status] || 0) + r.c;
    byRound[r.round] = byRound[r.round] || {};
    byRound[r.round][r.status] = r.c;
  }
  const total = db.prepare('SELECT COUNT(*) c FROM assignments').get().c;
  res.json({ byStatus, byRound, total });
});

// Reviewer activity: per reviewer, counts of pass/fail/rated and total.
app.get('/api/admin/reviewer-activity', requireRole('admin'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.name AS reviewer, u.role, r.stage, r.outcome, COUNT(*) c
    FROM reviews r JOIN users u ON u.id = r.reviewer_id
    GROUP BY r.reviewer_id, r.stage, r.outcome`).all();
  const map = {};
  for (const r of rows) {
    const k = r.reviewer + '||' + r.role;
    map[k] = map[k] || { reviewer: r.reviewer, role: r.role, pass: 0, fail: 0, rated: 0, total: 0 };
    if (r.outcome === 'pass') map[k].pass += r.c;
    else if (r.outcome === 'fail') map[k].fail += r.c;
    else if (r.outcome === 'rated') map[k].rated += r.c;
    map[k].total += r.c;
  }
  res.json(Object.values(map).sort((a, b) => b.total - a.total));
});

// Per-team report: every assignment for a team with its reviews.
app.get('/api/admin/team-report/:teamId', requireRole('admin'), (req, res) => {
  const teamId = req.params.teamId;
  const team = db.prepare('SELECT * FROM teams WHERE id=?').get(teamId);
  if (!team) return res.status(404).json({ error: 'No such team' });
  const assignments = db.prepare(`
    SELECT a.*, e.epic_number, e.title AS epic_title
    FROM assignments a LEFT JOIN epics e ON e.id = a.epic_id
    WHERE a.team_id=? ORDER BY a.round`).all(teamId);
  const getReviews = db.prepare(`
    SELECT r.stage, r.outcome, r.stars, r.platform_stars, r.comment, r.attempt, r.created_at,
           u.name AS reviewer_name
    FROM reviews r JOIN users u ON u.id = r.reviewer_id
    WHERE r.assignment_id=? ORDER BY r.created_at`);
  for (const a of assignments) a.reviews = getReviews.all(a.id);
  res.json({ team, assignments });
});

const PORT = process.env.PORT || config.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Hackathon system running on http://0.0.0.0:${PORT}`);
});
