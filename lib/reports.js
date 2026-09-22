"use strict";

// Abuse reporting and takedown for published apps.
//
// Published apps are served from our own domain, which makes their content our
// problem in a way a downloaded file never is. Two things have to exist for
// that to be manageable: a way for anyone who finds a bad app to tell us, and a
// way to pull it offline in one action. This module is both.
//
// The reporting endpoint is deliberately unauthenticated - requiring an account
// to report abuse means abuse goes unreported - so every bound it has is
// enforced in the database (see db/migrations/007_app_reports.sql).

const REASONS = ["illegal", "sexual", "violence", "malware", "impersonation", "spam", "other"];
const APP_ID = /^[a-zA-Z0-9_-]{6,24}$/;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Returns { appId, reason, details, reporter } or throws with a message safe to
// show a stranger. Nothing here is trusted: the form is public.
function validateReport(body) {
  if (!body || typeof body !== "object") throw new Error("Invalid report.");
  const appId = String(body.appId || "").trim();
  if (!APP_ID.test(appId)) throw new Error("That app link doesn't look right.");
  const reason = String(body.reason || "").trim();
  if (!REASONS.includes(reason)) throw new Error("Choose a reason for the report.");
  const details = String(body.details || "").slice(0, 2000);
  const reporter = String(body.reporter || "").trim().slice(0, 254);
  // An email is optional; a malformed one is dropped rather than rejected,
  // because the report itself matters more than being able to reply to it.
  const cleanReporter = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(reporter) && !/[\r\n]/.test(reporter) ? reporter : "";
  return { appId, reason, details, reporter: cleanReporter };
}

// The badge injected into published apps. Small, fixed, and outside the app's
// own layout: this is the only route a visitor has to reach us, so it cannot be
// something the generated CSS can accidentally bury.
function reportBadge(appId, siteUrl) {
  const href = `${siteUrl}/report?app=${encodeURIComponent(appId)}`;
  return (
    `<a href="${href}" target="_blank" rel="noopener noreferrer" aria-label="Report this app"` +
    ` style="position:fixed;right:10px;bottom:10px;z-index:2147483647;display:inline-flex;align-items:center;gap:5px;` +
    `padding:5px 9px;border-radius:100px;background:rgba(10,13,17,.72);color:#dbe4ee;border:1px solid rgba(255,255,255,.16);` +
    `font:500 11px/1 system-ui,-apple-system,sans-serif;text-decoration:none;backdrop-filter:blur(6px)">` +
    `⚑ Report</a>`
  );
}

function injectReportBadge(html, { appId, siteUrl }) {
  if (!html || !APP_ID.test(String(appId || ""))) return html;
  const badge = reportBadge(appId, siteUrl);
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, badge + "</body>") : html + badge;
}

// What a visitor sees where a taken-down app used to be. 451 rather than 404:
// the app existed and was removed, and saying so plainly is better than
// pretending it never existed.
function takenDownPage(reason) {
  return (
    `<!doctype html><html lang="en"><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex">` +
    `<title>App unavailable</title>` +
    `<body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#0a0d11;color:#eef3f7;` +
    `font:16px/1.6 system-ui,-apple-system,sans-serif;padding:24px;text-align:center">` +
    `<main><h1 style="font-size:20px;margin:0 0 10px">This app has been taken offline</h1>` +
    `<p style="color:#8d9aa8;margin:0 0 6px;max-width:44ch">` +
    (reason ? escapeHtml(reason) : "It was removed after a review of its content.") +
    `</p><p style="color:#5f6b78;font-size:13px">If you believe this was a mistake, email ` +
    `<a style="color:#8b5cf6" href="mailto:contact@vibesafebuilder.com">contact@vibesafebuilder.com</a>.</p></main></body></html>`
  );
}

function registerReportRoutes(app, { supabaseAdmin: db, sendEmail, siteUrl, requireAdmin }) {
  const express = require("express");
  const router = express.Router();
  const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(() => res.status(503).json({ error: "Reporting is temporarily unavailable." }));

  router.post("/", wrap(async (req, res) => {
    if (!db) return res.status(503).json({ error: "Reporting isn't configured on this server." });
    let report;
    try {
      report = validateReport(req.body);
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    const { error } = await db.rpc("file_app_report", {
      p_app: report.appId,
      p_reason: report.reason,
      p_details: report.details,
      p_reporter: report.reporter,
    });
    if (error) {
      if (/report_rate_limit/.test(error.message)) {
        return res.status(429).json({ error: "This app has already been reported several times recently. Thank you — we're looking at it." });
      }
      throw error;
    }
    // Best effort: a failed notification must not lose the report or tell the
    // reporter something went wrong, because the report itself was saved.
    if (sendEmail) {
      try {
        await sendEmail({
          to: "contact@vibesafebuilder.com",
          subject: `App reported: ${report.appId} (${report.reason})`,
          timeoutMs: 8000,
          html:
            `<p><b>App:</b> <a href="${siteUrl}/p/${escapeHtml(report.appId)}">${escapeHtml(report.appId)}</a></p>` +
            `<p><b>Reason:</b> ${escapeHtml(report.reason)}</p>` +
            `<p><b>Details:</b> ${escapeHtml(report.details) || "(none given)"}</p>` +
            `<p><b>Reporter:</b> ${escapeHtml(report.reporter) || "(anonymous)"}</p>`,
        });
      } catch { /* saved regardless */ }
    }
    res.status(201).json({ ok: true });
  }));

  app.use("/api/report", router);

  // Owner-only: list what has been reported, and pull an app offline.
  app.get("/api/admin/reports", wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!db) return res.status(503).json({ error: "Not configured." });
    const { data, error } = await db
      .from("app_reports")
      .select("id, app_id, reason, details, reporter, handled_at, created_at")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    res.json({ reports: data || [] });
  }));

  app.post("/api/admin/apps/:id/disable", wrap(async (req, res) => {
    if (!requireAdmin(req, res)) return;
    if (!db) return res.status(503).json({ error: "Not configured." });
    if (!APP_ID.test(req.params.id)) return res.status(400).json({ error: "Bad app id." });
    const disable = req.body?.disable !== false;
    const { data, error } = await db
      .from("published_apps")
      .update({
        disabled_at: disable ? new Date().toISOString() : null,
        disabled_reason: disable ? String(req.body?.reason || "").slice(0, 200) || null : null,
      })
      .eq("id", req.params.id)
      .select("id, disabled_at")
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "No published app with that id." });
    // Mark every open report for this app as dealt with, so the queue reflects
    // what has actually been actioned rather than growing forever.
    if (disable) {
      try {
        await db.from("app_reports").update({ handled_at: new Date().toISOString() }).eq("app_id", req.params.id).is("handled_at", null);
      } catch { /* the takedown is what matters */ }
    }
    res.json({ ok: true, disabled: Boolean(data.disabled_at) });
  }));
}

module.exports = { REASONS, validateReport, injectReportBadge, reportBadge, takenDownPage, registerReportRoutes };
