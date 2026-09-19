// Crawler visit logging.
//
// Vercel's own request logs record method, path and status but not the user
// agent, so "when did Google last crawl us?" could only be answered from Search
// Console — which reports with a delay of days. This writes one greppable line
// per crawler visit into the runtime logs instead.
//
// What is deliberately NOT recorded: IP addresses, full user-agent strings,
// query strings, cookies or anything identifying a human visitor. A crawl log
// is useful as "which bot, which page, when" and nothing more, so that is all
// it holds. Human traffic produces no line at all.

// Matched against the user agent, longest/most specific first so Googlebot's
// variants (Googlebot-Image, Google-InspectionTool) don't all collapse to one
// name — knowing that the inspection tool called, rather than the indexer, is
// exactly the distinction that answers "did my Search Console request work?".
const CRAWLERS = [
  ["Google-InspectionTool", /Google-InspectionTool/i],
  ["Googlebot-Image", /Googlebot-Image/i],
  ["Googlebot-News", /Googlebot-News/i],
  ["Googlebot", /Googlebot/i],
  ["Google-Extended", /Google-Extended/i],
  ["GoogleOther", /GoogleOther/i],
  ["Bingbot", /bingbot/i],
  ["Yandex", /YandexBot/i],
  ["DuckDuckBot", /DuckDuckBot/i],
  ["Applebot", /Applebot/i],
  ["Baiduspider", /Baiduspider/i],
  ["GPTBot", /GPTBot/i],
  ["OAI-SearchBot", /OAI-SearchBot/i],
  ["ChatGPT-User", /ChatGPT-User/i],
  ["ClaudeBot", /ClaudeBot/i],
  ["Claude-User", /Claude-User/i],
  ["PerplexityBot", /PerplexityBot/i],
  ["Bytespider", /Bytespider/i],
  ["AhrefsBot", /AhrefsBot/i],
  ["SemrushBot", /SemrushBot/i],
  ["facebookexternalhit", /facebookexternalhit/i],
  ["Twitterbot", /Twitterbot/i],
  ["LinkedInBot", /LinkedInBot/i],
  ["Slackbot", /Slackbot/i],
];

// Assets tell you nothing about indexing and would bury the page hits.
const ASSET = /\.(?:css|js|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|map|json)$/i;

function crawlerName(userAgent) {
  if (typeof userAgent !== "string" || !userAgent) return null;
  for (const [name, re] of CRAWLERS) if (re.test(userAgent)) return name;
  return null;
}

// A visit is worth a line when a known crawler asks for a page (not an asset).
// Returns the line to log, or null for "say nothing".
function crawlLine({ userAgent, method = "GET", path = "/", status = 200, now = new Date() }) {
  const bot = crawlerName(userAgent);
  if (!bot) return null;
  if (ASSET.test(path)) return null;
  // Path only, never the query string: a crawler URL can carry campaign or
  // session parameters picked up from elsewhere.
  const clean = String(path).split("?")[0].slice(0, 200);
  return `crawl ${bot} ${method} ${clean} ${status} ${now.toISOString()}`;
}

// Logs on response finish so the real status code is known — a crawler that got
// a 404 or a redirect is the interesting case, and logging on the way in would
// record every visit as if it succeeded.
function crawlerLogger({ log = console.log } = {}) {
  return function crawlerLogMiddleware(req, res, next) {
    const userAgent = req.get ? req.get("user-agent") : req.headers?.["user-agent"];
    if (crawlerName(userAgent)) {
      res.on("finish", () => {
        const line = crawlLine({ userAgent, method: req.method, path: req.originalUrl || req.url, status: res.statusCode });
        if (line) log(line);
      });
    }
    next();
  };
}

module.exports = { crawlerName, crawlLine, crawlerLogger };
