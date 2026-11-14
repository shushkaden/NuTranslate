/*
 * NuTranslate settings, stored in chrome.storage.local under one key.
 * Shared by the content script, the popup and the options page.
 */
(function (root) {
  'use strict';

  const KEY = 'settings';

  const DEFAULTS = Object.freeze({
    enabled: true, // fix the page language at all
    steering: true, // insert short-lived hidden hints when Chrome's model would be misled
    debug: false, // log decisions to the page console
    disabledHosts: [], // sites where the extension does nothing
  });

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
    return {
      enabled: s.enabled !== false,
      steering: s.steering !== false,
      debug: s.debug === true,
      disabledHosts: [...new Set(hosts.map(normalizeHost).filter(Boolean))].sort(),
    };
  }

  /** A disabled host also disables its subdomains. */
  function isDisabledHost(settings, host) {
    const h = normalizeHost(host);
    return settings.disabledHosts.some((d) => h === d || h.endsWith('.' + d));
  }

  function isEnabledFor(settings, host) {
    return settings.enabled && !isDisabledHost(settings, host);
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

  const api = {
    KEY, DEFAULTS, normalize, normalizeHost, excludeMatchesFor, isDisabledHost, isEnabledFor, load, save, setHostEnabled,
  };

  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NuTranslateSettings = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
