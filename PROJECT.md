# Hackathon 2026 — Review Hub

A small web app that runs the **epic review pipeline** for an internal hackathon.
Teams pick "chits" (epics), build them, and the epic flows through a series of review
gates (BA acceptance → PR review → UI rating → integration testing) until it's done.
The organizer oversees everything; a leaderboard/dashboard aggregates the results.

This doc is the orientation for anyone (human or a fresh AI session) picking up the project.

---

## Tech stack

- **Runtime:** Node.js (single process — no separate DB server, no frontend build step).
- **Backend:** Express (`server.js`) + `express-session` for cookie sessions.
- **Database:** SQLite via `better-sqlite3`, file `hackathon.db` (WAL mode). Schema +
  seed live in `db.js`; seed data (teams, users, epics) comes from `config.js` and is
  applied **only on first run** (when the users table is empty).
- **Frontend:** Plain vanilla JS + HTML + CSS in `public/` — no framework.
  - `public/index.html` — shell, loads `app.js?v=N` (bump `N` to bust cache).
  - `public/app.js` — the entire SPA (renders per role, calls the API).
  - `public/style.css` — all styling (CSS variables at top).

Start it: `npm start` (= `node server.js`) → http://localhost:3000. Listens on
`0.0.0.0` so it's reachable on the local network (phones on same Wi-Fi). See
[launch.md](launch.md) for commands and DB reset.

---

## Roles & logins

Defined in `config.js`. Passwords are demo-grade plaintext (this is an internal tool).

| Role          | Users                          | What they do                                    |
|---------------|--------------------------------|-------------------------------------------------|
| `admin`       | admin                          | Organizer — runs the whole show (see below)     |
| `lead`        | lead1…lead7 (one per team)     | Submit PR link once their epic is built         |
| `ba`          | ba1, ba2                       | Acceptance review — **pass/fail** gate          |
| `pr`          | pr1, pr2                       | PR review — **pass/fail** gate                  |
| `ui`          | ui1, ui2                       | UI review — **0–5 star** rating (never fails)   |
| `integration` | integration1, integration2     | Integration test — **per-platform stars**       |

Demo passwords: `admin123`, `lead123`, `ba123`, `pr123`, `ui123`, `integration123`.

---

## The pipeline (epic lifecycle)

Status flow (constant `FLOW` in app.js, enforced in server.js):

```
picked → in_development → acceptance → pr_review → ui_review → integration → done
```

1. **picked** — Organizer registers a chit pickup for a team+round (`/api/admin/pickup`).
2. **in_development** — Organizer assigns the drawn epic number to that pickup
   (`/api/admin/assign-epic`); development starts.
3. **acceptance** — Team lead submits the PR link (`/api/lead/submit-pr`), which moves
   the epic to acceptance. BA passes or rejects (`/api/review/acceptance`).
4. **pr_review** — PR reviewer passes or rejects (`/api/review/pr`).
5. **ui_review** — UI designer gives 0–5 stars, then branch "merges"
   (`/api/review/ui`). Never fails.
6. **integration** — Integration tester rates each platform
   (windows/web/android/ios/backend) with stars (`/api/review/integration`). The five
   platform ratings are **averaged into one 0–5 star rating** for the stage (stored in
   `reviews.stars`; the raw per-platform values are kept in `platform_stars`). Never fails.
7. **done** ✓

**Rejection rule:** a BA or PR **reject** sends the epic back to `in_development`,
increments `attempts`, and requires redoing from acceptance. Rejection requires a comment.

Only two stages award stars: **UI** and **Integration**. BA and PR are pass/fail gates
(intentional — no star rating there).

**Notifications:** every status change to an epic notifies that team's **lead** (the
owning team's `lead` user). Triggers: epic assigned, acceptance pass/fail, PR pass/fail,
UI rated, integration done. Delivered two ways — an in-app bell (🔔) in the topbar with an
unread count + dropdown (polls `/api/notifications` every 15s), and an optional browser
push (Web Notifications API) when the lead has the tab open and has granted permission.
Rejections include the reviewer's comment. Notifications are scoped per team — lead N never
sees team M's activity. See the `notifications` table in db.js and `notifyTeamLead()` in server.js.

