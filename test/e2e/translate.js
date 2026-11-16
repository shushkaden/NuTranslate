#!/usr/bin/env node
/*
 * End-to-end checks for NuTranslate's own translator, in a real Chrome with
 * the unpacked extension. Google Cloud Translation is replaced by a local mock
 * that "translates" by upper-casing the text and keeps the <a i=N> tags, and
 * for one sentence also moves the link, like a real engine sometimes does.
 *
 * Usage: node test/e2e/translate.js [--headed]
 */
'use strict';

const http = require('http');
const assert = require('assert/strict');
const { launchChrome, extensionWorker } = require('./lib.js');
const { cases } = require('./pages.js');

// ----------------------------------------------------------------- pages

const FORM_PAGE = `<!doctype html>
<html lang="lt">
<head><meta charset="utf-8"><title>Prašymo forma</title></head>
<body>
<header><nav><a href="#">Pradžia</a> <a href="#">Paslaugos</a> <a href="#">Kontaktai</a></nav></header>
<main>
  <h1>Prašymo forma</h1>
  <p id="p1">Paspauskite <a id="link" href="#">čia</a>, kad pateiktumėte prašymą <b>šiandien</b>.</p>
  <p id="p2">Paleiskite <code id="code">npm install</code> komandą terminale ir palaukite.</p>
  <p id="reorder">Norėdami tęsti REORDER <a id="link2" href="#">spauskite nuorodą</a> apačioje.</p>
  <p class="notranslate" id="nt">Šio teksto nekeisti niekada</p>
  <p translate="no" id="nt2">Ir šio teksto taip pat nekeisti</p>
  <img id="img" alt="Lietuvos vėliava" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
  <form id="form" action="/submitted" method="post">
    <label id="label" for="name">Vardas ir pavardė</label>
    <input id="name" name="name" placeholder="Įveskite savo vardą" value="Jonas">
    <select id="city" name="city"><option>Vilnius</option><option>Kaunas</option><option value="kl">Klaipėda</option></select>
    <textarea id="msg" name="msg" placeholder="Jūsų žinutė">Laba diena, noriu užsisakyti.</textarea>
    <input type="submit" id="submitNamed" name="action" value="Siųsti">
    <input type="button" id="btnUnnamed" value="Atšaukti">
    <button id="btn" type="submit">Pateikti prašymą</button>
  </form>
  <p id="cookie">We use cookies to improve your experience on our website and to show you relevant content.</p>
</main>
</body>
</html>`;

const SECOND_PAGE = `<!doctype html>
<html lang="lt"><head><meta charset="utf-8"><title>Kitas puslapis</title></head>
<body><main><p id="p">Tai yra kitas svetainės puslapis, kuriame taip pat rašoma lietuviškai.</p></main></body></html>`;

const ENGLISH_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>English</title></head>
<body><main><p id="p">This is an English page about the weather, the city and the people who live there.</p></main></body></html>`;

const BIG_PAGE = cases.find((c) => c.name === 'big-lt').html;

// ------------------------------------------------------------- mock engine

const requests = [];

/** Upper-cases text outside tags and entities; moves link 0 to the end when asked. */
function fakeTranslate(html) {
  let out = html.replace(/(<[^>]*>|&[#a-z0-9]+;)|([^<&]+)/gi, (whole, keep, text) => (keep ? keep : text.toUpperCase()));
  if (out.includes('REORDER')) {
    const m = out.match(/<a i=(\d+)>[^<]*<\/a>/);
    if (m) out = out.replace(m[0], '').replace(/\s*$/, ' ') + m[0];
  }
  return out;
}

function startServer() {
  const pages = { '/form.html': FORM_PAGE, '/second.html': SECOND_PAGE, '/english.html': ENGLISH_PAGE, '/big.html': BIG_PAGE };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/mock-translate' && req.method === 'POST') {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        const json = JSON.parse(body);
        requests.push({ source: json.source || 'auto', target: json.target, q: json.q, key: req.headers['x-goog-api-key'] });
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ data: { translations: json.q.map((q) => ({ translatedText: fakeTranslate(q) })) } }));
        }, 20);
      });
      return;
    }
    if (url.pathname === '/submitted') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><p>ok</p>');
      return;
    }
    const html = pages[url.pathname];
    res.writeHead(html ? 200 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    if (html && url.searchParams.has('slow')) {
      // Like a real network: the end of the page arrives a bit later.
      const cut = html.indexOf('</main>');
      res.write(html.slice(0, cut));
      setTimeout(() => res.end(html.slice(cut)), 150);
      return;
    }
    res.end(html || '');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ----------------------------------------------------------------- helpers

async function waitFor(page, fn, arg, timeout = 8000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 50 });
}

async function setSettings(worker, port, overrides) {
  await worker.evaluate(async (s) => {
    await chrome.storage.local.set({ settings: s });
    await self.nuTranslateSync();
  }, Object.assign({
    targetLang: 'ru',
    engine: 'cloud',
    cloudApiKey: 'test-key',
    cloudEndpoint: `http://127.0.0.1:${port}/mock-translate`,
    autoLanguages: [],
  }, overrides || {}));
}

