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
// Overall lifecycle: picked -> in_development -> in_review -> done.
// Once a PR is submitted the three review stages (acceptance/BA, PR, UI) run IN
// PARALLEL, each tracked by its own column: ba_status, pr_status, ui_status.
// A reject only fails that one stage; the team resubmits and only failed stages
// reopen. The epic is Done once ba=passed, pr=passed and ui=rated.

// Recompute an assignment's overall `status` from its three parallel stages and
// persist it. Returns the new overall status.
function recomputeStatus(assignmentId) {
  const a = db.prepare('SELECT ba_status,pr_status,ui_status,status FROM assignments WHERE id=?').get(assignmentId);
  if (!a) return null;
  let status;
  if (a.ba_status === 'passed' && a.pr_status === 'passed' && a.ui_status === 'rated') {
    status = 'done';
  } else if (a.ba_status === 'pending' && a.pr_status === 'pending' && a.ui_status === 'pending') {
    // No stage has opened yet — either awaiting the epic assignment or in development.
    status = a.status === 'picked' ? 'picked' : 'in_development';
  } else {
    status = 'in_review';
  }
  db.prepare('UPDATE assignments SET status=? WHERE id=?').run(status, assignmentId);
  return status;
}

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
  // Open every review stage that isn't already passed/rated. A resubmission after a
  // partial reject reopens only the failed stages; stages that already passed stay put.
  const ba = a.ba_status === 'passed' ? 'passed' : 'open';
  const pr = a.pr_status === 'passed' ? 'passed' : 'open';
  const ui = a.ui_status === 'rated' ? 'rated' : 'open';
  db.prepare('UPDATE assignments SET pr_link=?, ba_status=?, pr_status=?, ui_status=? WHERE id=?')
    .run(pr_link, ba, pr, ui, assignment_id);
  recomputeStatus(assignment_id);
  audit(req, 'submit_pr', `submitted PR for assignment #${assignment_id} (attempt ${a.attempts}): ${pr_link}`);
  res.json({ ok: true });
});

// ---------- REVIEWERS ----------
// Acceptance (BA) — pass/fail
app.post('/api/review/acceptance', requireRole('ba', 'admin'), (req, res) => {
  const { assignment_id, outcome, comment, stars } = req.body; // pass|fail + 0-5 stars
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment_id);
  if (!a || a.ba_status !== 'open') return res.status(400).json({ error: 'Acceptance stage is not open for review' });
  db.prepare(`INSERT INTO reviews (assignment_id,stage,reviewer_id,outcome,stars,comment,attempt)
              VALUES (?,?,?,?,?,?,?)`)
    .run(assignment_id, 'acceptance', req.session.user.id, outcome, stars || 0, comment, a.attempts);
  if (outcome === 'pass') {
    db.prepare('UPDATE assignments SET ba_status=? WHERE id=?').run('passed', assignment_id);
  } else {
    // Only this stage fails; other stages keep their results. Bump attempts so the
    // team knows a resubmission is needed for the failed stage(s).
    db.prepare('UPDATE assignments SET ba_status=?, attempts=attempts+1 WHERE id=?').run('failed', assignment_id);
  }
  recomputeStatus(assignment_id);
  audit(req, 'review_acceptance', `${outcome.toUpperCase()} acceptance (${stars || 0}★) for assignment #${assignment_id}${comment ? ' — ' + comment : ''}`);
  if (outcome === 'pass') {
    notifyTeamLead(assignment_id, 'acceptance_pass',
      `${assignmentLabel(assignment_id)} passed Acceptance review.`);
  } else {
    notifyTeamLead(assignment_id, 'acceptance_fail',
      `${assignmentLabel(assignment_id)} was rejected at Acceptance — fix & resubmit. Reason: ${comment}`);
  }
  res.json({ ok: true });
});

