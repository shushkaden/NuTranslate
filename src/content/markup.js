/*
 * NuTranslate markup: turns one translation segment (a paragraph-like run of
 * text with inline elements) into HTML for the translation engine, and maps
 * the translated HTML back onto the original text nodes.
 *
 * The page's DOM structure is never changed: every element stays where it is,
 * only the values of existing text nodes are replaced. That keeps React, Vue
 * and friends happy and makes restoring the original exact.
 *
 * A segment is described by tokens:
 *   { t: 'text', id }   a text node; segment.texts[id] holds its original value
 *   { t: 'open', el }   an inline element with translatable content
 *   { t: 'close' }
 *   { t: 'void', el }   an element whose content is not translated (code, img, br...)
 * Inline elements become <a i=N>...</a> placeholders, which Google's engines
 * keep and move together with the words they wrap.
 *
 * Text between two placeholders of the same container is a "gap". The
 * translation of each gap goes into the first non-blank text node of the
 * original gap. If the engine moves placeholders around, gaps are matched by
 * position, so the words still land next to the right elements, and no
 * element is ever moved.
 */
(function (root) {
  'use strict';

  const ROOT = -1;

  function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
      if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named !== undefined ? named : whole;
    });
  }

  // HTML collapses only ASCII whitespace; a no-break space is real content.
  function collapse(text) {
    return text.replace(/[ \t\n\r\f]+/g, ' ');
  }

  function trimSpace(text) {
    return text.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, '');
  }

  function hasEdgeSpace(text) {
    return /^[ \t\n\r\f]|[ \t\n\r\f]$/.test(text);
  }

  function newContainer() {
    return { gaps: [[]], children: 0 };
  }

  /**
   * Returns { html, containers, chars } where containers maps a container key
   * (ROOT or an element index) to { gaps: [[textId, ...], ...], children }.
   */
  function buildMarkup(segment) {
    const containers = new Map([[ROOT, newContainer()]]);
    const stack = [ROOT];
    let html = '';
    let chars = 0;
    for (const tok of segment.tokens) {
      const current = containers.get(stack[stack.length - 1]);
      if (tok.t === 'text') {
        const text = collapse(segment.texts[tok.id]);
        current.gaps[current.gaps.length - 1].push(tok.id);
        html += escapeHtml(text);
        chars += text.length;
      } else if (tok.t === 'open') {
        current.children++;
        current.gaps.push([]);
        containers.set(tok.el, newContainer());
        stack.push(tok.el);
        html += `<a i=${tok.el}>`;
      } else if (tok.t === 'close') {
        if (stack.length > 1) stack.pop();
        html += '</a>';
      } else if (tok.t === 'void') {
        current.children++;
        current.gaps.push([]);
        html += `<a i=${tok.el}></a>`;
      }
    }
    return { html, containers, chars };
  }

  const TOKEN_RE = /<a\b[^>]*?\bi\s*=\s*["']?(\d+)["']?[^>]*?(\/?)>|<\/a\s*>|<[^>]*>|[^<]+|</gi;

  /**
   * Parses the engine's answer into the same container/gap shape, with the
   * gap texts instead of text node ids: Map key -> { gaps: [string], children }.
   * Unknown tags are dropped, a placeholder seen twice is ignored the second time.
   */
  function parseTranslated(html) {
    const containers = new Map([[ROOT, { gaps: [''], children: 0 }]]);
    const stack = [ROOT];
    const ignored = { gaps: [''], children: 0 };
    let ignoredDepth = 0; // inside a duplicated placeholder
    let foreignLinks = 0; // <a> tags without i=, so their </a> does not close ours
    TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = TOKEN_RE.exec(html))) {
      const token = m[0];
      if (m[1] !== undefined) {
        const key = Number(m[1]);
        const selfClosing = m[2] === '/';
        if (ignoredDepth) {
          if (!selfClosing) ignoredDepth++;
          continue;
        }
        if (containers.has(key)) {
          // The engine repeated a placeholder: keep the first copy, drop this one.
          if (!selfClosing) ignoredDepth = 1;
          continue;
        }
        const current = containers.get(stack[stack.length - 1]);
        current.children++;
        current.gaps.push('');
        containers.set(key, { gaps: [''], children: 0 });
        if (!selfClosing) stack.push(key);
      } else if (/^<\/a\s*>$/i.test(token)) {
        if (ignoredDepth) ignoredDepth--;
        else if (foreignLinks) foreignLinks--;
        else if (stack.length > 1) stack.pop();
      } else if (token.length > 1 && token[0] === '<') {
        // An unexpected tag (<b>, <br>...): ignore it, keep its text.
        if (/^<a\b/i.test(token) && !/\/>$/.test(token)) foreignLinks++;
      } else {
        const target = ignoredDepth ? ignored : containers.get(stack[stack.length - 1]);
        target.gaps[target.gaps.length - 1] += decodeEntities(token);
      }
    }
    return containers;
  }

  function leadingSpace(text) {
    const m = text.match(/^[ \t\n\r\f]+/);
    return m ? m[0] : '';
  }

  function trailingSpace(text) {
    const m = text.match(/[ \t\n\r\f]+$/);
    return m ? m[0] : '';
  }

  /** Writes the translation of one gap into its text nodes. */
  function assignGap(texts, ids, translated, out) {
    if (!ids.length) return;
    const raw = translated || '';
    const value = trimSpace(collapse(raw));
    const filled = ids.filter((id) => /\S/.test(texts[id]));
    if (!filled.length) {
      // Only blank nodes here. Use the first one if the engine put words here.
      if (value) out.set(ids[0], ' ' + value + ' ');
      return;
    }
    const first = filled[0];
    const original = texts[first];
    // Keep a space wherever either the original or the translation had one, so
    // that words never stick to the neighbouring element.
    const lead = leadingSpace(original) || (/^[ \t\n\r\f]/.test(raw) ? ' ' : '');
    const trail = trailingSpace(original) || (/[ \t\n\r\f]$/.test(raw) ? ' ' : '');
    out.set(first, value ? lead + value + trail : (hasEdgeSpace(original) ? ' ' : ''));
    for (const id of filled.slice(1)) {
      // The whole gap went into the first node; keep a space so words do not stick together.
      out.set(id, hasEdgeSpace(texts[id]) ? ' ' : '');
    }
  }

  /**
   * Maps translated HTML back to text nodes.
   * Returns { values: Map<textId, string>, exact: boolean }. exact is false
   * when the engine changed the placeholder structure and text had to be merged.
   */
  function mapTranslation(segment, built, translatedHtml) {
    const translated = parseTranslated(translatedHtml);
    const values = new Map();
    let exact = true;
    for (const [key, original] of built.containers) {
      const t = translated.get(key);
      if (!t) {
        exact = false;
        continue; // the engine dropped this element: its text stays untranslated
      }
      let gaps = t.gaps;
      if (gaps.length !== original.gaps.length) {
        exact = false;
        // Put everything in the first gap that has real text.
        const all = gaps.join(' ');
        const target = Math.max(0, original.gaps.findIndex((ids) => ids.some((id) => /\S/.test(segment.texts[id]))));
        gaps = original.gaps.map((_, i) => (i === target ? all : ''));
      }
      original.gaps.forEach((ids, i) => assignGap(segment.texts, ids, gaps[i], values));
    }
    return { values, exact };
  }

  /** Plain text of a segment, for language detection and logging. */
  function segmentText(segment) {
    return trimSpace(collapse(segment.tokens.filter((t) => t.t === 'text').map((t) => segment.texts[t.id]).join('')));
  }

  const api = { ROOT, escapeHtml, decodeEntities, buildMarkup, parseTranslated, mapTranslation, segmentText };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NuTranslateMarkup = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