let pageCounter = 0;

/** Every check gets its own tab, so that the tab's translation mode starts clean. */
async function withPage(context, fn) {
  const page = await context.newPage();
  try {
    return await fn(page, ++pageCounter);
  } finally {
    await page.close();
  }
}

async function tabIdOf(worker, url) {
  return worker.evaluate(async (u) => {
    const tabs = await chrome.tabs.query({});
    const tab = tabs.find((t) => t.url === u);
    return tab ? tab.id : null;
  }, url);
}

async function toggle(worker, page) {
  const id = await tabIdOf(worker, page.url());
  return worker.evaluate((tabId) => self.nuTranslateToggleTab(tabId), id);
}

const results = [];
const ONLY = process.env.ONLY || '';
async function check(name, fn) {
  if (ONLY && !new RegExp(ONLY).test(name)) return;
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - started, error: e.message.split('\n').slice(0, 6).join('\n') });
  }
}

// ------------------------------------------------------------------- tests

async function main() {
  const server = await startServer();
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const { context, close } = await launchChrome({ withExtension: true });
  let failed = 0;
  try {
    const worker = await extensionWorker(context);
    await setSettings(worker, port);

    await check('translates text, keeps structure and form data, restores exactly', () => withPage(context, async (page, n) => {
      await page.goto(`${base}/form.html?c=${n}`);
      await page.waitForTimeout(400);
      const before = await page.evaluate(() => {
        window.__link = document.getElementById('link');
        window.__p1First = document.getElementById('p1').firstChild;
        return document.body.innerHTML;
      });
      requests.length = 0;
      const res = await toggle(worker, page);
      assert.equal(res.ok, true, 'toggle reached the page');
      await waitFor(page, () => document.getElementById('p1').textContent.includes('PASPAUSKITE'));
      await waitFor(page, () => document.getElementById('img').alt === 'LIETUVOS VĖLIAVA' && document.getElementById('cookie').textContent.startsWith('WE USE'));
      const s = await page.evaluate(() => {
        const $ = (id) => document.getElementById(id);
        return {
          sameLink: $('link') === window.__link,
          sameTextNode: $('p1').firstChild === window.__p1First,
          p1: $('p1').innerHTML,
          code: $('code').textContent,
          p2: $('p2').textContent,
          reorder: $('reorder').innerHTML,
          nt: $('nt').textContent,
          nt2: $('nt2').textContent,
          nameValue: $('name').value,
          nameAttr: $('name').getAttribute('value'),
          placeholder: $('name').placeholder,
          options: [...$('city').options].map((o) => [o.text, o.value, o.getAttribute('value')]),
          selectValue: $('city').value,
          msg: $('msg').value,
          msgPlaceholder: $('msg').placeholder,
          submitNamed: $('submitNamed').value,
          btnUnnamed: $('btnUnnamed').value,
          btn: $('btn').textContent,
          fonts: document.querySelectorAll('font').length,
        };
      });
      assert.equal(s.sameLink, true, 'the link element is the same node');
      assert.equal(s.sameTextNode, true, 'text nodes are changed in place, not replaced');
      assert.equal(s.p1, 'PASPAUSKITE <a id="link" href="#">ČIA</a>, KAD PATEIKTUMĖTE PRAŠYMĄ <b>ŠIANDIEN</b>.');
      assert.equal(s.code, 'npm install', 'code is not translated');
      assert.match(s.p2, /^PALEISKITE npm install KOMANDĄ/);
      // The engine moved the link to the end; the link stays where it is and
      // the words around it follow the translated order.
      assert.equal(s.reorder, 'NORĖDAMI TĘSTI REORDER APAČIOJE. <a id="link2" href="#">SPAUSKITE NUORODĄ</a> ');
      assert.equal(s.nt, 'Šio teksto nekeisti niekada');
      assert.equal(s.nt2, 'Ir šio teksto taip pat nekeisti');
      assert.equal(s.nameValue, 'Jonas');
      assert.equal(s.nameAttr, 'Jonas');
      assert.equal(s.placeholder, 'ĮVESKITE SAVO VARDĄ');
      assert.deepEqual(s.options, [['VILNIUS', 'Vilnius', 'Vilnius'], ['KAUNAS', 'Kaunas', 'Kaunas'], ['KLAIPĖDA', 'kl', 'kl']]);
      assert.equal(s.selectValue, 'Vilnius', 'the form still submits the original option');
      assert.equal(s.msg, 'Laba diena, noriu užsisakyti.', 'textarea content is user data');
      assert.equal(s.msgPlaceholder, 'JŪSŲ ŽINUTĖ');
      assert.equal(s.submitNamed, 'Siųsti', 'a named submit button value is form data');
      assert.equal(s.btnUnnamed, 'ATŠAUKTI');
      assert.equal(s.btn, 'PATEIKTI PRAŠYMĄ');
      assert.equal(s.fonts, 0, 'no <font> wrappers');
      const english = requests.flatMap((r) => r.q.map((q) => [r.source, q])).filter(([, q]) => q.startsWith('We use cookies'));
      assert.deepEqual(english.map(([src]) => src), ['en'], 'the English paragraph is sent as English');
      assert.ok(requests.some((r) => r.source === 'lt'), 'Lithuanian text is sent as Lithuanian');
      assert.ok(requests.every((r) => r.key === 'test-key' && r.target === 'ru'));

      const off = await toggle(worker, page);
      assert.equal(off.status.active, false);
      const after = await page.evaluate(() => document.body.innerHTML);
      assert.equal(after, before, 'the page is restored byte for byte');
    }));

    await check('translates content added later and text changed by the page', () => withPage(context, async (page, n) => {
      await page.goto(`${base}/form.html?c=${n}`);
      await page.waitForTimeout(300);
      await toggle(worker, page);
      await waitFor(page, () => document.getElementById('p1').textContent.includes('PASPAUSKITE'));
      await page.evaluate(() => {
        const p = document.createElement('p');
        p.id = 'late';
        p.textContent = 'Šis tekstas atsirado vėliau, po vertimo.';
        document.querySelector('main').appendChild(p);
        // What React does on re-render: set the value of the existing text node.
        document.getElementById('p1').firstChild.nodeValue = 'Spauskite ';
      });
      await waitFor(page, () => document.getElementById('late').textContent.startsWith('ŠIS TEKSTAS'));
      await waitFor(page, () => document.getElementById('p1').firstChild.nodeValue === 'SPAUSKITE ');
      await toggle(worker, page);
      const s = await page.evaluate(() => ({ late: document.getElementById('late').textContent, first: document.getElementById('p1').firstChild.nodeValue }));
      assert.equal(s.late, 'Šis tekstas atsirado vėliau, po vertimo.');
      assert.equal(s.first, 'Spauskite ', 'restores the latest text the page set');
    }));

    await check('shows the original right before a form is sent', () => withPage(context, async (page, n) => {
      await page.goto(`${base}/form.html?c=${n}`);
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        document.getElementById('form').addEventListener('submit', (e) => {
          e.preventDefault();
          const $ = (id) => document.getElementById(id);
          window.__submitted = { label: $('label').textContent, option: $('city').options[0].text, value: $('city').value, p1: $('p1').textContent };
        });
      });
      await toggle(worker, page);
      await waitFor(page, () => document.getElementById('label').textContent === 'VARDAS IR PAVARDĖ');
      await page.click('#btn');
      const submitted = await page.evaluate(() => window.__submitted);
      assert.deepEqual(submitted, {
        label: 'Vardas ir pavardė',
        option: 'Vilnius',
        value: 'Vilnius',
        p1: 'Paspauskite čia, kad pateiktumėte prašymą šiandien.',
      });
    }));

    await check('keeps translating the next pages of the tab until switched off', () => withPage(context, async (page, n) => {
      await page.goto(`${base}/second.html?c=${n}`);
      await page.waitForTimeout(300);
      await toggle(worker, page);
      await waitFor(page, () => document.getElementById('p').textContent.startsWith('TAI YRA'));
      await page.goto(`${base}/second.html?c=${n}&next&slow`);
      await waitFor(page, () => document.getElementById('p').textContent.startsWith('TAI YRA'));
      const meta = await page.evaluate(() => Boolean(document.querySelector('meta[name="google"][content="notranslate"]')));
      assert.equal(meta, true, "Chrome's own translator is kept away from a page NuTranslate translates");
      await toggle(worker, page);
      await page.goto(`${base}/second.html?c=${n}&again`);
      await page.waitForTimeout(800);
      const text = await page.evaluate(() => document.getElementById('p').textContent);
      assert.ok(text.startsWith('Tai yra'), 'not translated after switching off');
    }));

    await check('translates languages from the "always translate" list on its own', () => withPage(context, async (page, n) => {
      await setSettings(worker, port, { autoLanguages: ['lt'] });
      try {
        await page.goto(`${base}/second.html?c=${n}`);
        await waitFor(page, () => document.getElementById('p').textContent.startsWith('TAI YRA'));
        await page.goto(`${base}/english.html?c=${n}`);
        await page.waitForTimeout(800);
        const text = await page.evaluate(() => document.getElementById('p').textContent);
        assert.ok(text.startsWith('This is'), 'an English page is not in the list');
      } finally {
        await setSettings(worker, port);
      }
    }));

    await check('a large page is translated visible part first and restored exactly', () => withPage(context, async (page, n) => {
      await page.goto(`${base}/big.html?c=${n}`);
      await page.waitForTimeout(500);
      const before = await page.evaluate(() => document.body.innerHTML);
      requests.length = 0;
      const t0 = Date.now();
      await toggle(worker, page);
      await waitFor(page, () => {
        const p = document.querySelector('main .card p');
        return p.textContent === p.textContent.toUpperCase();
      });
      const firstScreenMs = Date.now() - t0;
      await waitFor(page, () => [...document.querySelectorAll('main .card p')].every((p) => p.textContent === p.textContent.toUpperCase()), null, 20000);
      const wholeMs = Date.now() - t0;
      const firstCard = requests.findIndex((r) => r.q.some((q) => q.includes('Lietuvos Respublikos Vyriausybė')));
      assert.ok(firstCard >= 0 && firstCard < 3, `the top of the page goes out first (request #${firstCard + 1})`);
      await toggle(worker, page);
      const after = await page.evaluate(() => document.body.innerHTML);
      assert.equal(after, before, 'restored byte for byte');
      results.push({ name: `  ${requests.length} requests, first screen in ${firstScreenMs} ms, whole page in ${wholeMs} ms`, ok: true, ms: 0 });
    }));

    await check('without a key it explains what to do instead of failing silently', () => withPage(context, async (page, n) => {
      await setSettings(worker, port, { cloudApiKey: '' });
      try {
        await page.goto(`${base}/second.html?c=${n}`);
        await page.waitForTimeout(300);
        const res = await toggle(worker, page);
        assert.equal(res.ok, true);
        await page.waitForTimeout(500);
        const id = await tabIdOf(worker, page.url());
        const status = await worker.evaluate(async (tabId) => (await chrome.tabs.sendMessage(tabId, { type: 'nt:getReport' })).translation, id);
        assert.equal(status.errors.length, 1);
        assert.ok(!/errNoKey/.test(status.errors[0]), 'the message is localized: ' + status.errors[0]);
      } finally {
        await setSettings(worker, port);
      }
    }));
  } finally {
    await close();
    server.close();
  }
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ms ? ` (${r.ms} ms)` : ''}${r.ok ? '' : '\n     ' + r.error.replace(/\n/g, '\n     ')}`);
  }
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
