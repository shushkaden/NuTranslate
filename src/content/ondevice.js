/*
 * Chrome's offline translator (the Translator API, Chrome 138+ on desktop),
 * used from the content script. It needs no key and sends nothing to the
 * network, but a language pack has to be downloaded once, and Chrome only
 * allows that after a click, so the first download starts from the
 * NuTranslate settings page.
 */
(function (root) {
  'use strict';

  class EngineError extends Error {
    constructor(code, message) {
      super(message || code);
      this.code = code;
    }
  }

  // The Translator API uses BCP 47 codes; CLD3 still emits a few legacy ones.
  function apiCode(code) {
    const c = String(code || '').toLowerCase();
    if (c === 'iw') return 'he';
    if (c === 'jw') return 'jv';
    if (c === 'zh-cn') return 'zh';
    if (c === 'zh-tw') return 'zh-Hant';
    return code;
  }

  const translators = new Map();

  function getTranslator(source, target) {
    if (typeof Translator === 'undefined') return Promise.reject(new EngineError('ondevice-unsupported'));
    const key = source + '|' + target;
    let pending = translators.get(key);
    if (!pending) {
      pending = (async () => {
        const languages = { sourceLanguage: apiCode(source), targetLanguage: apiCode(target) };
        const availability = await Translator.availability(languages);
        if (availability === 'unavailable') throw new EngineError('ondevice-pair-unavailable');
        if (availability === 'downloadable') throw new EngineError('ondevice-needs-download');
        return Translator.create(languages);
      })();
      translators.set(key, pending);
      pending.catch(() => translators.delete(key));
    }
    return pending;
  }

  /** Translates plain texts one by one: the model handles single sentences best. */
  async function translate(texts, source, target) {
    if (!source || source === 'auto') throw new EngineError('ondevice-needs-source');
    const translator = await getTranslator(source, target);
    const out = [];
    for (const text of texts) out.push(await translator.translate(text));
    return out;
  }

  root.NuTranslateOnDevice = { translate, apiCode, EngineError };
})(globalThis);
