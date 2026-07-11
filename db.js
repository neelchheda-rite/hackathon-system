const Database = require('better-sqlite3');
const path = require('path');
const config = require('./config');

const db = new Database(path.join(__dirname, 'hackathon.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,              -- admin | lead | ba | pr | ui | integration
  team_id INTEGER                 -- only for leads
);

CREATE TABLE IF NOT EXISTS teams (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);

-- The static master list of 28 epics
CREATE TABLE IF NOT EXISTS epics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  epic_number TEXT NOT NULL,
  round INTEGER NOT NULL,
  title TEXT NOT NULL,
  description TEXT
);

-- An assignment = a team picked (a chit for) an epic; round is derived from the epic on assignment
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  round INTEGER,                  -- nullable: unknown until an epic is assigned (round follows the epic)
  epic_id INTEGER,                -- assigned by org after chit pickup (nullable until assigned)
  status TEXT NOT NULL DEFAULT 'picked',
  -- Overall lifecycle: picked -> in_development -> in_review -> done
  -- Once a PR is submitted the three review stages run IN PARALLEL, each with its
  -- own independent status below (a reject only affects that one stage).
  ba_status TEXT NOT NULL DEFAULT 'pending',  -- pending | open | passed | failed
  pr_status TEXT NOT NULL DEFAULT 'pending',  -- pending | open | passed | failed
  ui_status TEXT NOT NULL DEFAULT 'pending',  -- pending | open | rated
  pr_link TEXT,
  attempts INTEGER NOT NULL DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Every review action logged (audit trail + ratings)
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL,
  stage TEXT NOT NULL,            -- acceptance | pr | ui | integration
  reviewer_id INTEGER NOT NULL,
  outcome TEXT,                   -- pass | fail | rated
  stars INTEGER,                  -- overall stars (ui) or null
  platform_stars TEXT,           -- JSON {windows,web,android,ios,backend} for integration
  comment TEXT,
  attempt INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Bonus points awarded to a team for meeting predefined criteria (e.g.
-- multilingual support, N/4 platforms completed). Editable per team: one row
-- per (team, criterion). `stars` is the weighted point value actually awarded;
-- it defaults from the criterion's suggested weight but the organizer can tune it.
CREATE TABLE IF NOT EXISTS bonuses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  criterion TEXT NOT NULL,         -- key from config.BONUS_CRITERIA, e.g. 'multilingual', 'platforms_4'
  label TEXT NOT NULL,             -- human label snapshot at award time
  stars REAL NOT NULL,             -- weighted bonus points awarded
  note TEXT,                       -- optional organizer note
  awarded_by INTEGER,              -- user id of the organizer who awarded it
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(team_id, criterion)       -- one award per criterion per team (update in place)
);
CREATE INDEX IF NOT EXISTS idx_bonuses_team ON bonuses (team_id);

-- Per-user notifications (team leads are notified of status changes to their epics)
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,        -- recipient (a team lead)
  assignment_id INTEGER,           -- the epic/assignment this is about (nullable)
  type TEXT NOT NULL,              -- assigned | acceptance_pass | acceptance_fail | pr_pass | pr_fail | ui_rated | integration_done ...
  message TEXT NOT NULL,           -- human-readable summary
  read INTEGER NOT NULL DEFAULT 0, -- 0 = unread, 1 = read
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, read);

-- Full audit trail: every action, including logins
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,                -- null for failed logins where user unknown
  username TEXT,                  -- captured even on failed login attempts
  role TEXT,
  action TEXT NOT NULL,           -- e.g. login, login_failed, logout, submit_pr, review_acceptance...
  detail TEXT,                    -- human-readable summary
  ip TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