---

## Screens (tabs) by role

Driven by `TABS_BY_ROLE` in app.js.

- **admin:** Dashboard, Review Queue, Live Pipeline, Organizer, Leaderboard, Audit Log
- **lead:** My Epics, Live Pipeline, Leaderboard
- **ba/pr/ui/integration:** My Review Queue, Live Pipeline, Leaderboard

### Organizer powers (admin)
- **Organizer tab:** register chit pickups, assign epic numbers, edit the master epic list.
- **Review Queue tab:** admin sees **every** epic currently at any review stage and can act
  on it (pass/fail or rate) **on behalf of** the assigned reviewer. The review endpoints
  allow role `admin` in addition to the specific reviewer role. The modal picks its
  action UI from the epic's *current stage*, not the logged-in role.
- **Dashboard tab:** KPI tiles (total/done/in-review/in-dev/total stars), pipeline summary
  by stage + per-round breakdown, and team standings (with a per-team drill-down **Report**
  modal showing every assignment and its reviews/comments/stars).

---

## Data model (SQLite — see db.js)

- **users** — id, username, password, name, role, team_id (team_id only for leads).
- **teams** — id, name (7 teams).
- **epics** — the static master list (28 = 4 rounds × 7): epic_number, round, title, description.
- **assignments** — a team's pickup of an epic in a round: team_id, round, epic_id
  (nullable until assigned), status, pr_link, attempts.
- **reviews** — audit of every review action: assignment_id, stage
  (`acceptance|pr|ui|integration`), reviewer_id, outcome (`pass|fail|rated`), stars,
  platform_stars (JSON for integration), comment, attempt.
- **audit_log** — every action incl. logins/failed logins: user, role, action, detail, ip.
- **notifications** — per-user alerts (team leads): user_id, assignment_id, type, message,
  read (0/1), created_at.

---

## Key API endpoints (server.js)

| Method | Path | Role | Purpose |
|--------|------|------|---------|
| POST | `/api/login`, `/api/logout` | — | Auth (session cookie) |
| GET  | `/api/me` | — | Current user or null |
| GET  | `/api/teams`, `/api/epics`, `/api/assignments` | any auth | Shared state |
| POST | `/api/admin/pickup` | admin | Register a chit pickup |
| POST | `/api/admin/assign-epic` | admin | Assign epic → start dev |
| POST/PUT | `/api/admin/epics[/:id]` | admin | Add/edit master epics |
| POST | `/api/lead/submit-pr` | lead | Submit PR → acceptance |
| POST | `/api/review/acceptance` | ba, **admin** | Pass/fail |
| POST | `/api/review/pr` | pr, **admin** | Pass/fail |
| POST | `/api/review/ui` | ui, **admin** | Star rating |
| POST | `/api/review/integration` | integration, **admin** | Platform stars |
| GET  | `/api/leaderboard` | any auth | Aggregated standings |
| GET  | `/api/admin/pipeline-summary` | admin | Counts by stage & round |
| GET  | `/api/admin/reviewer-activity` | admin | Per-reviewer counts |
| GET  | `/api/admin/team-report/:teamId` | admin | One team's epics + reviews |
| GET  | `/api/admin/audit` | admin | Latest 500 audit entries |
| GET  | `/api/notifications` | any auth | Current user's notifications + unread count |
| POST | `/api/notifications/read` | any auth | Mark one (`{id}`) or all notifications read |

---

## Gotchas / conventions

- **Cache-busting:** `app.js` is loaded as `app.js?v=N` in index.html. After editing
  `app.js`, bump `N` so browsers (especially phones) reload it.
- **Reset the DB** to re-seed from an edited `config.js`: stop server, delete
  `hackathon.db*`, restart. (`Remove-Item hackathon.db*` on Windows.)
- **Inline `onclick` handlers** call top-level functions in app.js — keep those functions
  global (not nested), or the buttons break.
- **`stage` naming mismatch:** the `reviews.stage` value is `pr` but the status/badge is
  `pr_review` (and `ui` vs `ui_review`). Map when rendering badges.
- Single source of truth for teams/users/epics is `config.js`.
