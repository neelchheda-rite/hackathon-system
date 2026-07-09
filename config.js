// ============================================================================
//  HACKATHON 2026 — SINGLE SOURCE OF TRUTH
//  Edit teams, users (logins/passwords), and the 28 epics HERE.
//  These values seed the database on FIRST run only.
//  To re-apply after editing: stop the server, delete hackathon.db*, restart.
// ============================================================================

// ---- Server ----
const PORT = 3000;

// ---- Teams (7) ----
const TEAMS = ['Codastra', 'Promptastic Four', 'Nexus Four', 'Code Cartel', 'Chakravyuh Breakers', 'The Bug Hunters', 'ClauPilots'];

// ---- Users / Logins ----
// role: admin | lead | ba | pr | ui | integration
// team is the TEAM NAME (from TEAMS above) — required for leads, ignore for others.
const USERS = [
  // ---- Organizer / Admin ----
  { username: 'rite', password: 'rite2026', name: 'Rite Technologies', role: 'admin' },

  // ---- Team Leads (one per team) ----
  { username: 'heth', password: 'heth01', name: 'Heth Chheda', role: 'lead', team: 'Codastra' },
  { username: 'nikhil', password: 'nikhil02', name: 'Nikhil Gavandi', role: 'lead', team: 'Promptastic Four' },
  { username: 'pranit', password: 'pranit03', name: 'Pranit Khakal', role: 'lead', team: 'Nexus Four' },
  { username: 'nidhi', password: 'nidhi04', name: 'Nidhi Bhatt', role: 'lead', team: 'Code Cartel' },
  { username: 'satish', password: 'satish05', name: 'Satish Umathe', role: 'lead', team: 'Chakravyuh Breakers' },
  { username: 'anushka', password: 'anushka06', name: 'Anushka Menon', role: 'lead', team: 'The Bug Hunters' },
  { username: 'murtaza', password: 'murtaza07', name: 'Murtaza Baranwala', role: 'lead', team: 'ClauPilots' },

  // ---- BAs (Acceptance Criteria review) — 2 ----
  { username: 'priti', password: 'priti11', name: 'Priti Mehta', role: 'ba' },
  { username: 'uma', password: 'uma12', name: 'Uma Iyer', role: 'ba' },

  // ---- PR Reviewers — 2 ----
  { username: 'chetan', password: 'chetan13', name: 'Chetan Patil', role: 'pr' },
  { username: 'amit', password: 'amit14', name: 'Amit Gupta', role: 'pr' },

  // ---- UI Designer — 1 ----
  { username: 'siddesh', password: 'siddesh15', name: 'Siddesh Shinde', role: 'ui' },

  // ---- Integration Testers — 2 ----
  { username: 'dishant', password: 'dishant16', name: 'Dishant', role: 'integration' },
  { username: 'kabir', password: 'kabir17', name: 'Kabir', role: 'integration' },
];

// ---- The 28 static epics (4 rounds x 7) ----
// Replace these placeholders with your real epic numbers, titles & descriptions.
const EPICS = [];
let _n = 1;
for (let round = 1; round <= 4; round++) {
  for (let e = 1; e <= 7; e++) {
    EPICS.push({
      epic_number: 'EP-' + String(_n).padStart(3, '0'),
      round,
      title: 'Epic ' + _n + ' (Round ' + round + ')',
      description: 'Placeholder description for epic ' + _n + '. Edit in config.js or the Admin panel.',
    });
    _n++;
  }
}
// --- OR, replace the loop above with an explicit list, e.g.:
// const EPICS = [
//   { epic_number: 'EP-001', round: 1, title: 'User Authentication', description: '...' },
//   ...
// ];

module.exports = { PORT, TEAMS, USERS, EPICS };
