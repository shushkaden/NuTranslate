/*
 * NuTranslate core: the pure language-decision logic.
 *
 * Nothing in this file touches the DOM or chrome.* APIs, so the same code runs
 * in the content script (as a classic script that defines a global) and in the
 * Node unit tests (as a CommonJS module).
 *
 * Background, verified against Chromium sources (components/translate,
 * components/language_detection):
 *  - Chrome reads <html lang> (or Content-Language) once, at the first full
 *    rendering lifecycle update after the parser has finished, and compares it
 *    with its TFLite language model.
 *  - The model only looks at document.documentElement.innerText: its first 256
 *    characters, plus the last 256 and the middle 256 when the text is longer
 *    than 768 characters, and keeps the single most confident prediction.
 *  - If the model is not confident, Chrome trusts the declared language. If the
 *    model disagrees confidently, Chrome trusts the model only when the page
 *    claims English and the model says one of 12 "popular" languages
 *    (es, pt, ja, ru, de, zh-CN, zh-TW, ar, id, fr, it, th). Otherwise the page
 *    language becomes "und" (unknown).
 *  So a Lithuanian page that declares lang="en" ends up as "en" or "und", and a
 *  correctly declared Lithuanian page with an English cookie banner at the end
 *  ends up as "und".
 */
(function (root) {
  'use strict';

  /** Numbers taken from Chromium so the simulation matches what Chrome does. */
  const CHROME = Object.freeze({
    MAX_CAPTURE_CHARS: 65535, // kMaxIndexChars in chrome_render_frame_observer.cc
    SAMPLE_LENGTH: 256, // kTextSampleLength and kModelTruncationLength
    MULTI_SAMPLE_THRESHOLD: 768, // kNumTextSamples * kTextSampleLength
  });

  const DEFAULT_OPTIONS = Object.freeze({
    minShare: 0.6, // the winning language must own this share of the text
    minReliableChars: 150, // ...and this much text in reliably detected chunks
    absoluteMinReliableChars: 50, // CLD3 refuses to be "reliable" below ~50 bytes
    chunkTarget: 420, // characters per detection chunk (CLD3 samples 512 bytes)
    minChunk: 120, // short texts are merged until they reach this size
    maxChunks: 24, // detection calls per pass, spread evenly over the page
    unreliableWeight: 0.35, // weight of chunks CLD3 marks as unreliable
  });

  // Codes that name the same language. CLD3 still emits some legacy codes.
  const ALIASES = Object.freeze({
    iw: 'he', jw: 'jv', in: 'id', ji: 'yi', mo: 'ro', tl: 'fil',
    nb: 'no', nn: 'no', sh: 'sr', cmn: 'zh',
  });

  // Languages that detectors (and Chrome itself) confuse with each other. We
  // never "correct" one of them into another one.
  const SIMILAR_GROUPS = Object.freeze([
    ['bs', 'hr', 'sr', 'cnr'],
    ['hi', 'ne'],
    ['ms', 'id'],
  ]);

  // Scripts that do not separate words with spaces.
  const NO_SPACE_SCRIPT_RE = /[฀-๿຀-໿က-႟ក-៿぀-ヿ㐀-䶿一-鿿豈-﫿]/;
  const LETTER_RE = /\p{L}/u;
  const LETTERS_RE = /\p{L}/gu;

  function baseLang(code) {
    if (typeof code !== 'string') return '';
    const m = code.trim().toLowerCase().match(/^([a-z]{2,3})(?:[-_]|$)/);
    return m ? m[1] : '';
  }

  function canonicalLang(code) {
    const b = baseLang(code);
    return ALIASES[b] || b;
  }

  /** Rough BCP 47 check, close to what Chrome accepts in the lang attribute. */
  function isValidLangTag(code) {
    return typeof code === 'string' && /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(code.trim());
  }

  function sameLanguage(a, b) {
    const x = canonicalLang(a);
    const y = canonicalLang(b);
    if (!x || !y) return false;
    if (x === y) return true;
    return SIMILAR_GROUPS.some((g) => g.includes(x) && g.includes(y));
  }

  function normalizeSpace(text) {
    return String(text).replace(/\s+/g, ' ').trim();
  }

  function hasLetters(text) {
    return LETTER_RE.test(text);
  }

  function countLetters(text) {
    const m = String(text).match(LETTERS_RE);
    return m ? m.length : 0;
  }

  /** Sentences and paragraphs, as opposed to menu items, buttons and labels. */
  function isProse(text) {
    const len = text.length;
    if (len >= 40) {
      let spaces = 0;
      for (let i = 0; i < len && spaces < 4; i++) if (text.charCodeAt(i) === 32) spaces++;
      if (spaces >= 4) return true;
    }
    return len >= 20 && NO_SPACE_SCRIPT_RE.test(text);
  }

  function sumLength(texts) {
    let n = 0;
    for (const t of texts) n += t.length;
    return n;
  }

  /**
   * Splits texts into detection chunks. Long texts are cut at word boundaries,
   * short neighbours are merged, so that one chunk never mixes a long English
   * paragraph with a long Lithuanian one. Returns at most maxChunks chunks,
   * picked evenly across the page.
   */
  function makeChunks(texts, opts) {
    const o = Object.assign({}, DEFAULT_OPTIONS, opts);
    const chunks = [];
    let pending = '';
    const flushPending = () => {
      if (pending) chunks.push(pending);
      pending = '';
    };
    for (const raw of texts) {
      const text = normalizeSpace(raw);
      if (!text) continue;
      if (text.length >= o.minChunk) {
        flushPending();
        let rest = text;
        while (rest.length > o.chunkTarget * 1.5) {
          let cut = rest.lastIndexOf(' ', o.chunkTarget);
          if (cut < o.chunkTarget * 0.5) cut = o.chunkTarget;
          chunks.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if (rest) chunks.push(rest);
      } else {
        pending = pending ? pending + ' ' + text : text;
        if (pending.length >= o.minChunk) flushPending();
      }
    }
    flushPending();
    if (chunks.length <= o.maxChunks) return chunks;
    const picked = [];
    const step = chunks.length / o.maxChunks;
    for (let i = 0; i < o.maxChunks; i++) picked.push(chunks[Math.floor(i * step)]);
    return picked;
  }

  /**
   * Combines per-chunk results of chrome.i18n.detectLanguage, which look like
   * { isReliable, languages: [{ language, percentage }] }, into a distribution.
   */
  function aggregate(results, opts) {
    const o = Object.assign({}, DEFAULT_OPTIONS, opts);
    const byLang = new Map();
    let totalWeight = 0;
    let totalChars = 0;
    for (const { text, result } of results) {
      const len = text.length;
      totalChars += len;
      const langs = result && Array.isArray(result.languages) ? result.languages : [];
      const factor = result && result.isReliable ? 1 : o.unreliableWeight;
      totalWeight += len * factor;
      langs.forEach((l, index) => {
        const code = canonicalLang(l.language);
        if (!code) return;
        const entry = byLang.get(code) || { lang: code, weight: 0, reliableChars: 0, chunks: 0 };
        entry.weight += len * factor * (Number(l.percentage) || 0) / 100;
        if (index === 0) {
          entry.chunks += 1;
          if (result.isReliable) entry.reliableChars += len;
        }
        byLang.set(code, entry);
      });
    }
    const distribution = [...byLang.values()]
      .map((e) => Object.assign(e, { share: totalWeight ? e.weight / totalWeight : 0 }))
      .sort((a, b) => b.weight - a.weight);
    return { distribution, totalWeight, totalChars, chunkCount: results.length };
  }

  function decide(agg, opts) {
    const o = Object.assign({}, DEFAULT_OPTIONS, opts);
    const top = agg.distribution[0];
    if (!top) return { confident: false, reason: 'no-language', lang: null, share: 0, ...agg };
    const needReliable = Math.max(
      o.absoluteMinReliableChars,
      Math.min(o.minReliableChars, agg.totalChars * 0.5),
    );
    let reason = 'ok';
    if (top.share < o.minShare) reason = 'mixed';
    else if (top.reliableChars < needReliable) reason = 'too-little-reliable-text';
    return {
      confident: reason === 'ok',
      reason,
      lang: top.lang,
      share: top.share,
      reliableChars: top.reliableChars,
      ...agg,
    };
  }

  /**
   * Text passes from narrow to broad. The first pass that yields a confident
   * answer wins, so an English cookie banner or footer only counts when the
   * main content is too thin to decide on its own.
   */
  const PASSES = Object.freeze([
    { name: 'main-prose', min: 120, accept: (u) => u.prose && !u.boiler && !u.meta },
    { name: 'all-prose', min: 120, accept: (u) => u.prose && !u.meta },
    { name: 'main-text', min: 60, accept: (u) => !u.boiler && !u.meta },
    { name: 'all-text', min: 60, accept: (u) => !u.meta },
    { name: 'with-meta', min: 30, accept: () => true },
  ]);

  /**
   * units: [{ text, prose, boiler, meta }] collected from the page.
   * detect: synchronous function(text) -> detectLanguage result (or null).
   */
  function detectPageLanguage(units, detect, opts) {
    let last = null;
    let previousSize = -1;
    for (const pass of PASSES) {
      const texts = units.filter(pass.accept).map((u) => u.text);
      const size = sumLength(texts);
      if (size < pass.min || size === previousSize) continue;
      previousSize = size;
      const chunks = makeChunks(texts, opts);
      const results = chunks.map((text) => ({ text, result: detect(text) }));
      const decision = decide(aggregate(results, opts), opts);
      decision.pass = pass.name;
      decision.goodChunks = decision.lang
        ? results
          .filter((r) => r.result && r.result.isReliable && r.result.languages && r.result.languages[0] &&
            sameLanguage(r.result.languages[0].language, decision.lang))
          .map((r) => r.text)
        : [];
      if (decision.confident) return decision;
      last = decision;
    }
    return last || { confident: false, reason: 'no-text', lang: null, share: 0, distribution: [], totalChars: 0, goodChunks: [] };
  }

  /** Where Chrome's language model looks inside the captured page text. */
  function chromeSampleWindows(length) {
    const L = CHROME.SAMPLE_LENGTH;
    const windows = [{ name: 'start', start: 0, end: Math.min(L, length) }];
    if (length > CHROME.MULTI_SAMPLE_THRESHOLD) {
      windows.push({ name: 'end', start: length - L, end: length });
      const mid = Math.floor(length / 2);
      windows.push({ name: 'middle', start: mid, end: Math.min(mid + L, length) });
    }
    return windows;
  }

  /**
   * Tells whether a 256-character window could make Chrome's model vote for
   * another language. Our detector (CLD3) and Chrome's (TFLite) disagree on
   * mixed windows, so besides the whole window every line with enough letters
   * is checked on its own: "Skip to main content" next to Lithuanian text is
   * enough for TFLite to answer English with full confidence.
   */
  function checkWindow(sample, targetLang, detect) {
    if (countLetters(sample) < 30) return { lang: null, reliable: false, bad: false, foreign: null };
    const result = detect(sample);
    const top = result && result.languages && result.languages[0];
    const lang = top ? canonicalLang(top.language) : null;
    if (lang && !sameLanguage(lang, targetLang)) {
      return { lang, reliable: Boolean(result.isReliable), bad: true, foreign: lang };
    }
    for (const line of sample.split(/\n+/)) {
      if (countLetters(line) < 40) continue;
      const r = detect(line);
      const t = r && r.isReliable && r.languages && r.languages[0];
      if (t && !sameLanguage(t.language, targetLang)) {
        return { lang, reliable: Boolean(result && result.isReliable), bad: true, foreign: canonicalLang(t.language) };
      }
    }
    return { lang, reliable: Boolean(result && result.isReliable), bad: false, foreign: null };
  }

  /**
   * Runs our detector over Chrome's three sample windows. A window is "bad"
   * when it holds real text in another language: Chrome keeps the single most
   * confident window, so one bad window is enough to flip the result.
   */
  function simulateChromeSamples(contents, targetLang, detect) {
    const text = contents.length > CHROME.MAX_CAPTURE_CHARS
      ? contents.slice(0, CHROME.MAX_CAPTURE_CHARS)
      : contents;
    return chromeSampleWindows(text.length).map((w) => {
      const sample = text.slice(w.start, w.end);
      return Object.assign({ name: w.name, start: w.start }, checkWindow(sample, targetLang, detect), {
        preview: sample.slice(0, 80),
      });
    });
  }

  /**
   * Picks a position for Chrome's middle window inside text that is already in
   * the target language, looking outward from the current middle.
   * isGood(start) tells whether the 256-character window at start is fine.
   */
  function findGoodMiddle(length, isGood, maxSteps) {
    const L = CHROME.SAMPLE_LENGTH;
    const mid = Math.floor(length / 2);
    const steps = maxSteps || 12;
    for (let k = 1; k <= steps; k++) {
      for (const sign of [1, -1]) {
        const p = mid + sign * k * (L / 2);
        if (p < 0 || p + L * 1.5 > length) continue;
        // Require two overlapping windows so that small offset errors still land on good text.
        if (isGood(p) && isGood(p + L / 2)) return p + L / 4;
      }
    }
    return -1;
  }

  /**
   * Computes the lengths of the hidden hint blocks inserted before and after
   * the page text so that Chrome's three windows fall on target-language text.
   *
   * With a head hint of H characters and a tail hint of T characters, the
   * captured text is roughly H + 1 + N + 1 + T long, so the middle window
   * starts at (H + N + T) / 2 + 1 and, measured in the original text, at
   * (N + T - H) / 2. Growing T moves it later, growing H moves it earlier.
   */
  function planHints(length, bad, goodMiddle) {
    const MIN = CHROME.SAMPLE_LENGTH + 64;
    const MAX = CHROME.MAX_CAPTURE_CHARS - 2;
    let head = bad.start ? MIN : 0;
    let tail = bad.end ? MIN : 0;
    if (bad.middle) {
      if (goodMiddle >= 0) {
        const d = 2 * goodMiddle - length; // desired tail - head
        head = Math.max(head, tail - d);
        tail = head + d;
      } else {
        // Nothing usable near the middle: make the head hint long enough to
        // contain the middle window itself.
        head = Math.max(head, length + tail + 2 * CHROME.SAMPLE_LENGTH + 64);
      }
    }
    if (head + length + tail > MAX) {
      // Chrome truncates the capture, so a tail hint past the cut is useless.
      tail = 0;
      if (head + CHROME.SAMPLE_LENGTH > MAX) head = MIN;
    }
    return { head: Math.max(0, Math.round(head)), tail: Math.max(0, Math.round(tail)) };
  }

  /** Builds hint text of exactly `length` characters from target-language text. */
  function buildHintText(goodTexts, length) {
    if (length <= 0) return '';
    const source = normalizeSpace(goodTexts.join(' '));
    if (!source) return '';
    let out = '';
    while (out.length < length) out += (out ? ' ' : '') + source;
    // A word cut in half at the end does not matter to a language model.
    return out.slice(0, length);
  }

  const api = {
    CHROME,
    DEFAULT_OPTIONS,
    PASSES,
    baseLang,
    canonicalLang,
    isValidLangTag,
    sameLanguage,
    normalizeSpace,
    hasLetters,
    countLetters,
    isProse,
    sumLength,
    makeChunks,
    aggregate,
    decide,
    detectPageLanguage,
    chromeSampleWindows,
    checkWindow,
    simulateChromeSamples,
    findGoodMiddle,
    planHints,
    buildHintText,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NuTranslateCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
