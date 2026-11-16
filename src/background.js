/*
 * NuTranslate service worker.
 *
 * 1. Registers the content script dynamically. On a site that is turned off
 *    the script is not injected at all, and switches that the page needs
 *    synchronously (language fix off, hints off) are passed as tiny flag
 *    files, because reading storage from the page would be asynchronous and
 *    could lose the race against Chrome's language capture.
 * 2. Owns the translation hotkey and the per-tab translation mode: once the
 *    page is translated with the hotkey, the next pages in that tab are
 *    translated too, until the hotkey turns it off.
 * 3. Talks to Google Cloud Translation with the user's key (the key never
 *    leaves the service worker and the extension pages), with a cache and a
 *    monthly character counter.
 * 4. Draws the toolbar badge:
 *    purple "RU" - the page is translated into Russian by NuTranslate;
 *    green "LT"  - the page declared another language, NuTranslate fixed it;
 *    blue "LT"   - the declaration was right, NuTranslate only gave Chrome's
 *                  language model a hint.
 */
'use strict';

importScripts('shared/settings.js', 'translate/cloud.js');

const Settings = self.NuTranslateSettings;
const Cloud = self.NuTranslateCloud;

const SCRIPT_ID = 'nutranslate-main';
const MATCHES = ['http://*/*', 'https://*/*', 'file:///*'];
const CONTENT_FILES = [
  'src/shared/settings.js',
  'src/content/core.js',
  'src/content/dom.js',
  'src/content/markup.js',
  'src/content/segments.js',
  'src/content/ondevice.js',
  'src/content/translator.js',
  'src/content/main.js',
];
const FLAG_FILES = {
  noSteering: 'src/content/flags/no-steering.js',
  noLangFix: 'src/content/flags/no-langfix.js',
};
const COMMAND = 'toggle-translation';
const COLORS = { translated: '#8430ce', changed: '#1a7f37', steered: '#0b57d0' };
const ignore = () => {};

// Content scripts get their settings from here, without the API key.
chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(ignore);

// ------------------------------------------------------- script registration

let syncChain = Promise.resolve();
const sameList = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

/**
 * Brings the registered content script in line with the settings. The
 * registration persists across browser restarts, and it is only touched when
 * something changed, so tabs restored at start-up never fall into a gap.
 */
async function registerFromSettings() {
  const settings = await Settings.load();
  const [existing] = await chrome.scripting.getRegisteredContentScripts({ ids: [SCRIPT_ID] });
  const flags = [];
  if (!settings.enabled) flags.push(FLAG_FILES.noLangFix);
  if (!settings.steering) flags.push(FLAG_FILES.noSteering);
  const script = {
    id: SCRIPT_ID,
    matches: MATCHES,
    excludeMatches: Settings.excludeMatchesFor(settings.disabledHosts),
    js: flags.concat(CONTENT_FILES),
    runAt: 'document_start',
    allFrames: false,
    persistAcrossSessions: true,
  };
  if (existing && sameList(existing.js, script.js) && sameList(existing.excludeMatches, script.excludeMatches) &&
      sameList(existing.matches, script.matches)) {
    return;
  }
  try {
    if (existing) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  } catch (e) {
    // A pattern Chrome does not accept must not leave the extension switched off.
    console.warn('NuTranslate: registering with site exclusions failed, registering without them', e);
    const fallback = Object.assign({}, script, { excludeMatches: [] });
    if (existing) await chrome.scripting.updateContentScripts([fallback]);
    else await chrome.scripting.registerContentScripts([fallback]);
  }
}

/** Serialized, so that quick settings changes cannot interleave. */
function syncRegistration() {
  syncChain = syncChain.then(registerFromSettings, registerFromSettings);
  return syncChain;
}

// Settings and tab modes are kept in memory as well: a page asks for them at
// document_start, and the answer should arrive before the page is parsed.
let settingsCache = null;

async function loadSettings() {
  if (!settingsCache) settingsCache = await Settings.load();
  return settingsCache;
}

chrome.runtime.onInstalled.addListener(() => syncRegistration());
chrome.runtime.onStartup.addListener(() => syncRegistration());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[Settings.KEY]) {
    settingsCache = Settings.normalize(changes[Settings.KEY].newValue);
    syncRegistration();
  }
});

// ------------------------------------------------------------ tab modes

let modesCache = null;

async function getTabModes() {
  if (!modesCache) {
    const stored = await chrome.storage.session.get('tabModes');
    modesCache = stored.tabModes || {};
  }
  return modesCache;
}

async function setTabMode(tabId, mode) {
  const modes = await getTabModes();
  if (mode) modes[tabId] = mode;
  else delete modes[tabId];
  await chrome.storage.session.set({ tabModes: modes });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  setTabMode(tabId, null).catch(ignore);
});

async function shortcut() {
  try {
    const commands = await chrome.commands.getAll();
    const command = commands.find((c) => c.name === COMMAND);
    return command && command.shortcut ? command.shortcut : '';
  } catch (e) {
    return '';
  }
}

