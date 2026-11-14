/*
 * NuTranslate DOM helpers: collects page text for language detection, reads the
 * text exactly the way Chrome's translate capture does, and manages the hidden
 * hint blocks used to steer Chrome's language model.
 */
(function (root) {
  'use strict';

  const core = root.NuTranslateCore;
  const HINT_TAG = 'nutranslate-hint';

  // Subtrees that never carry the page's prose.
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'title', 'svg', 'math',
    'canvas', 'video', 'audio', 'object', 'embed', 'iframe', 'frame', 'frameset',
    'code', 'pre', 'kbd', 'samp', 'var', 'textarea', 'input', 'select', 'option',
    'optgroup', 'datalist', 'output', HINT_TAG,
  ]);

  // Navigation, banners, footers, dialogs and cookie notices. Their text only
  // counts when the main content is too thin to decide.
  const BOILER_TAGS = new Set(['nav', 'header', 'footer', 'aside', 'menu', 'dialog']);
  const BOILER_ROLES = new Set([
    'navigation', 'banner', 'contentinfo', 'complementary', 'menu', 'menubar',
    'dialog', 'alertdialog', 'search', 'toolbar', 'tablist', 'tooltip',
  ]);
  const BOILER_NAME_RE = /cookie|consent|gdpr|onetrust|cookiebot|didomi|usercentrics|truste|cmp[-_]|cc[-_](?:window|banner)|privacy[-_]?banner/i;

  // Elements that start a new paragraph-like unit of text.
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center',
    'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'hgroup', 'hr', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p', 'section',
    'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'ul',
  ]);

  const LIMITS = Object.freeze({ maxChars: 60000, maxElements: 30000 });

  function hasClass(el, name) {
    return Boolean(el.classList && el.classList.contains(name));
  }

  function isBoilerplate(el, tag) {
    if (BOILER_TAGS.has(tag)) {
      // An <header> or <footer> inside an article belongs to the article.
      if ((tag === 'header' || tag === 'footer') && el.closest('article, main, [role="main"]')) return false;
      return true;
    }
    const role = el.getAttribute('role');
    if (role && BOILER_ROLES.has(role)) return true;
    const id = el.id;
    if (id && BOILER_NAME_RE.test(id)) return true;
    const cls = el.getAttribute('class');
    return Boolean(cls && BOILER_NAME_RE.test(cls));
  }

  function isExcluded(el) {
    return el.hidden === true ||
      el.getAttribute('aria-hidden') === 'true' ||
      el.getAttribute('translate') === 'no' ||
      hasClass(el, 'notranslate') ||
      el.isContentEditable === true;
  }

  function isRendered(el) {
    if (typeof el.checkVisibility !== 'function') return true;
    if (el.checkVisibility()) return true;
    // display: contents has no box of its own, but its children are rendered.
    const style = root.getComputedStyle ? root.getComputedStyle(el) : null;
    return Boolean(style && style.display === 'contents');
  }

  function getShadowRoot(el, tag) {
    if (el.shadowRoot) return el.shadowRoot;
    // Closed shadow roots are reachable from content scripts. Only custom
    // elements are worth the extra call.
    if (tag.indexOf('-') > 0 && root.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
      try {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /**
   * Walks the rendered DOM and returns paragraph-like text units:
   * [{ text, prose, boiler, meta: false }].
   */
  function collectTextUnits(doc) {
    const units = [];
    const visibleTextParent = new Map();
    const state = { chars: 0, elements: 0, done: false };
    let buffer = [];
    let bufferBoiler = false;

    function flush() {
      if (!buffer.length) return;
      const text = core.normalizeSpace(buffer.join(' '));
      buffer = [];
      if (!text || !core.hasLetters(text)) return;
      units.push({ text, prose: core.isProse(text), boiler: bufferBoiler, meta: false });
      state.chars += text.length;
      if (state.chars >= LIMITS.maxChars) state.done = true;
    }

    function textParentVisible(node) {
      const parent = node.parentElement;
      if (!parent || typeof parent.checkVisibility !== 'function') return true;
      let visible = visibleTextParent.get(parent);
      if (visible === undefined) {
        visible = parent.checkVisibility({ visibilityProperty: true });
        if (!visible) {
          const style = root.getComputedStyle ? root.getComputedStyle(parent) : null;
          visible = Boolean(style && style.display === 'contents' && style.visibility !== 'hidden');
        }
        visibleTextParent.set(parent, visible);
      }
      return visible;
    }

    function walk(parent, boiler) {
      for (let node = parent.firstChild; node && !state.done; node = node.nextSibling) {
        if (node.nodeType === 3) {
          const value = node.nodeValue;
          if (!value || !value.trim() || !textParentVisible(node)) continue;
          if (buffer.length && bufferBoiler !== boiler) flush();
          bufferBoiler = boiler;
          buffer.push(value);
        } else if (node.nodeType === 1) {
          visitElement(node, boiler);
        }
      }
    }

    function visitElement(el, boiler) {
      if (++state.elements > LIMITS.maxElements) {
        state.done = true;
        return;
      }
      const tag = el.localName;
      if (SKIP_TAGS.has(tag) || isExcluded(el) || !isRendered(el)) return;
      const inBoiler = boiler || isBoilerplate(el, tag);
      const isBlock = BLOCK_TAGS.has(tag);
      if (isBlock) flush();
      const shadow = getShadowRoot(el, tag);
      if (shadow) {
        walk(shadow, inBoiler);
        flush();
      }
      walk(el, inBoiler);
      if (isBlock) flush();
    }

    if (doc.body) walk(doc.body, false);
    flush();
    return units;
  }

  /** Title and description tags: the only text an empty single-page app has at load. */
  function collectMetaUnits(doc) {
    const seen = new Set();
    const units = [];
    const add = (raw) => {
      const text = core.normalizeSpace(raw || '');
      if (!text || !core.hasLetters(text) || seen.has(text)) return;
      seen.add(text);
      units.push({ text, prose: core.isProse(text), boiler: false, meta: true });
    };
    add(doc.title);
    const selectors = [
      'meta[name="description"]',
      'meta[property="og:title"]',
      'meta[property="og:description"]',
      'meta[name="twitter:description"]',
    ];
    for (const selector of selectors) {
      const meta = doc.querySelector(selector);
      if (meta) add(meta.getAttribute('content'));
    }
    return units;
  }

  /** The page text exactly as Chrome's translate capture reads it. */
  function readChromeContents(doc) {
    const html = doc.documentElement;
    if (!html) return '';
    const text = html.innerText || '';
    const max = core.CHROME.MAX_CAPTURE_CHARS;
    return text.length > max ? text.slice(0, max) : text;
  }

  function readDeclaredLanguage(doc) {
    const html = doc.documentElement;
    const meta = doc.querySelector('meta[http-equiv="content-language" i]');
    return {
      htmlLang: html ? html.getAttribute('lang') : null,
      metaContentLanguage: meta ? meta.getAttribute('content') : null,
    };
  }

  // Taken out of the layout flow and out of the accessibility tree, but still
  // rendered, so that it is part of innerText (which is what Chrome reads).
  const HINT_STYLE = [
    'all: initial',
    'display: block',
    'position: absolute',
    'left: 0',
    'top: 0',
    'width: 1px',
    'height: 1px',
    'margin: 0',
    'padding: 0',
    'border: 0',
    'overflow: hidden',
    'clip-path: inset(50%)',
    'white-space: nowrap',
    'opacity: 0',
    'pointer-events: none',
    'user-select: none',
  ].map((rule) => rule + ' !important').join('; ');

  function createHint(doc, text, position) {
    const el = doc.createElement(HINT_TAG);
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('data-position', position);
    el.style.cssText = HINT_STYLE;
    el.textContent = text;
    return el;
  }

  /**
   * Puts hint blocks with the given texts at the very start and the very end
   * of <body>. Passing an empty text removes that hint.
   */
  function applyHints(doc, hints, headText, tailText) {
    const body = doc.body;
    const next = { head: hints && hints.head, tail: hints && hints.tail };
    if (!body) return next;
    if (headText) {
      if (!next.head) next.head = createHint(doc, headText, 'head');
      else next.head.textContent = headText;
      if (body.firstChild !== next.head) body.insertBefore(next.head, body.firstChild);
    } else if (next.head) {
      next.head.remove();
      next.head = null;
    }
    if (tailText) {
      if (!next.tail) next.tail = createHint(doc, tailText, 'tail');
      else next.tail.textContent = tailText;
      if (body.lastChild !== next.tail) body.appendChild(next.tail);
    } else if (next.tail) {
      next.tail.remove();
      next.tail = null;
    }
    return next;
  }

  function removeHints(hints) {
    if (!hints) return;
    if (hints.head) hints.head.remove();
    if (hints.tail) hints.tail.remove();
    hints.head = null;
    hints.tail = null;
  }

  root.NuTranslateDom = {
    HINT_TAG,
    collectTextUnits,
    collectMetaUnits,
    readChromeContents,
    readDeclaredLanguage,
    applyHints,
    removeHints,
  };
})(globalThis);
