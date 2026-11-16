/*
 * NuTranslate page translator.
 *
 * Design goals, in order:
 *  1. Never break the page. Only the values of existing text nodes and of a
 *     few attributes change; no element is added, removed or moved (unlike
 *     Chrome's built-in translator, which wraps text in <font> tags and breaks
 *     React and Vue apps). Form data is never translated.
 *  2. Restore exactly. Every change is recorded and undone on the hotkey, and
 *     automatically right before a form is submitted.
 *  3. Start from the right language: the page language comes from our own
 *     detector, and each paragraph long enough is checked on its own, so an
 *     English cookie banner on a Lithuanian site is translated from English.
 */
(function (root) {
  'use strict';

  const core = root.NuTranslateCore;
  const dom = root.NuTranslateDom;
  const M = root.NuTranslateMarkup;
  const Seg = root.NuTranslateSegments;
  const OnDevice = root.NuTranslateOnDevice;

  const BATCH_CHARS = 4000;
  const BATCH_ITEMS = 100;
  const MAX_SEGMENT_CHARS = 8000;
  const PARALLEL = { cloud: 3, ondevice: 1 };
  const DEBOUNCE_MS = 300;
  const MAX_WAIT_MS = 1000;
  const OBSERVE_OPTIONS = {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['title', 'aria-label', 'placeholder', 'alt', 'label', 'value'],
  };

  let deps = null; // { detectSync, getConfig, onChange }

  const state = {
    active: false,
    done: false,
    gen: 0,
    source: null,
    target: null,
    engine: null,
    records: new Map(), // Text -> { original, applied }
    attrRecords: new Map(), // Element -> Map(name -> { original, applied })
    pinned: new Map(), // <option> -> value pinned so that the form still submits the original
    observer: null,
    observedRoots: new WeakSet(),
    pending: new Set(),
    timer: null,
    firstPendingAt: 0,
    total: 0,
    finished: 0,
    errors: [],
    restoredBy: null,
    quiet: false, // translation started automatically on page load: no progress toasts
  };

  const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

  function languageName(code) {
    if (!code || code === 'auto') return t('languageAuto');
    try {
      const locale = (chrome.i18n.getMessage('messagesLocale') || 'en').replace('_', '-');
      return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code;
    } catch (e) {
      return code;
    }
  }

  function config() {
    return deps.getConfig();
  }

  function resolveTarget(settings) {
    const wanted = settings.targetLang || chrome.i18n.getUILanguage() || 'en';
    const base = core.canonicalLang(wanted);
    // Keep the script/region subtag only where it matters.
    if (base === 'zh') return /hant|tw|hk|mo/i.test(wanted) ? 'zh-TW' : 'zh-CN';
    if (base === 'pt' && /pt-pt/i.test(wanted)) return 'pt-PT';
    return base || 'en';
  }

  function pickEngine(cfg) {
    const engine = cfg.settings.engine;
    if (engine === 'cloud' || engine === 'ondevice') return engine;
    return cfg.settings.hasCloudKey ? 'cloud' : 'ondevice';
  }

  function chromeTranslated() {
    const cl = document.documentElement.classList;
    return cl.contains('translated-ltr') || cl.contains('translated-rtl');
  }

  function hasLetters(text) {
    return core.hasLetters(text || '');
  }

  // ---------------------------------------------------------------- records

  function showsTranslation(node) {
    const rec = state.records.get(node);
    return Boolean(rec && rec.applied !== null && node.nodeValue === rec.applied);
  }

  function originalText(node) {
    return showsTranslation(node) ? state.records.get(node).original : undefined;
  }

  function attrRecord(el, name) {
    const recs = state.attrRecords.get(el);
    return recs ? recs.get(name) : undefined;
  }

  function originalAttr(el, name) {
    const r = attrRecord(el, name);
    return r && r.applied !== null && el.getAttribute(name) === r.applied ? r.original : undefined;
  }

  // ------------------------------------------------------------------ toast

  const toastUi = { host: null, box: null, timer: null };

  const TOAST_CSS = `
    .box { font: 13px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
      color: #fff; background: rgba(32, 33, 36, 0.94); border-radius: 10px; padding: 9px 14px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25); max-width: 360px; opacity: 0;
      transform: translateY(8px); transition: opacity 0.15s, transform 0.15s; }
    .box.show { opacity: 1; transform: none; }
    .box.error { background: rgba(179, 38, 30, 0.95); }
    .brand { font-weight: 600; margin-right: 6px; }`;

  function toast(text, options) {
    const opts = options || {};
    if (!config().settings.toast && !opts.important) return;
    try {
      if (!toastUi.host || !toastUi.host.isConnected) {
        const host = document.createElement('nutranslate-toast');
        host.style.cssText = 'all: initial !important; position: fixed !important; right: 16px !important; bottom: 16px !important; z-index: 2147483647 !important; pointer-events: none !important;';
        const shadow = host.attachShadow({ mode: 'closed' });
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(TOAST_CSS);
        shadow.adoptedStyleSheets = [sheet];
        const box = document.createElement('div');
        box.className = 'box';
        box.setAttribute('role', 'status');
        shadow.appendChild(box);
        document.documentElement.appendChild(host);
        toastUi.host = host;
        toastUi.box = box;
      }
      const box = toastUi.box;
      box.textContent = '';
      const brand = document.createElement('span');
      brand.className = 'brand';
      brand.textContent = 'NuTranslate';
      box.append(brand, document.createTextNode(text));
      box.className = 'box' + (opts.error ? ' error' : '');
      requestAnimationFrame(() => box.classList.add('show'));
      clearTimeout(toastUi.timer);
      if (!opts.sticky) {
        toastUi.timer = setTimeout(() => box.classList.remove('show'), opts.error ? 7000 : 2600);
      }
    } catch (e) {
      // A toast is nice to have; never let it break anything.
    }
  }

  function shortcutHint(key) {
    const shortcut = config().shortcut;
    return shortcut ? t(key, [shortcut]) : '';
  }

  // ------------------------------------------------------------------ engine

  function errorMessage(err) {
    const code = err && err.code;
    switch (code) {
      case 'no-key': return t('errNoKey');
      case 'ondevice-unsupported': return t('errOnDeviceUnsupported');
      case 'ondevice-pair-unavailable': return t('errOnDevicePair', [languageName(state.source), languageName(state.target)]);
      case 'ondevice-needs-download': return t('errOnDeviceDownload', [languageName(state.source), languageName(state.target)]);
      case 'ondevice-needs-source': return t('errOnDeviceSource');
      default: return t('errGeneric', [String((err && err.message) || err)]);
    }
  }

  async function engineTranslate(payloads, source) {
    if (state.engine === 'ondevice') return OnDevice.translate(payloads, source, state.target);
    const response = await chrome.runtime.sendMessage({ type: 'nt:translate', items: payloads, sl: source, tl: state.target });
    if (!response || !response.ok) {
      const err = new Error((response && response.error) || 'no response');
      err.code = response && response.code;
      throw err;
    }
    return response.translations;
  }

  // --------------------------------------------------------------- applying

  function applySegment(item, translatedHtml) {
    const { seg, built } = item;
    const { values } = M.mapTranslation(seg, built, translatedHtml);
    if (!values.size) return;
    const option = seg.option;
    if (option && option.isConnected && !option.hasAttribute('value') && !state.pinned.has(option)) {
      // Without a value attribute an <option> submits its text: pin the original.
      const value = option.value;
      option.setAttribute('value', value);
      state.pinned.set(option, value);
    }
    for (const [id, value] of values) {
      const node = seg.nodes[id];
      if (!node.isConnected) continue;
      const rec = state.records.get(node);
      const shownOriginal = rec && rec.applied !== null && node.nodeValue === rec.applied ? rec.original : node.nodeValue;
      if (shownOriginal !== seg.texts[id]) continue; // the page changed it meanwhile; the observer requeues it
      if (rec) rec.applied = value;
      else state.records.set(node, { original: node.nodeValue, applied: value });
      if (node.nodeValue !== value) node.nodeValue = value;
    }
  }

  function applyAttr(target, value) {
    const { el, name, text } = target;
    const translated = (value || '').trim();
    if (!el.isConnected || !translated) return;
    let recs = state.attrRecords.get(el);
    const rec = recs && recs.get(name);
    const current = el.getAttribute(name);
    const shownOriginal = rec && rec.applied !== null && current === rec.applied ? rec.original : current;
    if (shownOriginal !== text) return;
    if (!recs) {
      recs = new Map();
      state.attrRecords.set(el, recs);
    }
    recs.set(name, { original: shownOriginal, applied: translated });
    if (current !== translated) el.setAttribute(name, translated);
  }

  // ------------------------------------------------------------- collecting

  /** Source language for one text: its own when it is long enough to tell, else the page's. Null: already in the target language. */
  function sourceFor(text) {
    if (core.countLetters(text) >= 40) {
      const r = deps.detectSync(text);
      const top = r && r.isReliable && r.languages && r.languages[0];
      if (top) {
        const lang = core.canonicalLang(top.language);
        if (core.sameLanguage(lang, state.target)) return null;
        return lang;
      }
    }
    return state.source;
  }

  function plainItems(seg, source, priority) {
    // One item per text node: for the offline engine, and for huge paragraphs.
    const items = [];
    seg.tokens.forEach((tok) => {
      if (tok.t !== 'text') return;
      const text = seg.texts[tok.id];
      if (!hasLetters(text) || showsTranslation(seg.nodes[tok.id])) return;
      const mini = { tokens: [{ t: 'text', id: 0 }], texts: [text], nodes: [seg.nodes[tok.id]], elements: [], block: seg.block, option: seg.option };
      const built = M.buildMarkup(mini);
      items.push({ kind: 'seg', seg: mini, built, sl: source, priority, payload: state.engine === 'ondevice' ? text.trim() : built.html });
    });
    return items;
  }

  function collectItems(region) {
    const isBlockLike = Seg.createBlockTester();
    const found = Seg.collectSegments(region, { originalText, originalAttr, isBlockLike });
    for (const shadowRoot of found.shadowRoots) observe(shadowRoot);
    const viewport = window.innerHeight || 800;
    const distances = new Map();
    const distance = (el) => {
      if (!distances.has(el)) distances.set(el, Seg.viewportDistance(el, viewport));
      return distances.get(el);
    };
    const items = [];
    for (const seg of found.segments) {
      if (!seg.nodes.some((n) => hasLetters(n.nodeValue) && !showsTranslation(n))) continue;
      const source = sourceFor(M.segmentText(seg));
      if (source === null) continue;
      const priority = distance(seg.block);
      const built = M.buildMarkup(seg);
      if (state.engine === 'ondevice' || built.chars > MAX_SEGMENT_CHARS) {
        items.push(...plainItems(seg, source, priority));
      } else {
        items.push({ kind: 'seg', seg, built, sl: source, priority, payload: built.html });
      }
    }
    for (const attr of found.attrs) {
      const rec = attrRecord(attr.el, attr.name);
      if (rec && rec.applied !== null && attr.el.getAttribute(attr.name) === rec.applied) continue;
      const source = sourceFor(attr.text);
      if (source === null) continue;
      const payload = state.engine === 'ondevice' ? attr.text : M.escapeHtml(attr.text);
      items.push({ kind: 'attr', attr, sl: source, priority: distance(attr.el), payload });
    }
    items.sort((a, b) => a.priority - b.priority);
    return items;
  }

  function makeBatches(items) {
    const open = new Map();
    const batches = [];
    for (const item of items) {
      let batch = open.get(item.sl);
      const size = item.payload.length;
      if (!batch || batch.items.length >= BATCH_ITEMS || (batch.chars + size > BATCH_CHARS && batch.items.length)) {
        batch = { sl: item.sl, items: [], chars: 0 };
        open.set(item.sl, batch);
        batches.push(batch);
      }
      batch.items.push(item);
      batch.chars += size;
    }
    return batches;
  }

  async function runBatch(batch, gen) {
    let results;
    try {
      results = await engineTranslate(batch.items.map((i) => i.payload), batch.sl);
    } catch (err) {
      if (gen === state.gen) reportError(err);
      return;
    }
    if (gen !== state.gen || !state.active) return;
    batch.items.forEach((item, i) => {
      const out = results[i];
      if (typeof out !== 'string') return;
      if (item.kind === 'attr') applyAttr(item.attr, state.engine === 'ondevice' ? out : M.decodeEntities(out));
      else applySegment(item, state.engine === 'ondevice' ? M.escapeHtml(out) : out);
    });
    // Our own writes are queued as mutations too; handling them here keeps
    // them apart from the page's changes (they are recognised and skipped).
    if (state.observer) handleMutations(state.observer.takeRecords());
    state.finished += batch.items.length;
    progress();
  }

  async function translateRegion(region, gen) {
    if (!region || Seg.isExcludedRegion(region)) return;
    const items = collectItems(region);
    if (!items.length) return;
    state.total += items.length;
    const batches = makeBatches(items);
    let next = 0;
    const lane = async () => {
      while (next < batches.length && gen === state.gen) await runBatch(batches[next++], gen);
    };
    const lanes = Math.min(PARALLEL[state.engine] || 1, batches.length);
    await Promise.all(Array.from({ length: lanes }, lane));
  }

  // --------------------------------------------------------- dynamic content

  function isOurs(node) {
    const el = node.nodeType === 1 ? node : node.parentElement;
    return Boolean(el && el.closest && el.closest('nutranslate-toast, nutranslate-hint'));
  }

  function observe(target) {
    if (!state.observer || state.observedRoots.has(target)) return;
    state.observer.observe(target, OBSERVE_OPTIONS);
    state.observedRoots.add(target);
  }

  function queue(node) {
    state.pending.add(node);
    const now = Date.now();
    if (!state.firstPendingAt) state.firstPendingAt = now;
    clearTimeout(state.timer);
    const wait = now - state.firstPendingAt >= MAX_WAIT_MS ? 0 : DEBOUNCE_MS;
    state.timer = setTimeout(flush, wait);
  }

  function handleMutations(mutations) {
    if (!state.active) return;
    for (const m of mutations) {
      if (m.type === 'characterData') {
        const node = m.target;
        const rec = state.records.get(node);
        if (rec && node.nodeValue === rec.applied) continue; // our own write
        if (rec) {
          // The page put new text here: that is the new original.
          rec.original = node.nodeValue;
          rec.applied = null;
        }
        if (!isOurs(node)) queue(node);
      } else if (m.type === 'childList') {
        for (const node of m.addedNodes) {
          if ((node.nodeType === 1 || node.nodeType === 3) && !isOurs(node)) queue(node);
        }
      } else if (m.type === 'attributes') {
        const el = m.target;
        const name = m.attributeName;
        if (name === 'value' && state.pinned.has(el)) continue;
        const rec = attrRecord(el, name);
        const current = el.getAttribute(name);
        if (rec && current === rec.applied) continue;
        if (rec) {
          rec.original = current;
          rec.applied = null;
        }
        if (!isOurs(el)) queue(el);
      }
    }
  }

  function pruneRecords() {
    // Long-lived single-page apps replace content all the time: forget nodes that are gone.
    if (state.records.size < 5000) return;
    for (const node of state.records.keys()) if (!node.isConnected) state.records.delete(node);
    for (const el of state.attrRecords.keys()) if (!el.isConnected) state.attrRecords.delete(el);
  }

  async function flush() {
    state.timer = null;
    state.firstPendingAt = 0;
    const nodes = [...state.pending];
    state.pending.clear();
    if (!state.active) return;
    pruneRecords();
    const gen = state.gen;
    const isBlockLike = Seg.createBlockTester();
    const regions = [];
    for (const node of nodes) {
      if (!node.isConnected) continue;
      const region = Seg.closestBlock(node, isBlockLike);
      if (region && !regions.includes(region)) regions.push(region);
    }
    const outer = regions.filter((r) => !regions.some((o) => o !== r && o.contains(r)));
    for (const region of outer) {
      if (gen !== state.gen) return;
      await translateRegion(region, gen);
    }
  }

  // ------------------------------------------------------------- lifecycle

  function progress() {
    if (!state.active || state.done || state.quiet) return;
    const percent = state.total ? Math.round((state.finished / state.total) * 100) : 0;
    toast(t('toastTranslatingProgress', [languageName(state.source), languageName(state.target), String(percent)]), { sticky: true });
  }

  function reportError(err) {
    const message = errorMessage(err);
    if (state.errors.includes(message)) return;
    state.errors.push(message);
    toast(message, { error: true, important: true });
    deps.onChange();
  }

  async function translatePage(reason) {
    if (state.active) return status();
    if (chromeTranslated()) {
      toast(t('toastChromeTranslated'), { important: true });
      return status();
    }
    const cfg = config();
    const target = resolveTarget(cfg.settings);
    const engine = pickEngine(cfg);
    const detection = detectNow();
    let source = detection.confident ? detection.lang : 'auto';
    if (engine === 'ondevice' && source === 'auto' && detection.lang) source = detection.lang; // the offline engine needs a guess
    if (reason === 'auto' && source !== 'auto' && core.sameLanguage(source, target)) return status();

    state.active = true;
    state.done = false;
    state.gen++;
    state.source = source;
    state.target = target;
    state.engine = engine;
    state.total = 0;
    state.finished = 0;
    state.errors = [];
    state.restoredBy = null;
    state.quiet = reason === 'auto';
    const gen = state.gen;

    state.observer = new MutationObserver(handleMutations);
    state.observedRoots = new WeakSet();
    observe(document.documentElement);
    deps.onChange();
    progress();

    await translateRegion(document.body || document.documentElement, gen);
    if (gen !== state.gen) return status();
    state.done = true;
    if (!state.errors.length && !state.quiet) {
      const hint = shortcutHint('toastHintShowOriginal');
      toast(t('toastTranslated', [languageName(state.source), languageName(state.target)]) + (hint ? ' · ' + hint : ''));
    }
    deps.onChange();
    return status();
  }

  function restorePage(reason) {
    if (!state.active) return status();
    state.active = false;
    state.done = false;
    state.gen++;
    if (state.observer) state.observer.disconnect();
    state.observer = null;
    clearTimeout(state.timer);
    state.timer = null;
    state.pending.clear();

    for (const [node, rec] of state.records) {
      if (rec.applied !== null && node.nodeValue === rec.applied) node.nodeValue = rec.original;
    }
    for (const [el, recs] of state.attrRecords) {
      for (const [name, rec] of recs) {
        if (rec.applied !== null && el.getAttribute(name) === rec.applied) el.setAttribute(name, rec.original);
      }
    }
    for (const [option, value] of state.pinned) {
      if (option.getAttribute('value') === value) option.removeAttribute('value');
    }
    state.records = new Map();
    state.attrRecords = new Map();
    state.pinned = new Map();
    state.restoredBy = reason;

    const hint = shortcutHint('toastHintTranslateAgain');
    const text = reason === 'submit' ? t('toastRestoredForSubmit') : t('toastRestored');
    toast(text + (hint ? ' · ' + hint : ''), { important: reason === 'submit' });
    deps.onChange();
    return status();
  }

  function toggle(reason) {
    if (state.active) return restorePage(reason || 'toggle');
    translatePage(reason || 'toggle');
    return status();
  }

  function detectNow() {
    try {
      const units = dom.collectTextUnits(document).concat(dom.collectMetaUnits(document));
      const d = core.detectPageLanguage(units, deps.detectSync);
      return { lang: d.lang, confident: d.confident };
    } catch (e) {
      return { lang: null, confident: false };
    }
  }

  function status() {
    return {
      active: state.active,
      done: state.done,
      source: state.source,
      target: state.target,
      engine: state.engine,
      total: state.total,
      finished: state.finished,
      errors: state.errors.slice(-3),
      restoredBy: state.restoredBy,
    };
  }

  function onSubmit() {
    if (state.active && config().settings.restoreOnSubmit) restorePage('submit');
  }

  function init(dependencies) {
    deps = dependencies;
    // Capture phase on window: runs before any handler of the page.
    window.addEventListener('submit', onSubmit, true);
  }

  root.NuTranslateTranslator = { init, translatePage, restorePage, toggle, status, isActive: () => state.active };
})(globalThis);
