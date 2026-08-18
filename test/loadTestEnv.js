// Loads test-environment credentials from .env.test (gitignored via .env* in
// .gitignore) so they never need to be pasted anywhere or exported by hand.
// Deliberately tiny and dependency-free — this reads one file and sets process.env.
//
// Only TEST_* keys are honoured. That is the whole point: the integration suite
// must be incapable of silently picking up production credentials.
const fs = require("fs");
const path = require("path");

const file = path.join(__dirname, "..", ".env.test");
if (fs.existsSync(file)) {
  // Strip a UTF-8 BOM if present — PowerShell's Set-Content/Out-File add one by
  // default, which would otherwise corrupt the first key's NAME (TEST_SUPABASE_URL
  // becomes ﻿TEST_SUPABASE_URL and silently fails to match). This exact bug
  // broke ISOLATED_APPS_HOST earlier in this project, so it's guarded here.
  const raw = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(TEST_[A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) process.env[m[1]] = v;
  }
}
