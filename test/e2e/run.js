#!/usr/bin/env node
/*
 * End-to-end check in a real Chrome (Chrome for Testing or Chromium):
 *  - loads the unpacked extension,
 *  - gives Chrome its real language detection model (a copy kept in the
 *    Chromium repository as test data), because a fresh profile has none,
 *  - opens the pages from pages.js and reads what Chrome's translate component
 *    decided from chrome://translate-internals.
 *
 * Usage:
 *   node test/e2e/run.js              run the cases with the extension
 *   node test/e2e/run.js --baseline   also run them without it and compare
 *   node test/e2e/run.js --headed     show the browser window
 *
 * Needs Playwright (npm i -D playwright) and a Chromium build that still
 * accepts --load-extension (Chrome for Testing does, branded Chrome does not).
 * Set CHROME_PATH to use a specific binary.
 */
'use strict';

const http = require('http');
const { argv, ensureModel, launchChrome, extensionWorker } = require('./lib.js');
const { cases, warmup } = require('./pages.js');

const BASELINE = argv.has('--baseline');

function startServer() {
  const byPath = new Map(cases.map((c) => [`/${c.name}.html`, c]));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/warmup.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(warmup);
      return;
    }
    const c = byPath.get(url.pathname);
    if (!c) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, c.headers || {}));
    res.end(c.html);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Starts Chrome directly instead of through Playwright's launcher, because
 * Playwright's default flags disable Translate, model downloads and component
 * updates, all of which matter here.
 */
async function readDetectionLog(internals) {
  return internals.evaluate(() => [...document.querySelectorAll('#tabpanel-detection-logs tbody tr')].map((tr) => {
    const cell = (c) => {
      const el = tr.querySelector('.detection-logs-' + c);
      return el ? el.textContent.trim() : '';
    };
    const code = (s) => (s.match(/^[a-zA-Z-]+/) || [''])[0];
    return {
      url: cell('url'),
      contentLanguage: cell('content-language'),
      htmlLang: code(cell('html-root-language')),
      model: code(cell('cld-language')),
      modelScore: Number(cell('model-reliability')) || 0,
      adopted: code(cell('adopted-language')),
    };
  }));
}

async function warmUp(page, internals, base) {
  // The renderer gets the model a little after start-up. Reload a small page
  // until Chrome reports a model prediction for it.
  for (let i = 0; i < 12; i++) {
    await page.goto(`${base}/warmup.html?${i}`);
    await page.waitForTimeout(700);
    const rows = await readDetectionLog(internals);
    const last = rows.filter((r) => r.url.includes('/warmup.html')).pop();
    if (last && last.model) return true;
    if (i === 1) await page.waitForTimeout(2000);
  }
  return false;
}

async function runAll({ withExtension, modelPath, server }) {
  const { context, close } = await launchChrome({ withExtension, modelPath });
  try {
    const internals = await context.newPage();
    await internals.goto('chrome://translate-internals/');
    const page = await context.newPage();
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const modelActive = modelPath ? await warmUp(page, internals, base) : false;

    let worker = null;
    if (withExtension) worker = await extensionWorker(context);

    const results = [];
    for (const c of cases) {
      const host = c.host || '127.0.0.1';
      const url = `http://${host}:${port}/${c.name}.html`;
      if (worker) {
        // Every case starts from the defaults plus its own overrides, and the
        // content script registration is updated before the page loads.
        await worker.evaluate(async (overrides) => {
          const settings = Object.assign({ enabled: true, steering: true, debug: false, disabledHosts: [] }, overrides);
          await chrome.storage.local.set({ settings });
          await self.nuTranslateSync();
        }, c.settings || {});
      }
      await page.goto(url);
      await page.waitForTimeout(900);
      const pageState = await page.evaluate(() => ({
        htmlLang: document.documentElement.getAttribute('lang'),
        hintsLeft: document.querySelectorAll('nutranslate-hint').length,
      }));
      let report = null;
      if (worker) {
        report = await worker.evaluate(async (pageUrl) => {
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            try {
              const r = await chrome.tabs.sendMessage(tab.id, { type: 'nt:getReport' }, { frameId: 0 });
              if (r && r.url === pageUrl) return r;
            } catch (e) {
              // no content script in that tab
            }
          }
          return null;
        }, url);
      }
      results.push({ c, url, pageState, report });
    }

    const log = await readDetectionLog(internals);
    for (const r of results) r.chrome = log.filter((row) => row.url === r.url).pop() || null;
    return { results, modelActive };
  } finally {
    await close();
  }
}

