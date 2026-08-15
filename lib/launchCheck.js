// Launch Check — runs the current app in a real (headless) browser and reports what
// actually breaks: uncaught JS errors, failed resource loads, and mobile overflow.
// This is the risky infra piece of the feature: headless Chromium has to run inside a
// Vercel serverless function, which only works via @sparticuz/chromium's Lambda-built
// binary. That binary is Linux-only, so local dev (Windows/macOS) falls back to
// whatever Chrome/Edge is already installed on the machine.
// @sparticuz/chromium and puppeteer-core both ship as ESM-only in the versions
// pinned here, so neither can be require()'d from this CommonJS file — both are
// loaded via dynamic import() instead, cached after the first call since
// import() is async but launches happen repeatedly.
let chromiumPromise = null;
function loadChromium() {
  if (!chromiumPromise) chromiumPromise = import("@sparticuz/chromium").then((m) => m.default || m);
  return chromiumPromise;
}
let puppeteerPromise = null;
function loadPuppeteer() {
  if (!puppeteerPromise) puppeteerPromise = import("puppeteer-core").then((m) => m.default || m);
  return puppeteerPromise;
}
const fs = require("fs");

const IS_SERVERLESS = !!process.env.VERCEL || !!process.env.AWS_LAMBDA_FUNCTION_NAME;

// page.setContent() alone lands the document on an opaque about:blank origin,
// where Chromium blocks localStorage/sessionStorage outright (SecurityError) —
// a false positive, since the real published app runs on a proper https origin.
// Navigating to this real internal page first (see the /__lc-blank route in
// app.js) gives the frame a genuine origin before we write the app's HTML into
// it, so storage APIs behave the way they would for an actual user.
const BASE_URL = IS_SERVERLESS ? "https://vibesafebuilder.com" : `http://localhost:${process.env.PORT || 3111}`;

function findLocalChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

async function getBrowser() {
  const puppeteer = await loadPuppeteer();
  if (IS_SERVERLESS) {
    const chromium = await loadChromium();
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
    });
  }
  const localPath = findLocalChrome();
  if (!localPath) {
    throw new Error(
      "No local Chrome/Edge found for dev-mode Launch Check. Set CHROME_PATH, or test this feature on a Vercel deploy where @sparticuz/chromium runs."
    );
  }
  return puppeteer.launch({ executablePath: localPath, headless: true });
}

async function runLaunchCheck(html) {
  const t0 = Date.now();
  const browser = await getBrowser();
  const tLaunched = Date.now();
  const findings = [];
  try {
    const page = await browser.newPage();
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        findings.push({ severity: "warn", label: "Console error", detail: truncate(msg.text()) });
      }
    });
    page.on("pageerror", (err) => {
      findings.push({ severity: "bad", label: "Uncaught exception", detail: truncate(err.message || String(err)) });
    });
    page.on("requestfailed", (req) => {
      // Ignore the app's own inline content and aborted-by-navigation noise.
      if (req.url().startsWith("data:") || req.url() === "about:blank") return;
      findings.push({
        severity: "warn",
        label: "Failed resource load",
        detail: `${req.url()} — ${req.failure()?.errorText || "unknown error"}`,
      });
    });

    // Each pass re-navigates to the real-origin blank page first, then writes the
    // app's HTML in — this both grants a real origin (fixes localStorage) and resets
    // the JS realm (so the mobile pass re-declaring the same top-level const/let
    // bindings doesn't collide with what the desktop pass already declared).
    const load = async (viewport) => {
      await page.setViewport(viewport);
      await page.goto(`${BASE_URL}/__lc-blank`, { waitUntil: "load", timeout: 45000 });
      await page.setContent(html, { waitUntil: "load", timeout: 45000 });
    };

    await load({ width: 1280, height: 800 });
    const screenshotDesktop = await page.screenshot({ encoding: "base64", type: "jpeg", quality: 70 });

    await load({ width: 375, height: 812 });
    const bodyWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    if (bodyWidth > 375 + 4) {
      findings.push({
        severity: "warn",
        label: "Mobile overflow",
        detail: `Page is ${bodyWidth}px wide at a 375px viewport — likely a horizontal scrollbar on phones.`,
      });
    }
    const screenshotMobile = await page.screenshot({ encoding: "base64", type: "jpeg", quality: 70 });

    const critical = findings.filter((f) => f.severity === "bad").length;
    const warn = findings.filter((f) => f.severity === "warn").length;
    const score = Math.max(0, 100 - critical * 35 - warn * 10);

    return {
      score,
      findings,
      screenshotDesktop: `data:image/jpeg;base64,${screenshotDesktop}`,
      screenshotMobile: `data:image/jpeg;base64,${screenshotMobile}`,
      tookMs: Date.now() - t0,
    };
  } catch (err) {
    err.message = `[browser launch took ${tLaunched - t0}ms] ${err.message}`;
    throw err;
  } finally {
    await browser.close();
  }
}

function truncate(s, n = 300) {
  return s && s.length > n ? s.slice(0, n) + "…" : s;
}

module.exports = { runLaunchCheck };
