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

-- An assignment = a team picked (a chit for) an epic in a given round
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id INTEGER NOT NULL,
  round INTEGER NOT NULL,
  epic_id INTEGER,                -- assigned by org after chit pickup (nullable until assigned)
  status TEXT NOT NULL DEFAULT 'picked',
  -- picked -> in_development -> ready_review -> acceptance -> pr_review -> ui_review -> merged -> integration -> done
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
