// ============================================================================
//  GitHub integration — enriches epics with their milestone on the repo board.
//
//  Each epic (EP-001 .. EP-028) maps to a GitHub milestone of the same number:
//    EP-028  ->  milestone #28  ("Epic 28: System Integration Final Readiness")
//  We surface the milestone's TITLE (as the card header) and URL (a redirect
//  link on the card). Everything is best-effort: if the token is missing or
//  GitHub is unreachable, epics simply fall back to their config.js text.
//
//  Auth: set GITHUB_TOKEN in the environment (e.g. an untracked .env file).
//  NEVER commit the token.
// ============================================================================

const https = require('https');

const OWNER = process.env.GITHUB_OWNER || 'Rite-Technologies-23';
const REPO = process.env.GITHUB_REPO || 'hackathon';
const TOKEN = process.env.GITHUB_TOKEN || '';
const REFRESH_MS = 5 * 60 * 1000; // re-sync every 5 minutes

// epic_number (e.g. "EP-028") -> { title, url, description, state }
let _byEpic = {};
let _lastSync = 0;
let _lastError = null;
let _inFlight = null;

// "EP-028" -> 28 ; "EP-3" -> 3 ; anything unparseable -> null
function epicToMilestoneNumber(epicNumber) {
  const m = String(epicNumber || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function graphql(query) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ query });
    const req = https.request({
      hostname: 'api.github.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        Authorization: 'bearer ' + TOKEN,
        'User-Agent': 'hackathon-app',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`GitHub HTTP ${res.statusCode}: ${data.slice(0, 200)}`));
        let json;
        try { json = JSON.parse(data); } catch (e) { return reject(new Error('Bad JSON from GitHub')); }
        if (json.errors) return reject(new Error(json.errors.map((e) => e.message).join('; ')));
        resolve(json.data);
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Pull all milestones (there are 28; one page of 100 is plenty) and index them
// by the derived epic number "EP-0NN".
async function sync() {
  if (!TOKEN) { _lastError = 'GITHUB_TOKEN not set'; return; }
  const query = `query {
    repository(owner: "${OWNER}", name: "${REPO}") {
      milestones(first: 100, orderBy: {field: NUMBER, direction: ASC}) {
        nodes { number title url description state }
      }
    }
  }`;
  const data = await graphql(query);
  const nodes = (data.repository && data.repository.milestones && data.repository.milestones.nodes) || [];
  const next = {};
  for (const m of nodes) {
    const key = 'EP-' + String(m.number).padStart(3, '0');
    next[key] = { title: m.title, url: m.url, description: m.description || '', state: m.state };
  }
  _byEpic = next;
  _lastSync = new Date().toISOString();
  _lastError = null;
}

// Kick off a sync if the cache is stale; never throw to callers.
function ensureFresh() {
  if (!TOKEN) return Promise.resolve();
  if (_inFlight) return _inFlight;
  const stale = !_lastSync || (typeof _lastSync === 'string' && (Date.now() - Date.parse(_lastSync)) > REFRESH_MS);
  if (!stale) return Promise.resolve();
  _inFlight = sync()
    .catch((e) => { _lastError = e.message; })
    .finally(() => { _inFlight = null; });
  return _inFlight;
}

// Force a refresh (used by the admin "Sync" button). Resolves to status.
async function refresh() {
  try { await sync(); } catch (e) { _lastError = e.message; }
  return status();
}

function status() {
  return {
    enabled: !!TOKEN,
    owner: OWNER,
    repo: REPO,
    count: Object.keys(_byEpic).length,
    lastSync: _lastSync || null,
    error: _lastError,
  };
}

// Look up the GitHub milestone info for one epic number. { title, url } or null.
function forEpic(epicNumber) {
  return _byEpic[epicNumber] || null;
}

module.exports = { ensureFresh, refresh, status, forEpic, epicToMilestoneNumber };
