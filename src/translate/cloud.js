/*
 * Google Cloud Translation API (v2, "Basic"), called with the user's own API
 * key. It is the official way to use Google's translation engine; Google
 * charges per character beyond a monthly free allowance.
 * https://cloud.google.com/translate/docs/reference/rest/v2/translate
 */
(function (root) {
  'use strict';

  const ENDPOINT = 'https://translation.googleapis.com/language/translate/v2';
  const MAX_ITEMS = 128; // the API's limit of q values per request
  const MAX_CHARS = 5000; // keep requests small, as the API documentation recommends

  class CloudError extends Error {
    constructor(code, message, status) {
      super(message || code);
      this.code = code;
      this.status = status || 0;
    }
  }

  /** Cloud Translation codes: zh needs a script, the rest of our codes are accepted as they are. */
  function cloudCode(code) {
    const c = String(code || '');
    const lower = c.toLowerCase();
    if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh-hans') return 'zh-CN';
    if (lower === 'zh-tw' || lower === 'zh-hant' || lower === 'zh-hk') return 'zh-TW';
    return c;
  }

  /** Splits items into requests that respect the API limits. */
  function chunk(items) {
    const chunks = [];
    let current = [];
    let chars = 0;
    items.forEach((item, index) => {
      const size = item.length;
      if (current.length && (current.length >= MAX_ITEMS || chars + size > MAX_CHARS)) {
        chunks.push(current);
        current = [];
        chars = 0;
      }
      current.push(index);
      chars += size;
    });
    if (current.length) chunks.push(current);
    return chunks;
  }

  function buildRequest(items, source, target, apiKey, endpoint) {
    const body = { q: items, target: cloudCode(target), format: 'html' };
    if (source && source !== 'auto') body.source = cloudCode(source);
    return {
      url: endpoint || ENDPOINT,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey },
        body: JSON.stringify(body),
      },
    };
  }

  function parseResponse(status, data, expected) {
    if (status < 200 || status >= 300) {
      const message = data && data.error && data.error.message;
      const code = status === 400 && /api key/i.test(message || '') ? 'bad-key' : 'http-' + status;
      throw new CloudError(code, message || `HTTP ${status}`, status);
    }
    const list = data && data.data && data.data.translations;
    if (!Array.isArray(list) || list.length !== expected) throw new CloudError('bad-response', 'Unexpected response from Cloud Translation');
    return list.map((t) => (t && typeof t.translatedText === 'string' ? t.translatedText : null));
  }

  /**
   * Translates HTML strings. fetchImpl is injectable for tests.
   * Returns an array of the same length; same-language items come back as is.
   */
  async function translate(items, source, target, apiKey, options) {
    const opts = options || {};
    if (!apiKey) throw new CloudError('no-key', 'No Google Cloud API key');
    const doFetch = opts.fetch || fetch;
    const out = new Array(items.length).fill(null);
    if (source && source !== 'auto' && cloudCode(source).toLowerCase() === cloudCode(target).toLowerCase()) {
      items.forEach((item, i) => (out[i] = item));
      return out;
    }
    for (const indexes of chunk(items)) {
      const { url, init } = buildRequest(indexes.map((i) => items[i]), source, target, apiKey, opts.endpoint);
      let response;
      try {
        response = await doFetch(url, init);
      } catch (e) {
        throw new CloudError('network', e && e.message ? e.message : 'Network error');
      }
      let data = null;
      try {
        data = await response.json();
      } catch (e) {
        data = null;
      }
      parseResponse(response.status, data, indexes.length).forEach((value, j) => {
        out[indexes[j]] = value;
      });
    }
    return out;
  }

  const api = { ENDPOINT, MAX_ITEMS, MAX_CHARS, CloudError, cloudCode, chunk, buildRequest, parseResponse, translate };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NuTranslateCloud = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
