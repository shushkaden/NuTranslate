/*
 * NuTranslate service worker.
 *
 * 1. Registers the content script dynamically. Turning the extension off, or
 *    off for a site, then means the script is not injected at all. Reading
 *    settings from storage inside the page would be asynchronous and could
 *    lose the race against Chrome's language capture on fast pages.
 * 2. Shows on the toolbar icon what the content script did on the current tab:
 *    green badge "LT" - the page declared another language, NuTranslate fixed it;
 *    blue badge "LT"  - the declaration was right, NuTranslate only helped
 *                       Chrome's language model with a hint.
 */
'use strict';

importScripts('shared/settings.js');

const Settings = self.NuTranslateSettings;

const SCRIPT_ID = 'nutranslate-main';
const MATCHES = ['http://*/*', 'https://*/*', 'file:///*'];
const CONTENT_FILES = ['src/shared/settings.js', 'src/content/core.js', 'src/content/dom.js', 'src/content/main.js'];
const NO_STEERING_FLAG = 'src/content/flags/no-steering.js';
const BADGE_COLORS = { changed: '#1a7f37', steered: '#0b57d0' };

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
  if (!settings.enabled) {
    if (existing) await chrome.scripting.unregisterContentScripts({ ids: [SCRIPT_ID] });
    return;
  }
  const script = {
    id: SCRIPT_ID,
    matches: MATCHES,
    excludeMatches: Settings.excludeMatchesFor(settings.disabledHosts),
    js: settings.steering ? CONTENT_FILES : [NO_STEERING_FLAG].concat(CONTENT_FILES),
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
self.nuTranslateSync = syncRegistration; // used by the end-to-end tests

chrome.runtime.onInstalled.addListener(() => syncRegistration());
chrome.runtime.onStartup.addListener(() => syncRegistration());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[Settings.KEY]) syncRegistration();
});

function languageName(code) {
  if (!code) return '';
  try {
    const locale = (chrome.i18n.getMessage('messagesLocale') || chrome.i18n.getUILanguage()).replace('_', '-');
    const names = new Intl.DisplayNames([locale], { type: 'language' });
    return names.of(code) || code;
  } catch (e) {
    return code;
  }
}

function buildTitle(message) {
  const name = languageName(message.lang);
  if (message.status === 'changed') {
    const declared = message.declared ? message.declared : chrome.i18n.getMessage('declaredNone');
    return chrome.i18n.getMessage('badgeTitleChanged', [name, declared]);
  }
  if (message.steered) return chrome.i18n.getMessage('badgeTitleSteered', [name]);
  return chrome.i18n.getMessage('extName');
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== 'nt:status' || !sender.tab || sender.frameId !== 0) return;
  const tabId = sender.tab.id;
  const changed = message.status === 'changed';
  const steered = Boolean(message.steered);
  const text = (changed || steered) && message.lang ? String(message.lang).slice(0, 3).toUpperCase() : '';
  const ignore = () => {};
  chrome.action.setBadgeText({ tabId, text }).catch(ignore);
  if (text) {
    chrome.action.setBadgeBackgroundColor({ tabId, color: changed ? BADGE_COLORS.changed : BADGE_COLORS.steered }).catch(ignore);
    chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' }).catch(ignore);
  }
  chrome.action.setTitle({ tabId, title: buildTitle(message) }).catch(ignore);
});