function check(result, modelActive) {
  const { c, pageState, report, chrome } = result;
  const e = c.expect;
  const problems = [];
  if (e.noScript) {
    if (report) problems.push(`the content script ran (status ${report.status}) on a disabled site`);
  } else if (!report) {
    problems.push('no report from the content script');
  }
  if (report && e.status && report.status !== e.status) problems.push(`status ${report.status}, expected ${e.status}`);
  if (report && e.steered !== undefined) {
    const steered = Boolean(report.steering && report.steering.applied);
    if (steered !== e.steered) problems.push(`steered=${steered}, expected ${e.steered}`);
  }
  if (report && e.guard && !report.guardReapplied) problems.push('the lang guard never fired');
  if (e.htmlLang && pageState.htmlLang !== e.htmlLang) problems.push(`html lang ${pageState.htmlLang}, expected ${e.htmlLang}`);
  if (pageState.hintsLeft) problems.push(`${pageState.hintsLeft} hint elements left in the page`);
  if (report && report.deferredDetections) problems.push(`${report.deferredDetections} detectLanguage calls were not synchronous`);
  if (!chrome) problems.push('Chrome logged no language detection for this page');
  else if (e.adopted && modelActive && chrome.adopted !== e.adopted) problems.push(`Chrome adopted ${chrome.adopted || 'und'}, expected ${e.adopted}`);
  else if (report && report.applied && chrome.htmlLang !== report.applied) problems.push(`Chrome read lang=${chrome.htmlLang}, expected ${report.applied} (timing)`);
  return problems;
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

async function main() {
  const modelPath = await ensureModel();
  const server = await startServer();
  let failed = 0;
  try {
    const baseline = BASELINE ? await runAll({ withExtension: false, modelPath, server }) : null;
    const run = await runAll({ withExtension: true, modelPath, server });
    console.log(`Language model: ${run.modelActive ? 'active' : 'NOT active, adopted-language checks skipped'}\n`);
    const header = [pad('case', 28), BASELINE ? pad('without', 9) : '', pad('with', 6), pad('status', 10), pad('steer', 6), pad('detect ms', 10), pad('steer ms', 9), 'result'].join('');
    console.log(header);
    console.log('-'.repeat(header.length + 10));
    run.results.forEach((r, i) => {
      const problems = check(r, run.modelActive);
      if (problems.length) failed++;
      const before = baseline ? (baseline.results[i].chrome ? baseline.results[i].chrome.adopted || 'und' : '?') : '';
      const after = r.chrome ? r.chrome.adopted || 'und' : '?';
      const rep = r.report || {};
      const steer = rep.steering ? (rep.steering.applied ? 'yes' : 'no') : '-';
      console.log([
        pad(r.c.name, 28),
        BASELINE ? pad(before, 9) : '',
        pad(after, 6),
        pad(rep.status || '?', 10),
        pad(steer, 6),
        pad(rep.timings && rep.timings.detectMs !== undefined ? rep.timings.detectMs : '-', 10),
        pad(rep.timings && rep.timings.steerMs !== undefined ? rep.timings.steerMs : '-', 9),
        problems.length ? 'FAIL: ' + problems.join('; ') : 'ok',
      ].join(''));
    });
    if (argv.has('--verbose')) {
      for (const r of run.results) console.log('\n' + r.c.name, JSON.stringify({ report: r.report, chrome: r.chrome }, null, 2));
    }
  } finally {
    server.close();
  }
  console.log(failed ? `\n${failed} case(s) failed` : '\nall cases passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
