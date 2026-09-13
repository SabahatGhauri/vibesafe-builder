/* One public address for the site.

   apps.<domain> exists only to serve published apps from a separate origin, and the
   project's .vercel.app alias is an implementation detail. Both used to answer every
   path with a full copy of the marketing site, so Google saw duplicate homepages on
   other hostnames. A canonical tag is only a hint; a redirect is not. */

// Paths a published app legitimately needs on the isolated apps host.
const APPS_HOST_PATHS = ["/p/", "/api/backend", "/favicon.ico", "/__lc-blank"];

function canonicalHostRedirect({ canonicalHost, appsHost, isProduction }) {
  return function (req, res, next) {
    const host = (req.hostname || "").toLowerCase();
    if (!host || host === canonicalHost) return next();
    // Redirecting a POST would drop or replay its body; only page loads move.
    if (req.method !== "GET" && req.method !== "HEAD") return next();

    let redirect = false;
    if (appsHost && host === appsHost) {
      redirect = !APPS_HOST_PATHS.some((p) => req.path === p || req.path.startsWith(p));
    } else if (host.endsWith(".vercel.app")) {
      // Production only: preview deployments must stay browsable at their own URL.
      redirect = isProduction && !req.path.startsWith("/api/");
    }

    if (!redirect) return next();
    res.redirect(308, `https://${canonicalHost}${req.originalUrl}`);
  };
}

module.exports = { canonicalHostRedirect, APPS_HOST_PATHS };
