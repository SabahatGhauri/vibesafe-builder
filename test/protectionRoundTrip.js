// Phase 3B against the real Vercel API.
//
// The open question this answers: can a PROJECT-SCOPED token change project
// settings at all? If it cannot, Make Public must tell the user to do it in
// their Vercel dashboard rather than asking them for a more powerful token.
//
// It restores whatever it found at the end, whether or not the test passes.

require("./loadTestEnv");

const v = require("../lib/deployVercel");
const TOKEN = process.env.TEST_VERCEL_TOKEN;

if (!TOKEN) {
  console.error("No TEST_VERCEL_TOKEN in .env.test — refusing to run.");
  process.exit(1);
}

let pass = 0;
let fail = 0;
const check = (name, ok, detail = "") => {
  (ok ? pass++ : fail++);
  console.log("  " + (ok ? "✓" : "✗") + " " + name + (!ok && detail ? " — " + detail : ""));
};

(async () => {
  const info = await v.inspectToken(TOKEN);
  if (!info.ok) {
    console.error("Token rejected: " + info.error);
    process.exit(1);
  }
  const project = info.projects[0];
  console.log("Project : " + project.name + "  (scope: " + info.scope + ")");
  console.log("");

  const original = await v.getProtection(TOKEN, project.id);
  console.log("Starting protection: " + JSON.stringify({ protected: original.protected, sso: original.sso }));
  console.log("");

  let changed = false;

  try {
    console.log("1. THE OPEN QUESTION — can this token change project settings?");
    let canWrite = true;
    let writeErr = null;
    try {
      await v.setProtection(TOKEN, project.id, { enabled: false });
      changed = true;
    } catch (err) {
      canWrite = false;
      writeErr = err;
    }

    if (!canWrite) {
      console.log("  ✗ DENIED — status " + writeErr.status + ": " + writeErr.message);
      console.log("");
      console.log("  A project-scoped token CANNOT change protection.");
      console.log("  Make Public must send the user to their Vercel dashboard.");
      check("the denial is a 403 the route maps to a helpful message", writeErr.status === 403, "got " + writeErr.status);
      return;
    }
    check("a project-scoped token CAN change protection", true);

    console.log("");
    console.log("2. Did the setting actually change?");
    const after = await v.getProtection(TOKEN, project.id);
    check("protection now reads as off", after.protected === false, JSON.stringify(after));

    console.log("");
    console.log("3. Is the site genuinely reachable by an anonymous visitor?");
    const deployments = await v.listDeployments(TOKEN, { projectId: project.id, limit: 1 });
    const url = deployments.length ? deployments[0].url : null;
    console.log("     " + url);
    const access = await v.checkPublicAccess(url);
    console.log("     status " + access.status + " — " + access.reason);
    check("the deployment is publicly accessible", access.public === true, access.reason);

    console.log("");
    console.log("4. Restoring protection (Make Private)");
    const restored = await v.setProtection(TOKEN, project.id, {
      enabled: true,
      deploymentType: typeof original.sso === "string" ? original.sso : undefined,
    });
    check("protection is on again", restored.protected === true, JSON.stringify(restored));
    check(
      "the ORIGINAL mode was restored, not a default",
      restored.sso === original.sso,
      "was " + original.sso + ", now " + restored.sso
    );
    changed = false;

    console.log("");
    console.log("5. Is the site private again?");
    const reCheck = await v.checkPublicAccess(url);
    console.log("     status " + reCheck.status + " — " + reCheck.reason);
    check("anonymous visitors are blocked again", reCheck.public === false, reCheck.reason);
  } finally {
    // Never leave the project more exposed than it was found.
    if (changed) {
      console.log("");
      console.log("Restoring protection after an error…");
      try {
        await v.setProtection(TOKEN, project.id, {
          enabled: original.protected === true,
          deploymentType: typeof original.sso === "string" ? original.sso : undefined,
        });
        console.log("  restored.");
      } catch (err) {
        console.log("  COULD NOT RESTORE — turn protection back on manually: " + err.message);
      }
    }
    console.log("");
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
