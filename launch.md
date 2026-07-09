# Launch Guide — Hackathon 2026 Review Hub

**Everything runs in one Node process.** There is no separate database server and no
separate frontend build — `node server.js` starts it all:

- **DB** — SQLite via `better-sqlite3` (embedded, file-based `hackathon.db`). Created and
  seeded automatically on first run by `db.js`. No DB service to start.
- **Backend API** — Express, defined in `server.js`.
- **Frontend** — static files in `public/` (`index.html`, `app.js`, `style.css`) served by
  the same Express server.

App URL once running: **http://localhost:3000**

---

## First-time setup

```bash
cd h/Neel/Hackathon/Hackathon2026/hackathon-system
npm install
```

## Start the app

```bash
npm start
# equivalent to:
node server.js
```

That single command initializes/seeds the DB (first run only) and serves the API +
frontend on port **3000**. Open http://localhost:3000.

---

## Demo logins

| Role        | Username        | Password         |
|-------------|-----------------|------------------|
| Organizer   | `admin`         | `admin123`       |
| Team Lead   | `lead1`…`lead7` | `lead123`        |
| BA          | `ba1`, `ba2`    | `ba123`          |
| PR Reviewer | `pr1`, `pr2`    | `pr123`          |
| UI Designer | `ui1`, `ui2`    | `ui123`          |
| Integration | `integration1`, `integration2` | `integration123` |

(Source of truth: `config.js`.)

---

## Reset the database

Users/teams/epics are seeded **only on first run** (when the DB is empty). To re-seed after
editing `config.js`, stop the server and delete the DB files, then start again:

```bash
# stop the server first (Ctrl+C), then:
rm hackathon.db hackathon.db-shm hackathon.db-wal
npm start
```

> On Windows PowerShell: `Remove-Item hackathon.db*`

---

## Change the port

Edit `PORT` in `config.js` (default `3000`).