// PR review — pass/fail. A fail only fails the PR stage; other stages are unaffected.
app.post('/api/review/pr', requireRole('pr', 'admin'), (req, res) => {
  const { assignment_id, outcome, comment, stars } = req.body;
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment_id);
  if (!a || a.pr_status !== 'open') return res.status(400).json({ error: 'PR stage is not open for review' });
  db.prepare(`INSERT INTO reviews (assignment_id,stage,reviewer_id,outcome,stars,comment,attempt)
              VALUES (?,?,?,?,?,?,?)`)
    .run(assignment_id, 'pr', req.session.user.id, outcome, stars || 0, comment, a.attempts);
  if (outcome === 'pass') {
    db.prepare('UPDATE assignments SET pr_status=? WHERE id=?').run('passed', assignment_id);
  } else {
    db.prepare('UPDATE assignments SET pr_status=?, attempts=attempts+1 WHERE id=?').run('failed', assignment_id);
  }
  recomputeStatus(assignment_id);
  audit(req, 'review_pr', `${outcome.toUpperCase()} PR review (${stars || 0}★) for assignment #${assignment_id}${comment ? ' — ' + comment : ''}`);
  if (outcome === 'pass') {
    notifyTeamLead(assignment_id, 'pr_pass',
      `${assignmentLabel(assignment_id)} passed PR review.`);
  } else {
    notifyTeamLead(assignment_id, 'pr_fail',
      `${assignmentLabel(assignment_id)} was rejected at PR review — fix & resubmit. Reason: ${comment}`);
  }
  res.json({ ok: true });
});