/** Asks the page to switch translation on or off and remembers the choice for the tab. */
async function toggleTab(tabId) {
  let result;
  try {
    result = await chrome.tabs.sendMessage(tabId, { type: 'nt:toggle' }, { frameId: 0 });
  } catch (e) {
    return { ok: false, error: 'no-content-script' };
  }
  if (!result) return { ok: false, error: 'no-content-script' };
  await setTabMode(tabId, result.active ? 'on' : 'off');
  return { ok: true, status: result };
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== COMMAND) return;
  const run = async () => {
    const target = tab && tab.id !== undefined ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!target) return;
    const result = await toggleTab(target.id);
    if (!result.ok) {
      // Nothing to translate here (a browser page, the Web Store, a site that is turned off).
      chrome.action.setBadgeText({ tabId: target.id, text: '×' }).catch(ignore);
      setTimeout(() => chrome.action.setBadgeText({ tabId: target.id, text: '' }).catch(ignore), 1500);
    }
  };
  run().catch(ignore);
});

// ------------------------------------------------------------ translation

const cache = new Map();
const CACHE_LIMIT = 5000;

function cacheGet(key) {
  const value = cache.get(key);
  if (value !== undefined) {
    cache.delete(key);
    cache.set(key, value);
  }
  return value;
}

function cacheSet(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

async function addUsage(chars) {
  if (!chars) return;
  const month = currentMonth();
  const { usage } = await chrome.storage.local.get('usage');
  const next = usage && usage.month === month ? { month, chars: usage.chars + chars } : { month, chars };
  await chrome.storage.local.set({ usage: next });
}

async function translateWithCloud({ items, sl, tl }) {
  const settings = await loadSettings();
  if (!settings.cloudApiKey) return { ok: false, code: 'no-key', error: 'No Google Cloud API key' };
  if (!Array.isArray(items) || !items.every((i) => typeof i === 'string')) return { ok: false, error: 'bad request' };
  const out = new Array(items.length);
  const missing = [];
  items.forEach((item, i) => {
    const hit = cacheGet(`${sl}|${tl}|${item}`);
    if (hit !== undefined) out[i] = hit;
    else missing.push(i);
  });
  if (missing.length) {
    try {
      const texts = missing.map((i) => items[i]);
      const result = await Cloud.translate(texts, sl, tl, settings.cloudApiKey, { endpoint: settings.cloudEndpoint });
      result.forEach((value, j) => {
        const i = missing[j];
        out[i] = value;
        if (typeof value === 'string') cacheSet(`${sl}|${tl}|${items[i]}`, value);
      });
      await addUsage(texts.reduce((n, t) => n + t.length, 0));
    } catch (e) {
      return { ok: false, code: e.code || 'error', error: e.message || String(e) };
    }
  }
  return { ok: true, translations: out };
}

// ----------------------------------------------------------------- badge

function languageName(code) {
  if (!code) return '';
  try {
    const locale = (chrome.i18n.getMessage('messagesLocale') || chrome.i18n.getUILanguage()).replace('_', '-');
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) || code;
  } catch (e) {
    return code;
  }
}

function badgeFor(message, keys) {
  const tr = message.translation;
  if (tr && tr.active) {
    const title = chrome.i18n.getMessage('badgeTitleTranslated', [languageName(tr.source === 'auto' ? '' : tr.source) || '?', languageName(tr.target)]) +
      (keys ? ' ' + chrome.i18n.getMessage('badgeTitleShortcut', [keys]) : '');
    return { text: String(tr.target || '').split('-')[0].toUpperCase().slice(0, 3), color: COLORS.translated, title };
  }
  const name = languageName(message.lang);
  if (message.status === 'changed' && message.lang) {
    const declared = message.declared ? message.declared : chrome.i18n.getMessage('declaredNone');
    return { text: message.lang.slice(0, 3).toUpperCase(), color: COLORS.changed, title: chrome.i18n.getMessage('badgeTitleChanged', [name, declared]) };
  }
  if (message.steered && message.lang) {
    return { text: message.lang.slice(0, 3).toUpperCase(), color: COLORS.steered, title: chrome.i18n.getMessage('badgeTitleSteered', [name]) };
  }
  return { text: '', color: null, title: chrome.i18n.getMessage('extName') };
}

async function updateBadge(tabId, message) {
  const badge = badgeFor(message, await shortcut());
  await chrome.action.setBadgeText({ tabId, text: badge.text }).catch(ignore);
  if (badge.color) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: badge.color }).catch(ignore);
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(ignore);
  }
  await chrome.action.setTitle({ tabId, title: badge.title }).catch(ignore);
}

// --------------------------------------------------------------- messages

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;
  const fromTopFrame = sender.tab && sender.frameId === 0;

  if (message.type === 'nt:hello' && fromTopFrame) {
    (async () => {
      const [settings, modes, keys] = await Promise.all([loadSettings(), getTabModes(), shortcut()]);
      sendResponse({ settings: Settings.publicSettings(settings), tabMode: modes[sender.tab.id] || null, shortcut: keys });
    })().catch(() => sendResponse(null));
    return true;
  }

  if (message.type === 'nt:translate' && sender.tab) {
    translateWithCloud(message).then(sendResponse, (e) => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (message.type === 'nt:status' && fromTopFrame) {
    updateBadge(sender.tab.id, message).catch(ignore);
    return false;
  }

  // From the popup and the options page.
  if (message.type === 'nt:toggleTab' && !sender.tab) {
    toggleTab(message.tabId).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }

  if (message.type === 'nt:testKey' && !sender.tab) {
    translateWithCloud({ items: ['Labas rytas'], sl: 'lt', tl: message.target || 'en' }).then(sendResponse);
    return true;
  }

  return false;
});

// Hooks for the end-to-end tests.
self.nuTranslateSync = syncRegistration;
self.nuTranslateToggleTab = toggleTab;