// ---- Migration: relax assignments.round to nullable (round now follows the epic) ----
// Older DBs were created with `round INTEGER NOT NULL`; a chit pickup no longer knows
// the round up front, so rebuild the table if the column is still NOT NULL.
const roundCol = db.prepare(`SELECT "notnull" FROM pragma_table_info('assignments') WHERE name='round'`).get();
if (roundCol && roundCol.notnull === 1) {
  db.exec(`
    PRAGMA foreign_keys=off;
    BEGIN TRANSACTION;
    CREATE TABLE assignments_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team_id INTEGER NOT NULL,
      round INTEGER,
      epic_id INTEGER,
      status TEXT NOT NULL DEFAULT 'picked',
      pr_link TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now'))
    );
    INSERT INTO assignments_new (id,team_id,round,epic_id,status,pr_link,attempts,created_at)
      SELECT id,team_id,round,epic_id,status,pr_link,attempts,created_at FROM assignments;
    DROP TABLE assignments;
    ALTER TABLE assignments_new RENAME TO assignments;
    COMMIT;
    PRAGMA foreign_keys=on;
  `);
}

// ---- Migration: add per-stage parallel-review columns to assignments ----
// The pipeline moved from sequential gates (one `status` marching through the
// stages) to three independent stages that review in parallel. Older DBs lack
// the ba_status/pr_status/ui_status columns; add them and backfill from the old
// single status so in-flight epics keep their progress.
{
  const cols = db.prepare(`SELECT name FROM pragma_table_info('assignments')`).all().map(c => c.name);
  const addStage = (col) => {
    if (!cols.includes(col)) {
      const def = col === 'ui_status' ? 'pending' : 'pending';
      db.exec(`ALTER TABLE assignments ADD COLUMN ${col} TEXT NOT NULL DEFAULT '${def}'`);
    }
  };
  const needMigrate = !cols.includes('ba_status');
  addStage('ba_status'); addStage('pr_status'); addStage('ui_status');
  if (needMigrate) {
    // Backfill: translate each row's legacy single status into the three stages.
    // Legacy order was acceptance -> pr_review -> ui_review -> done, so a row that
    // reached (say) pr_review means acceptance already passed and pr is open.
    const rows = db.prepare('SELECT id, status FROM assignments').all();
    const upd = db.prepare('UPDATE assignments SET ba_status=?, pr_status=?, ui_status=? WHERE id=?');
    const map = {
      picked:         ['pending', 'pending', 'pending'],
      in_development: ['pending', 'pending', 'pending'],
      acceptance:     ['open',    'open',    'open'],
      pr_review:      ['passed',  'open',    'open'],
      ui_review:      ['passed',  'passed',  'open'],
      done:           ['passed',  'passed',  'rated'],
    };
    for (const r of rows) {
      const [ba, pr, ui] = map[r.status] || ['pending', 'pending', 'pending'];
      upd.run(ba, pr, ui, r.id);
    }
    // Collapse the legacy per-stage statuses into the new overall lifecycle value.
    db.exec(`UPDATE assignments SET status='in_review'
             WHERE status IN ('acceptance','pr_review','ui_review')`);
  }
}

// ---- Seed once from config.js ----
const seeded = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (seeded === 0) {
  const insTeam = db.prepare('INSERT INTO teams (name) VALUES (?)');
  const teamIdByName = {};
  for (const name of config.TEAMS) teamIdByName[name] = insTeam.run(name).lastInsertRowid;

  const insUser = db.prepare('INSERT INTO users (username,password,name,role,team_id) VALUES (?,?,?,?,?)');
  for (const u of config.USERS) {
    const teamId = u.team ? teamIdByName[u.team] : null;
    if (u.role === 'lead' && !teamId) console.warn(`WARN: lead "${u.username}" has unknown team "${u.team}"`);
    insUser.run(u.username, u.password, u.name, u.role, teamId || null);
  }

  const insEpic = db.prepare('INSERT INTO epics (epic_number,round,title,description) VALUES (?,?,?,?)');
  for (const e of config.EPICS) insEpic.run(e.epic_number, e.round, e.title, e.description || '');

  console.log(`Seeded: ${config.TEAMS.length} teams, ${config.USERS.length} users, ${config.EPICS.length} epics.`);
}

module.exports = db;