// UI review — 0-5 stars, never fails. Marks the UI stage rated; the epic reaches
// Done only once acceptance and PR have also passed (handled by recomputeStatus).
app.post('/api/review/ui', requireRole('ui', 'admin'), (req, res) => {
  const { assignment_id, stars, comment } = req.body;
  const a = db.prepare('SELECT * FROM assignments WHERE id=?').get(assignment_id);
  if (!a || a.ui_status !== 'open') return res.status(400).json({ error: 'UI stage is not open for review' });
  db.prepare(`INSERT INTO reviews (assignment_id,stage,reviewer_id,outcome,stars,comment,attempt)
              VALUES (?,?,?,?,?,?,?)`)
    .run(assignment_id, 'ui', req.session.user.id, 'rated', stars, comment, a.attempts);
  db.prepare('UPDATE assignments SET ui_status=? WHERE id=?').run('rated', assignment_id);
  const overall = recomputeStatus(assignment_id);
  audit(req, 'review_ui', `rated UI ${stars}★ for assignment #${assignment_id}${overall === 'done' ? ' — all stages passed, merged & done' : ''}`);
  if (overall === 'done') {
    notifyTeamLead(assignment_id, 'ui_rated',
      `${assignmentLabel(assignment_id)} got ${stars}★ in UI review — all stages passed, merged & Done ✓`);
  } else {
    notifyTeamLead(assignment_id, 'ui_rated',
      `${assignmentLabel(assignment_id)} got ${stars}★ in UI review (still awaiting other stages).`);
  }
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

// ---------- BONUS POINTS (team-wise extra points for predefined criteria) ----------
// The static list of criteria (with suggested default weights) any team can earn.
app.get('/api/bonus-criteria', requireAuth, (req, res) => res.json(config.BONUS_CRITERIA));

// All awarded bonuses, grouped by team_id, plus each team's bonus total.
app.get('/api/bonuses', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, t.name AS team_name, u.name AS awarded_by_name
    FROM bonuses b
    JOIN teams t ON t.id = b.team_id
    LEFT JOIN users u ON u.id = b.awarded_by
    ORDER BY b.team_id, b.criterion`).all();
  const byTeam = {};
  const totals = {};
  for (const r of rows) {
    (byTeam[r.team_id] = byTeam[r.team_id] || []).push(r);
    totals[r.team_id] = (totals[r.team_id] || 0) + r.stars;
  }
  res.json({ byTeam, totals });
});

// Award or update a team's bonus for a criterion (admin only). Upsert on
// (team_id, criterion): awarding the same criterion again updates the stars/note.
app.post('/api/admin/bonus', requireRole('admin'), (req, res) => {
  const { team_id, criterion, stars, units, note } = req.body;
  const crit = (config.BONUS_CRITERIA || []).find(c => c.key === criterion);
  if (!team_id || !crit) return res.status(400).json({ error: 'team_id and a valid criterion are required' });
  const team = db.prepare('SELECT name FROM teams WHERE id=?').get(team_id);
  if (!team) return res.status(404).json({ error: 'No such team' });

  // Resolve the point value. Priority: explicit stars override > scaled units*perUnit > flat weight.
  let pts, label = crit.label;
  if (stars != null && stars !== '') {
    pts = Number(stars);
  } else if (crit.type === 'scaled') {
    const n = Math.round(Number(units));
    if (!Number.isFinite(n) || n < 1 || n > (crit.maxUnits || Infinity))
      return res.status(400).json({ error: `Enter 1–${crit.maxUnits} ${crit.unitLabel || 'units'}` });
    pts = n * crit.perUnit;
    label = `${n}/${crit.maxUnits} ${crit.unitLabel || 'units'} completed`;
  } else {
    pts = crit.weight;
  }
  if (!Number.isFinite(pts) || pts < 0) return res.status(400).json({ error: 'stars must be a non-negative number' });

  db.prepare(`
    INSERT INTO bonuses (team_id, criterion, label, stars, note, awarded_by)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(team_id, criterion) DO UPDATE SET
      stars=excluded.stars, note=excluded.note, label=excluded.label,
      awarded_by=excluded.awarded_by, updated_at=datetime('now')
  `).run(team_id, criterion, label, pts, note || null, req.session.user.id);
  audit(req, 'award_bonus', `${team.name}: ${label} = +${pts}★${note ? ' — ' + note : ''}`);
  res.json({ ok: true });
});

// Remove a team's bonus for a criterion (admin only).
app.delete('/api/admin/bonus', requireRole('admin'), (req, res) => {
  const { team_id, criterion } = req.body;
  const r = db.prepare('DELETE FROM bonuses WHERE team_id=? AND criterion=?').run(team_id, criterion);
  audit(req, 'remove_bonus', `removed bonus "${criterion}" from team #${team_id}`);
  res.json({ ok: true, removed: r.changes });
});

// ---------- LEADERBOARD ----------
app.get('/api/leaderboard', requireRole('admin', 'ba', 'pr', 'ui', 'integration'), (req, res) => {
  const teams = db.prepare('SELECT * FROM teams ORDER BY name').all();
  const out = teams.map(t => {
    const rows = db.prepare(`
      SELECT r.stage, r.stars, r.outcome FROM reviews r
      JOIN assignments a ON a.id = r.assignment_id
      WHERE a.team_id=? AND r.stars IS NOT NULL
        AND (r.outcome='rated' OR r.outcome='pass')`).all(t.id);
    // Per-stage star sums across all of the team's rated reviews.
    let acceptance = 0, pr = 0, ui = 0;
    for (const r of rows) {
      const s = r.stars || 0;
      if (r.stage === 'acceptance') acceptance += s;
      else if (r.stage === 'pr') pr += s;
      else if (r.stage === 'ui') ui += s;
    }
    const reviewStars = acceptance + pr + ui;
    // Team-wise bonus points (weighted criteria) added on top of review stars.
    const bonus = db.prepare('SELECT COALESCE(SUM(stars),0) s FROM bonuses WHERE team_id=?').get(t.id).s;
    const total = reviewStars + bonus;
    // Final score = average star across every rated review (acceptance + PR + UI).
    const ratedCount = rows.length;
    const avg = ratedCount ? Math.round((reviewStars / ratedCount) * 10) / 10 : 0;
    const round1 = n => Math.round(n * 10) / 10;
    const doneCount = db.prepare(`SELECT COUNT(*) c FROM assignments WHERE team_id=? AND status='done'`).get(t.id).c;
    const failCount = db.prepare(`
      SELECT COUNT(*) c FROM reviews r JOIN assignments a ON a.id=r.assignment_id
      WHERE a.team_id=? AND r.outcome='fail'`).get(t.id).c;
    return {
      team: t.name,
      acceptance_stars: round1(acceptance), pr_stars: round1(pr), ui_stars: round1(ui),
      bonus_stars: round1(bonus),
      total: round1(total), avg_score: avg, ratings: ratedCount,
      epics_done: doneCount, rejections: failCount
    };
  }).sort((a, b) => b.avg_score - a.avg_score || b.total - a.total);
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
  // Per-stage progress across the three parallel review gates. "reviewing" = still
  // open for that stage; "cleared" = passed (BA/PR) or rated (UI).
  const stageRow = db.prepare(`
    SELECT
      SUM(ba_status='open')   AS ba_open,   SUM(ba_status='passed') AS ba_cleared, SUM(ba_status='failed') AS ba_failed,
      SUM(pr_status='open')   AS pr_open,   SUM(pr_status='passed') AS pr_cleared, SUM(pr_status='failed') AS pr_failed,
      SUM(ui_status='open')   AS ui_open,   SUM(ui_status='rated')  AS ui_cleared
    FROM assignments`).get();
  const byStage = {
    acceptance: { open: stageRow.ba_open || 0, cleared: stageRow.ba_cleared || 0, failed: stageRow.ba_failed || 0 },
    pr:         { open: stageRow.pr_open || 0, cleared: stageRow.pr_cleared || 0, failed: stageRow.pr_failed || 0 },
    ui:         { open: stageRow.ui_open || 0, cleared: stageRow.ui_cleared || 0, failed: 0 },
  };
  res.json({ byStatus, byRound, byStage, total });
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
