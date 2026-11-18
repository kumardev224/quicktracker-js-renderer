/*
 * Renders every website QuickTracker has marked "needs JavaScript"
 * with a real headless browser, then pushes the fully-rendered HTML
 * back to QuickTracker so it can diff it exactly like a normal check.
 *
 * This script expects two environment variables, set as GitHub Actions
 * secrets (never hard-coded here):
 *
 *   QT_BASE_URL     — e.g. "https://quicksarkari.in" (no trailing slash)
 *   QT_RENDER_SECRET — the same value saved as config/database.php's
 *                       "render_secret" on the QuickTracker server
 */

const { chromium } = require('playwright');

const BASE_URL = (process.env.QT_BASE_URL || '').replace(/\/+$/, '');
const SECRET = process.env.QT_RENDER_SECRET || '';

// How long a single page is allowed to load before giving up on it —
// generous, since some government sites are genuinely slow, but still
// bounded so one stuck site can't stall the whole run.
const NAVIGATION_TIMEOUT_MS = 45000;

function fail(message) {
  console.error('FATAL: ' + message);
  process.exit(1);
}

async function fetchSiteList() {
  const url = `${BASE_URL}/api/external-sites.php?secret=${encodeURIComponent(SECRET)}`;
  const response = await fetch(url);
  const body = await response.json().catch(() => null);

  if (!response.ok || !body || body.success !== true) {
    const reason = body && body.error ? body.error : `HTTP ${response.status}`;
    throw new Error(`Could not fetch the site list from QuickTracker: ${reason}`);
  }

  return body.sites || [];
}

async function pushRenderedHtml(websiteId, html, responseTimeMs) {
  const url = `${BASE_URL}/api/ingest-render.php`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      secret: SECRET,
      website_id: websiteId,
      html,
      response_time_ms: responseTimeMs,
    }),
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || !body) {
    throw new Error(`QuickTracker rejected the upload (HTTP ${response.status}).`);
  }

  return body;
}

async function renderOneSite(browser, site) {
  const startedAt = Date.now();
  const context = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 QuickTrackerRenderer',
  });
  const page = await context.newPage();

  try {
    // "networkidle" gives sites built with React/Angular/Vue time to
    // finish their own data fetches and actually paint real content,
    // not just the initial empty shell. If a site never truly goes
    // idle (some keep a polling/analytics connection open forever),
    // this falls back to a plain load instead of failing outright.
    try {
      await page.goto(site.url, {
        waitUntil: 'networkidle',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
    } catch (networkIdleError) {
      await page.goto(site.url, {
        waitUntil: 'load',
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      // Give any late client-side rendering a little more time even
      // though the network never fully settled.
      await page.waitForTimeout(3000);
    }

    const html = await page.content();
    const responseTimeMs = Date.now() - startedAt;

    const result = await pushRenderedHtml(site.id, html, responseTimeMs);

    console.log(
      `[ok] #${site.id} ${site.name}: ${result.status || 'unknown status'}` +
        (result.changed ? ' (CHANGED)' : '')
    );

    return { id: site.id, name: site.name, ok: true };
  } catch (error) {
    console.error(`[fail] #${site.id} ${site.name}: ${error.message}`);
    return { id: site.id, name: site.name, ok: false, error: error.message };
  } finally {
    await context.close();
  }
}

async function main() {
  if (!BASE_URL) fail('QT_BASE_URL is not set.');
  if (!SECRET) fail('QT_RENDER_SECRET is not set.');

  const sites = await fetchSiteList();

  if (sites.length === 0) {
    console.log('No sites are currently marked for external rendering — nothing to do.');
    return;
  }

  console.log(`Rendering ${sites.length} site(s)...`);

  const browser = await chromium.launch();
  const results = [];

  try {
    // One at a time, not in parallel — this is a small, occasional
    // batch (a handful of JS-heavy sites, not the full list), and
    // running sequentially keeps memory use low and predictable on
    // GitHub's free shared runners.
    for (const site of sites) {
      results.push(await renderOneSite(browser, site));
    }
  } finally {
    await browser.close();
  }

  const succeeded = results.filter((r) => r.ok).length;
  const failed = results.length - succeeded;

  console.log(`\nDone: ${succeeded} succeeded, ${failed} failed.`);

  if (failed > 0) {
    // A non-zero exit code makes a failing site visible as a red X in
    // the GitHub Actions tab, rather than silently buried in the log.
    process.exitCode = 1;
  }
}

main().catch((error) => fail(error.message));
