// Shared test harness for the Vercel routes: a Supabase stand-in that keeps rows
// in memory, a fetch stub that makes the real Vercel API unreachable, and a tiny
// request helper. Extracted once a second test file needed the same setup —
// two copies of a harness drift, and only one copy gets fixed.

const express = require("express");
const { registerVercelRoutes } = require("../lib/vercelRoutes");
const vercelLib = require("../lib/deployVercel");

/* ---------------- harness ---------------- */

// A Supabase stand-in that keeps rows in memory and records every write, so a
// test can assert on what was actually persisted rather than on a return value.
function fakeSupabase(seed = {}) {
  const tables = { vercel_connections: [], deployment_events: [], ...seed };
  function from(name) {
    const rows = (tables[name] = tables[name] || []);
    const filters = [];
    const q = {
      select() {
        return q;
      },
      eq(col, val) {
        filters.push([col, val]);
        return q;
      },
      order() {
        return q;
      },
      limit() {
        return Promise.resolve({ data: rows.filter(match), error: null });
      },
      maybeSingle() {
        return Promise.resolve({ data: rows.find(match) || null, error: null });
      },
      insert(row) {
        rows.push(row);
        return Promise.resolve({ error: null });
      },
      upsert(row) {
        const i = rows.findIndex((r) => r.user_id === row.user_id);
        if (i >= 0) rows[i] = { ...rows[i], ...row };
        else rows.push(row);
        return Promise.resolve({ error: null });
      },
      delete() {
        return {
          eq(col, val) {
            for (let i = rows.length - 1; i >= 0; i--) if (rows[i][col] === val) rows.splice(i, 1);
            return Promise.resolve({ error: null });
          },
        };
      },
      then(res) {
        return Promise.resolve({ data: rows.filter(match), error: null }).then(res);
      },
    };
    function match(r) {
      return filters.every(([c, v]) => r[c] === v);
    }
    return q;
  }
  return { from, _tables: tables };
}

// Replaces global fetch so no test can reach the real Vercel API. Each entry is
// matched by substring against the request URL.
//
// Only api.vercel.com is intercepted: the request helper below drives the app
// over real HTTP on localhost, and swallowing that too would make every test
// fail identically for a reason that has nothing to do with the code.
function stubVercel(routes) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if (!String(url).includes("api.vercel.com")) return original(url, opts);
    calls.push({ url: String(url), method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : null });
    for (const [frag, reply] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        const r = typeof reply === "function" ? reply(opts) : reply;
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
      }
    }
    return { ok: false, status: 404, json: async () => ({ error: { message: "not stubbed" } }) };
  };
  return { calls, restore: () => (global.fetch = original) };
}

function makeApp({ supabaseAdmin, user = { id: "user-1" } }) {
  const app = express();
  app.use(express.json({ limit: "5mb" }));
  registerVercelRoutes(app, { supabaseAdmin, getManagedUser: async () => user });
  return app;
}

// A minimal request helper — starts the app on an ephemeral port, makes one
// call, shuts down. Avoids adding supertest as a dependency.
async function call(app, method, path, body) {
  const server = await new Promise((r) => {
    const s = app.listen(0, () => r(s));
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  } finally {
    server.close();
  }
}

const PROJECT = { id: "prj_1", name: "my-app", framework: "vite" };
const OK_TOKEN = { body: { projects: [PROJECT] } };
const NO_ACCOUNT = { status: 404, body: { error: { message: "not found" } } };


// A connection row as the database would hold it: token encrypted, never plain.
function connected(extra = {}) {
  return fakeSupabase({
    vercel_connections: [
      {
        user_id: "user-1",
        access_token: vercelLib.encrypt("vcp_stored_token_1234"),
        token_hint: vercelLib.hint("vcp_stored_token_1234"),
        token_scope: "project",
        project_id: "prj_1",
        project_name: "my-app",
        ...extra,
      },
    ],
  });
}

module.exports = { fakeSupabase, stubVercel, makeApp, call, connected, PROJECT, OK_TOKEN, NO_ACCOUNT };
