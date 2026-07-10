// Tiny zero-dependency .env loader. Reads ./.env (if present) and populates
// process.env for any key not already set (real env vars win). Good enough for
// this hackathon tool — avoids adding a dotenv dependency.
const fs = require('fs');
const path = require('path');

try {
  const file = path.join(__dirname, '.env');
  const text = fs.readFileSync(file, 'utf8');
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Strip surrounding quotes if present.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key && !(key in process.env)) process.env[key] = val;
  }
} catch (e) {
  // No .env file — fine; rely on real environment variables.
}
