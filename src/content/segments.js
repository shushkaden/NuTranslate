/*
 * NuTranslate segments: walks the DOM and cuts it into translation segments,
 * paragraph-like runs of text with their inline elements (see markup.js), plus
 * the attributes worth translating (placeholder, title, alt, aria-label).
 *
 * What is never touched, so that forms and scripts keep working:
 *  - form data: <textarea> content, input values, values of named buttons;
 *  - code: <code>, <pre>, <kbd>, <samp>, <var>;
 *  - anything marked translate="no" or class="notranslate", and editable areas;
 *  - scripts, styles, SVG, MathML, media, iframes.
 */
(function (root) {
  'use strict';

  const LETTER_RE = /\p{L}/u;

  // Not walked at all.
  const SKIP_TAGS = new Set([
    'script', 'style', 'noscript', 'template', 'head', 'title', 'meta', 'link',
    'svg', 'math', 'canvas', 'video', 'audio', 'object', 'embed', 'iframe',
    'frame', 'frameset', 'textarea', 'nutranslate-hint', 'nutranslate-toast',
  ]);

  // Kept as a fixed placeholder inside a sentence; their content is not translated.
  const OPAQUE_TAGS = new Set([
    'code', 'pre', 'kbd', 'samp', 'var', 'tt', 'img', 'picture', 'br', 'wbr',
    'input', 'meter', 'progress', 'ruby',
  ]);

  // Always start a new segment.
  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'body', 'caption', 'center',
    'dd', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header',
    'hgroup', 'hr', 'html', 'legend', 'li', 'main', 'menu', 'nav', 'ol', 'p',
    'section', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
    'ul', 'select', 'option', 'optgroup', 'datalist',
  ]);

  // Usually inline: checked with computed style, because sites often make them blocks.
  const INLINE_DISPLAYS = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'contents', 'ruby', 'ruby-text']);

  const TEXT_ATTRS = ['title', 'aria-label'];

  function hasLetters(text) {
    return Boolean(text) && LETTER_RE.test(text);
  }

  function isOpaque(el, tag) {
    return OPAQUE_TAGS.has(tag) ||
      el.getAttribute('translate') === 'no' ||
      (el.classList && el.classList.contains('notranslate')) ||
      el.getAttribute('contenteditable') === 'true' ||
      el.getAttribute('contenteditable') === '' ||
      el.getAttribute('contenteditable') === 'plaintext-only';
  }

  function createBlockTester() {
    const cache = new WeakMap();
    return function isBlockLike(el) {
      const tag = el.localName;
      if (BLOCK_TAGS.has(tag)) return true;
      let block = cache.get(el);
      if (block === undefined) {
        let display = '';
        try {
          display = getComputedStyle(el).display;
        } catch (e) {
          display = 'inline';
        }
        block = display !== '' && !INLINE_DISPLAYS.has(display);
        cache.set(el, block);
      }
      return block;
    };
  }

  function getShadowRoot(el) {
    if (el.shadowRoot) return el.shadowRoot;
    if (el.localName.indexOf('-') > 0 && root.chrome && chrome.dom && chrome.dom.openOrClosedShadowRoot) {
      try {
        return chrome.dom.openOrClosedShadowRoot(el) || null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /**
   * Collects segments and attribute targets under rootNode.
   * options.originalText(node) / options.originalAttr(el, name) return the
   * original value of something that is already translated, so that a
   * paragraph that changed partly is sent again in its original language.
   */
  function collectSegments(rootNode, options) {
    const opts = options || {};
    const originalText = opts.originalText || (() => undefined);
    const originalAttr = opts.originalAttr || (() => undefined);
    const isBlockLike = opts.isBlockLike || createBlockTester();
    const segments = [];
    const attrs = [];
    const shadowRoots = [];
    const openStack = [];
    let current = null;
    let currentBlock = rootNode.nodeType === 1 ? rootNode : rootNode.host || null;

    function startSegment() {
      current = { tokens: [], texts: [], nodes: [], elements: [], block: currentBlock, option: null, hasText: false };
      if (currentBlock && currentBlock.localName === 'option') current.option = currentBlock;
      for (const el of openStack) {
        current.tokens.push({ t: 'open', el: current.elements.push(el) - 1 });
      }
    }

    function endSegment() {
      if (!current) return;
      for (let i = 0; i < openStack.length; i++) current.tokens.push({ t: 'close' });
      if (current.hasText) segments.push(current);
      current = null;
    }

    function addAttr(el, name) {
      const value = el.getAttribute(name);
      if (value === null) return;
      const original = originalAttr(el, name);
      const text = original !== undefined ? original : value;
      if (hasLetters(text)) attrs.push({ el, name, text });
    }

    function collectAttrs(el, tag) {
      for (const name of TEXT_ATTRS) if (el.hasAttribute(name)) addAttr(el, name);
      if ((tag === 'input' || tag === 'textarea') && el.hasAttribute('placeholder')) addAttr(el, 'placeholder');
      if ((tag === 'img' || tag === 'area' || (tag === 'input' && el.type === 'image')) && el.hasAttribute('alt')) addAttr(el, 'alt');
      if (tag === 'optgroup' && el.hasAttribute('label')) addAttr(el, 'label');
      // A button's value is only sent with the form when the button has a name.
      if (tag === 'input' && /^(button|submit|reset)$/i.test(el.type) && el.hasAttribute('value') && !el.hasAttribute('name')) {
        addAttr(el, 'value');
      }
    }

    function visitText(node) {
      const value = node.nodeValue;
      if (!value) return;
      const original = originalText(node);
      const text = original !== undefined ? original : value;
      if (!current) {
        if (!/\S/.test(text)) return; // blank text before any words: not part of a sentence
        startSegment();
      }
      current.tokens.push({ t: 'text', id: current.texts.push(text) - 1 });
      current.nodes.push(node);
      if (!current.hasText && hasLetters(text)) current.hasText = true;
    }

    function visitChildren(parent) {
      for (let node = parent.firstChild; node; node = node.nextSibling) {
        if (node.nodeType === 3) visitText(node);
        else if (node.nodeType === 1) visitElement(node);
      }
    }

    function visitIsolated(container, block) {
      // A nested block or a shadow tree: its own segments, outside the current sentence.
      endSegment();
      const savedStack = openStack.splice(0);
      const savedBlock = currentBlock;
      currentBlock = block;
      visitChildren(container);
      endSegment();
      currentBlock = savedBlock;
      openStack.push(...savedStack);
    }

    function visitElement(el) {
      const tag = el.localName;
      if (SKIP_TAGS.has(tag)) {
        if (tag === 'textarea') collectAttrs(el, tag);
        return;
      }
      if (isOpaque(el, tag)) {
        if (tag === 'img' || tag === 'input') collectAttrs(el, tag);
        if (current) current.tokens.push({ t: 'void', el: current.elements.push(el) - 1 });
        return;
      }
      collectAttrs(el, tag);
      const shadow = getShadowRoot(el);
      if (shadow) {
        shadowRoots.push(shadow);
        visitIsolated(shadow, el);
        visitIsolated(el, el);
        return;
      }
      if (isBlockLike(el)) {
        visitIsolated(el, el);
        return;
      }
      if (current) current.tokens.push({ t: 'open', el: current.elements.push(el) - 1 });
      openStack.push(el);
      visitChildren(el);
      openStack.pop();
      if (current) current.tokens.push({ t: 'close' });
    }

    if (rootNode.nodeType === 3) visitText(rootNode);
    else if (rootNode.nodeType === 1) visitElement(rootNode);
    else visitChildren(rootNode); // a shadow root or a fragment
    endSegment();
    return { segments, attrs, shadowRoots };
  }

  /** True when node sits inside something that must not be translated. */
  function isExcludedRegion(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el) {
      const tag = el.localName;
      if (SKIP_TAGS.has(tag) || isOpaque(el, tag)) return true;
      if (el.parentElement) el = el.parentElement;
      else if (el.parentNode && el.parentNode.host) el = el.parentNode.host;
      else break;
    }
    return false;
  }

  /** The nearest block-like ancestor: the smallest region worth re-translating. */
  function closestBlock(node, isBlockLike) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el) {
      if (el.localName === 'body' || isBlockLike(el)) return el;
      if (el.parentElement) el = el.parentElement;
      else if (el.parentNode && el.parentNode.host) el = el.parentNode.host;
      else break;
    }
    return node.ownerDocument ? node.ownerDocument.body : null;
  }

  /** Distance from the viewport in pixels (0 = visible now), for ordering requests. */
  function viewportDistance(el, viewportHeight) {
    if (!el || !el.getBoundingClientRect) return Number.MAX_SAFE_INTEGER;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return Number.MAX_SAFE_INTEGER / 2; // hidden: last
    if (r.bottom < 0) return -r.bottom;
    if (r.top > viewportHeight) return r.top - viewportHeight;
    return 0;
  }

  root.NuTranslateSegments = { collectSegments, closestBlock, createBlockTester, viewportDistance, isExcludedRegion, SKIP_TAGS };
})(globalThis);
