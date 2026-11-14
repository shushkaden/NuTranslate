/*
 * NuTranslate content script. Runs at document_start in the top frame.
 *
 * Timing is the whole point here (see core.js for the Chromium details):
 *  1. Chrome reads <html lang> and the page text at the first full rendering
 *     update after the parser has finished.
 *  2. DOMContentLoaded listeners run synchronously inside the parser's finish
 *     step, before that update can happen. (Content scripts declared with
 *     run_at: document_end are injected asynchronously and can be too late.)
 *  3. requestAnimationFrame callbacks run in the frame whose rendering update
 *     performs Chrome's capture, right before it.
 * So: detect and fix the lang attribute in DOMContentLoaded, check Chrome's
 * sample windows in the first animation frame, and clean up right after it.
 */
(function () {
  'use strict';

  const core = globalThis.NuTranslateCore;
  const dom = globalThis.NuTranslateDom;
  const Settings = globalThis.NuTranslateSettings;
  if (!core || !dom || !Settings || window.top !== window) return;
  if (globalThis.__nuTranslateStarted) return;
  globalThis.__nuTranslateStarted = true;

  const doc = document;
  const contentType = doc.contentType || 'text/html';
  if (!/html/i.test(contentType)) return;

  let settings = Settings.normalize();
  let settingsLoaded = false;
  let target = null; // the language we decided on
  let hints = { head: null, tail: null };
  let guard = null;
  let captureDone = false;
  let deferredDetections = 0;

  const report = {
    url: location.href,
    host: location.hostname,
    status: 'waiting', // waiting | disabled | no-text | uncertain | kept | changed | error
    declared: null,
    detection: null,
    applied: null,
    guardReapplied: 0,
    steering: null,
    settingsLoadedInTime: null,
    timings: {},
  };

  const log = (...args) => {
    if (settings.debug) console.debug('[NuTranslate]', ...args);
  };

  // The service worker already keeps this script off disabled sites. Settings
  // are still read here for the debug flag, and as a safety net in case the
  // site was turned off while the page was loading.
  Settings.load().then((loaded) => {
    settings = loaded;
    settingsLoaded = true;
    if (report.status !== 'waiting' && report.status !== 'disabled' && !Settings.isEnabledFor(settings, location.hostname)) revert();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'nt:getReport') {
      sendResponse(JSON.parse(JSON.stringify(report)));
    }
  });

  /**
   * chrome.i18n.detectLanguage runs CLD3 inside this renderer and invokes its
   * callback synchronously, which is what lets us finish before Chrome looks.
   */
  function detectSync(text) {
    let result = null;
    try {
      chrome.i18n.detectLanguage(text, (r) => {
        result = r;
      });
    } catch (e) {
      return null;
    }
    if (!result) deferredDetections++;
    return result;
  }

  function setLang(lang) {
    doc.documentElement.setAttribute('lang', lang);
  }

  function isTranslatedByChrome() {
    const cl = doc.documentElement.classList;
    return cl.contains('translated-ltr') || cl.contains('translated-rtl');
  }

  /** Keeps page scripts from resetting lang before Chrome has read it. */
  function installGuard() {
    guard = new MutationObserver(() => {
      if (captureDone || isTranslatedByChrome()) return;
      const current = doc.documentElement.getAttribute('lang');
      if (core.isValidLangTag(current) && core.sameLanguage(current, target)) return;
      report.guardReapplied++;
      log('page changed lang to', current, '- restoring', target);
      setLang(target);
    });
    guard.observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
  }

  function summarizeDetection(d) {
    return {
      lang: d.lang,
      confident: d.confident,
      reason: d.reason,
      share: Math.round((d.share || 0) * 1000) / 1000,
      reliableChars: d.reliableChars || 0,
      totalChars: d.totalChars || 0,
      chunks: d.chunkCount || 0,
      pass: d.pass || null,
      distribution: (d.distribution || []).slice(0, 4).map((e) => ({ lang: e.lang, share: Math.round(e.share * 1000) / 1000 })),
    };
  }

  function onReady() {
    try {
      decideAndFix();
    } catch (e) {
      // Never let a bug here break the page; just report it.
      report.status = 'error';
      report.error = e && e.message ? e.message : String(e);
      afterCapture(finish);
    }
  }

  function decideAndFix() {
    if (report.status !== 'waiting') return;
    report.settingsLoadedInTime = settingsLoaded;
    if (!Settings.isEnabledFor(settings, location.hostname)) {
      report.status = 'disabled';
      afterCapture(finish);
      return;
    }
    const t0 = performance.now();
    report.declared = dom.readDeclaredLanguage(doc);
    const units = dom.collectTextUnits(doc).concat(dom.collectMetaUnits(doc));
    const decision = core.detectPageLanguage(units, detectSync);
    report.detection = summarizeDetection(decision);
    report.timings.detectMs = Math.round((performance.now() - t0) * 10) / 10;
    log('detection', report.detection);

    if (!decision.lang || !decision.confident) {
      report.status = decision.totalChars ? 'uncertain' : 'no-text';
      afterCapture(finish);
      return;
    }

    target = decision.lang;
    const declared = report.declared.htmlLang;
    if (core.isValidLangTag(declared) && core.sameLanguage(declared, target)) {
      report.status = 'kept';
    } else {
      setLang(target);
      report.status = 'changed';
      report.applied = target;
      installGuard();
      log('lang', JSON.stringify(declared), '->', target);
    }

    // The service worker injects a flag file when hints are turned off, so this
    // check does not depend on storage answering in time.
    if (!globalThis.__nuTranslateNoSteering) {
      requestAnimationFrame(() => steer(decision.goodChunks || []));
    } else {
      report.steering = { checked: false, applied: false, reason: 'off' };
      afterCapture(finish);
    }
  }

  /** Runs in the frame in which Chrome captures the page, right before it. */
  function steer(goodTexts) {
    const t0 = performance.now();
    const st = { checked: true, applied: false, before: null, after: null, head: 0, tail: 0, rounds: 0, reason: null };
    report.steering = st;
    try {
      if (captureDone || report.status === 'disabled') return;
      const contents = dom.readChromeContents(doc);
      const isBad = (s) => s.bad;
      st.before = core.simulateChromeSamples(contents, target, detectSync);
      if (!st.before.some(isBad)) {
        st.reason = 'not-needed';
        return;
      }
      if (core.sumLength(goodTexts) < 200) {
        st.reason = 'not-enough-text';
        return;
      }
      const bad = {};
      for (const s of st.before) bad[s.name] = s.bad;
      const windowIsGood = (text) => (start) =>
        !core.checkWindow(text.slice(start, start + core.CHROME.SAMPLE_LENGTH), target, detectSync).bad;
      const goodMiddle = bad.middle ? core.findGoodMiddle(contents.length, windowIsGood(contents)) : -1;
      let plan = core.planHints(contents.length, bad, goodMiddle);
      let applied = plan;
      let after = null;
      for (let round = 0; round < 3; round++) {
        st.rounds = round + 1;
        hints = dom.applyHints(doc, hints, core.buildHintText(goodTexts, plan.head), core.buildHintText(goodTexts, plan.tail));
        applied = plan;
        const now = dom.readChromeContents(doc);
        after = core.simulateChromeSamples(now, target, detectSync);
        const middle = after.find((s) => s.name === 'middle');
        if (round === 2 || !middle || !middle.bad || goodMiddle < 0) break;
        // Measure where the original text starts now and move the middle
        // window onto the good spot we picked.
        let offset = 0;
        if (plan.head) {
          const probe = contents.slice(0, 48);
          const found = probe ? now.indexOf(probe, Math.max(0, plan.head - 8)) : -1;
          offset = found >= 0 ? found : plan.head + 1;
        }
        const current = Math.floor(now.length / 2) - offset;
        const delta = goodMiddle - current;
        if (Math.abs(delta) < 16) break;
        plan = delta > 0
          ? { head: plan.head, tail: plan.tail + 2 * delta }
          : { head: plan.head - 2 * delta, tail: plan.tail };
      }
      st.after = after;
      st.head = applied.head;
      st.tail = applied.tail;
      st.applied = Boolean(hints.head || hints.tail);
      st.reason = after && after.some(isBad) ? 'partial' : 'fixed';
      log('steering', st);
    } catch (e) {
      st.reason = 'error: ' + (e && e.message ? e.message : String(e));
      dom.removeHints(hints);
    } finally {
      report.timings.steerMs = Math.round((performance.now() - t0) * 10) / 10;
      // A task posted from inside the animation frame runs after the frame's
      // rendering update, that is after Chrome has captured the page.
      setTimeout(() => {
        onCaptureDone();
        finish();
      }, 0);
    }
  }

  function afterCapture(callback) {
    requestAnimationFrame(() => setTimeout(() => {
      onCaptureDone();
      callback();
    }, 0));
  }

  function onCaptureDone() {
    captureDone = true;
    dom.removeHints(hints);
    if (guard) guard.disconnect();
    guard = null;
  }

  function revert() {
    onCaptureDone();
    if (report.status === 'changed' && report.declared) {
      const original = report.declared.htmlLang;
      if (!isTranslatedByChrome()) {
        if (original === null) doc.documentElement.removeAttribute('lang');
        else setLang(original);
      }
    }
    report.status = 'disabled';
    report.applied = null;
    finish();
  }

  function finish() {
    report.deferredDetections = deferredDetections;
    const steered = Boolean(report.steering && report.steering.applied);
    try {
      chrome.runtime.sendMessage({
        type: 'nt:status',
        status: report.status,
        lang: target,
        declared: report.declared ? report.declared.htmlLang : null,
        steered,
      }).catch(() => {});
    } catch (e) {
      // The extension was reloaded or updated; this page keeps the old script.
    }
  }

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', onReady, { capture: true, once: true });
  } else {
    onReady();
  }
})();
