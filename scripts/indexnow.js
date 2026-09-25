#!/usr/bin/env node
"use strict";

// Tell the IndexNow engines (Bing, Yandex, Seznam, Naver) that our URLs exist.
//
// Why bother, when the sitemap already lists them: Bing reported the homepage as
// "Discovered but not crawled" - it had the URL from the sitemap and simply chose
// not to spend crawl budget on an unknown six-week-old domain. IndexNow is the
// push equivalent of that pull, and it is the one submission channel that needs
// no account and no dashboard, so it can be re-run from here whenever pages
// change. It is not a ranking signal and it will not manufacture authority; it
// only removes "we didn't know" as a reason for a page not being fetched.
//
// Ownership is proved by a key file served from the site itself, so anyone who
// can deploy the site can submit for it, and nobody else can.
//
//   node scripts/indexnow.js              # every URL in the sitemap
//   node scripts/indexnow.js /blog/x.html # just these paths
//
// Re-run it after publishing a new page. Submitting a URL that has not changed
// is pointless rather than harmful, but the engines do ask you not to spam it.

const KEY = process.env.INDEXNOW_KEY || "dfb1d6a9010be26920d5b2b4f208ead6";
const HOST = "vibesafebuilder.com";
const ORIGIN = `https://${HOST}`;
const ENDPOINT = "https://api.indexnow.org/indexnow";

async function sitemapUrls() {
  const r = await fetch(`${ORIGIN}/sitemap.xml`);
  if (!r.ok) throw new Error(`sitemap returned ${r.status}`);
  const xml = await r.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
}

async function main() {
  const args = process.argv.slice(2);
  const urlList = args.length
    ? args.map((a) => (a.startsWith("http") ? a : ORIGIN + (a.startsWith("/") ? a : "/" + a)))
    : await sitemapUrls();

  // A key file that is not being served means the submission would be rejected
  // as unverified. Checking first turns a silent no-op into a clear failure.
  const keyUrl = `${ORIGIN}/${KEY}.txt`;
  const keyRes = await fetch(keyUrl);
  const keyBody = keyRes.ok ? (await keyRes.text()).trim() : "";
  if (keyBody !== KEY) {
    console.error(`Key file not verifiable at ${keyUrl} (status ${keyRes.status}).`);
    console.error("Deploy the key file before submitting.");
    process.exit(1);
  }
  console.log(`Key verified at ${keyUrl}`);

  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ host: HOST, key: KEY, keyLocation: keyUrl, urlList }),
  });

  // 200 and 202 both mean accepted; 202 specifically means "received, key
  // validation pending". Anything else is worth reading rather than ignoring.
  const ok = res.status === 200 || res.status === 202;
  console.log(`${ok ? "Submitted" : "Rejected"}: ${urlList.length} URLs -> ${res.status} ${res.statusText}`);
  if (!ok) console.error((await res.text()).slice(0, 500));
  urlList.forEach((u) => console.log("  " + u));
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("IndexNow submission failed:", err.message);
  process.exit(1);
});
