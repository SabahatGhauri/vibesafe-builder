const { test } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { crawlerName, crawlLine, crawlerLogger } = require("../lib/crawlerLog");

const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";

test("names the specific crawler, not just the family", () => {
  assert.equal(crawlerName(GOOGLEBOT), "Googlebot");
  assert.equal(crawlerName("Mozilla/5.0 (compatible; Google-InspectionTool/1.0)"), "Google-InspectionTool");
  assert.equal(crawlerName("Googlebot-Image/1.0"), "Googlebot-Image");
  assert.equal(crawlerName("Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"), "Bingbot");
  assert.equal(crawlerName("Mozilla/5.0 (compatible; ClaudeBot/1.0)"), "ClaudeBot");
});

test("ordinary visitors produce nothing at all", () => {
  for (const ua of [CHROME, "", null, undefined, 42, "curl/8.4.0"]) assert.equal(crawlerName(ua), null);
  assert.equal(crawlLine({ userAgent: CHROME, path: "/" }), null);
});

test("a crawl line carries the bot, page, status and time — and nothing else", () => {
  const line = crawlLine({ userAgent: GOOGLEBOT, method: "GET", path: "/pricing.html", status: 200, now: new Date("2026-09-19T10:00:00Z") });
  assert.equal(line, "crawl Googlebot GET /pricing.html 200 2026-09-19T10:00:00.000Z");
  assert.ok(!line.includes("Mozilla"), "no raw user agent");
});

test("query strings are dropped and long paths truncated", () => {
  const line = crawlLine({ userAgent: GOOGLEBOT, path: "/templates.html?utm_source=mail&session=abc123" });
  assert.ok(line.includes("/templates.html"));
  assert.ok(!line.includes("session"), "query string never reaches the log");
  assert.ok(crawlLine({ userAgent: GOOGLEBOT, path: "/" + "a".repeat(500) }).length < 260);
});

test("assets are ignored so page crawls stay readable", () => {
  for (const p of ["/style.css", "/app.js", "/og-image.png", "/img/templates/todo-list.webp", "/favicon.ico"]) {
    assert.equal(crawlLine({ userAgent: GOOGLEBOT, path: p }), null, p);
  }
});

test("failed crawls are logged with their real status, not as successes", async () => {
  const lines = [];
  const app = express();
  app.use(crawlerLogger({ log: l => lines.push(l) }));
  app.get("/ok", (req, res) => res.send("hi"));
  app.use((req, res) => res.status(404).send("nope"));

  const server = app.listen(0, "127.0.0.1");
  await new Promise(r => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fetch(`${base}/ok`, { headers: { "user-agent": GOOGLEBOT } });
    await fetch(`${base}/gone`, { headers: { "user-agent": GOOGLEBOT } });
    await fetch(`${base}/ok`, { headers: { "user-agent": CHROME } });
  } finally {
    await new Promise(r => server.close(r));
  }

  assert.equal(lines.length, 2, "one line per crawler visit, none for the human");
  assert.match(lines[0], /^crawl Googlebot GET \/ok 200 /);
  assert.match(lines[1], /^crawl Googlebot GET \/gone 404 /);
});
