/*
 * NuTranslate settings, stored in chrome.storage.local under one key.
 *
 * Only the service worker, the popup and the options page read storage
 * directly. The service worker locks storage.local to trusted contexts and
 * hands content scripts a copy without the Google Cloud API key (see
 * publicSettings), so a web page can never get at the key.
 */
(function (root) {
  'use strict';

  const KEY = 'settings';

  const ENGINES = ['auto', 'cloud', 'ondevice'];

  const DEFAULTS = Object.freeze({
    enabled: true, // fix the page language for Chrome's built-in translator
    steering: true, // insert short-lived hidden hints when Chrome's model would be misled
    debug: false, // log decisions to the page console
    disabledHosts: [], // sites where the extension does nothing
    targetLang: '', // translate into this language; empty: the browser's language
    engine: 'auto', // auto: Google Cloud when a key is set, otherwise Chrome's offline translator
    cloudApiKey: '',
    cloudEndpoint: '', // empty: the official Cloud Translation endpoint (tests use a local one)
    autoLanguages: [], // pages in these languages are translated without the hotkey
    restoreOnSubmit: true, // show the original right before a form is sent
    toast: true, // small on-page messages when translating
  });

  function normalizeLang(code) {
    const c = String(code || '').trim();
    return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(c) ? c : '';
  }

  /** "https://www.Example.com:8080/path" or "*.example.com" -> "example.com". */
  function normalizeHost(host) {
    let h = String(host || '').trim().toLowerCase();
    if (!h) return '';
    h = h.replace(/^[a-z][a-z0-9+.-]*:\/\//, '').replace(/^\*\./, '');
    try {
      h = new URL('http://' + h).hostname; // drops ports and paths, converts IDN to punycode
    } catch (e) {
      return '';
    }
    return h.replace(/^www\./, '').replace(/\.$/, '');
  }

  /**
   * Match patterns that keep the content script off disabled sites. Hosts that
   * cannot be expressed as a pattern are skipped rather than breaking the
   * registration.
   */
  function excludeMatchesFor(hosts) {
    const patterns = [];
    for (const raw of hosts || []) {
      const h = normalizeHost(raw);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) patterns.push(`*://${h}/*`);
      else if (/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(h)) patterns.push(`*://*.${h}/*`);
    }
    return [...new Set(patterns)];
  }

  function normalize(raw) {
    const s = raw && typeof raw === 'object' ? raw : {};
    const hosts = Array.isArray(s.disabledHosts) ? s.disabledHosts : [];
    const auto = Array.isArray(s.autoLanguages) ? s.autoLanguages : String(s.autoLanguages || '').split(/[\s,;]+/);
    return {
      enabled: s.enabled !== false,
      steering: s.steering !== false,
      debug: s.debug === true,
      disabledHosts: [...new Set(hosts.map(normalizeHost).filter(Boolean))].sort(),
      targetLang: normalizeLang(s.targetLang),
      engine: ENGINES.includes(s.engine) ? s.engine : 'auto',
      cloudApiKey: typeof s.cloudApiKey === 'string' ? s.cloudApiKey.trim() : '',
      cloudEndpoint: typeof s.cloudEndpoint === 'string' ? s.cloudEndpoint.trim() : '',
      autoLanguages: [...new Set(auto.map((c) => normalizeLang(c).toLowerCase().split('-')[0]).filter(Boolean))],
      restoreOnSubmit: s.restoreOnSubmit !== false,
      toast: s.toast !== false,
    };
  }

  /** What content scripts get: everything except the API key. */
  function publicSettings(settings) {
    const copy = Object.assign({}, settings);
    delete copy.cloudApiKey;
    delete copy.cloudEndpoint;
    copy.hasCloudKey = Boolean(settings.cloudApiKey);
    return copy;
  }

  /** A disabled host also disables its subdomains. */
  function isDisabledHost(settings, host) {
    const h = normalizeHost(host);
    return settings.disabledHosts.some((d) => h === d || h.endsWith('.' + d));
  }

  /** Whether NuTranslate runs on a site at all (translation and language fix). */
  function isEnabledFor(settings, host) {
    return !isDisabledHost(settings, host);
  }

  async function load() {
    try {
      const stored = await chrome.storage.local.get(KEY);
      return normalize(stored[KEY]);
    } catch (e) {
      return normalize();
    }
  }

  async function save(patch) {
    const next = normalize(Object.assign({}, await load(), patch));
    await chrome.storage.local.set({ [KEY]: next });
    return next;
  }

  async function setHostEnabled(host, enabled) {
    const current = await load();
    const h = normalizeHost(host);
    const hosts = current.disabledHosts.filter((d) => d !== h);
    if (!enabled) hosts.push(h);
    return save({ disabledHosts: hosts });
  }

  async function setAutoLanguage(lang, enabled) {
    const current = await load();
    const code = String(lang || '').toLowerCase().split('-')[0];
    const list = current.autoLanguages.filter((l) => l !== code);
    if (enabled && code) list.push(code);
    return save({ autoLanguages: list });
  }

  const api = {
    KEY, DEFAULTS, ENGINES, normalize, normalizeHost, normalizeLang, excludeMatchesFor, publicSettings,
    isDisabledHost, isEnabledFor, load, save, setHostEnabled, setAutoLanguage,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NuTranslateSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
