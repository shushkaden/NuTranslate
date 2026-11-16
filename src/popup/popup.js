'use strict';

const Settings = globalThis.NuTranslateSettings;
const $ = (id) => document.getElementById(id);
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const COMMAND = 'toggle-translation';

// The locale the extension's own messages are shown in, so that language
// names match the rest of the popup.
const uiLanguage = (chrome.i18n.getMessage('messagesLocale') || chrome.i18n.getUILanguage()).replace('_', '-');
let displayNames = null;
try {
  displayNames = new Intl.DisplayNames([uiLanguage], { type: 'language' });
} catch (e) {
  displayNames = null;
}

function languageName(code) {
  if (!code) return t('unknownLanguage');
  try {
    return (displayNames && displayNames.of(code)) || code;
  } catch (e) {
    return code;
  }
}

function baseOf(code) {
  return String(code || '').toLowerCase().split('-')[0];
}

function capitalize(text) {
  return text ? text.charAt(0).toLocaleUpperCase(uiLanguage) + text.slice(1) : text;
}

function localize(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

function joinList(items) {
  if (items.length < 2) return items.join('');
  return items.slice(0, -1).join(', ') + ' ' + t('listAnd') + ' ' + items[items.length - 1];
}

function show(id, visible) {
  $(id).hidden = !visible;
}

// ------------------------------------------------------------ translation

function targetLanguage(settings) {
  return baseOf(settings.targetLang || chrome.i18n.getUILanguage()) || 'en';
}

function engineOf(settings) {
  if (settings.engine === 'cloud' || settings.engine === 'ondevice') return settings.engine;
  return settings.cloudApiKey ? 'cloud' : 'ondevice';
}

async function currentShortcut() {
  try {
    const command = (await chrome.commands.getAll()).find((c) => c.name === COMMAND);
    return command && command.shortcut ? command.shortcut : '';
  } catch (e) {
    return '';
  }
}

function setButton(status, target) {
  const button = $('translateBtn');
  const active = Boolean(status && status.active);
  button.classList.toggle('active', active);
  if (!active) button.textContent = t('popupTranslateTo', [languageName(target)]);
  else button.textContent = status.done ? t('popupShowOriginal') : t('popupTranslating');
}

async function renderTranslateCard(tab, report, settings) {
  const status = report.translation || {};
  const target = status.target || targetLanguage(settings);
  setButton(status, target);
  $('translateBtn').addEventListener('click', async () => {
    $('translateBtn').disabled = true;
    const result = await chrome.runtime.sendMessage({ type: 'nt:toggleTab', tabId: tab.id }).catch(() => null);
    if (result && result.ok) {
      window.close(); // let the user see the page
      return;
    }
    $('translateBtn').disabled = false;
  });

  const shortcut = await currentShortcut();
  $('shortcutText').textContent = shortcut ? t('popupShortcut', [shortcut]) : t('popupNoShortcut');
  $('shortcutLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
  });

  const engine = engineOf(settings);
  if (engine === 'cloud' && !settings.cloudApiKey) $('engineText').textContent = t('popupEngineNoKey');
  else $('engineText').textContent = t('popupVia', [t(engine === 'cloud' ? 'popupEngineCloud' : 'popupEngineOnDevice')]);

  if (status.errors && status.errors.length) {
    $('translateError').textContent = status.errors[status.errors.length - 1];
    show('translateError', true);
  }

  const detected = report.detection && report.detection.confident ? report.detection.lang : null;
  if (detected && baseOf(detected) !== baseOf(target)) {
    const box = $('alwaysToggle');
    $('alwaysText').textContent = t('popupAlwaysTranslate', [languageName(detected)]);
    box.checked = settings.autoLanguages.includes(baseOf(detected));
    box.addEventListener('change', () => Settings.setAutoLanguage(detected, box.checked));
    show('alwaysRow', true);
  }
  show('translateCard', true);
}

// ----------------------------------------------------- language fix report

function describeAction(report) {
  switch (report.status) {
    case 'changed': return t('statusChanged', [report.applied]);
    case 'kept': return t('statusKept');
    case 'uncertain': return t('statusUncertain');
    case 'no-text': return t('statusNoText');
    case 'disabled': return t('statusDisabled');
    case 'off': return t('statusOff');
    case 'error': return t('statusError');
    default: return t('statusWaiting');
  }
}

function describeModel(report) {
  const st = report.steering;
  if (report.status !== 'changed' && report.status !== 'kept') return t('modelNotChecked');
  if (st && st.reason === 'off') return t('modelOff');
  if (!st || !st.checked) return t('modelNotChecked');
  if (st.reason === 'not-needed') return t('modelNotNeeded');
  if (st.reason === 'not-enough-text') return t('modelNotEnoughText');
  if (st.reason === 'partial') return t('modelPartial');
  if (st.reason === 'fixed') {
    const keys = { start: 'sampleStart', middle: 'sampleMiddle', end: 'sampleEnd' };
    const where = (st.before || []).filter((s) => s.bad).map((s) => t(keys[s.name] || s.name));
    return t('modelFixed', [joinList(where)]);
  }
  return t('modelError');
}

function describeDeclared(declared) {
  const code = declared && declared.htmlLang;
  if (!code) return t('declaredNone');
  const name = languageName(code);
  return name && name !== code ? `${code} (${name})` : code;
}

function renderReport(report) {
  const d = report.detection;
  const lang = d && d.lang;
  $('langName').textContent = lang ? capitalize(languageName(lang)) : capitalize(t('unknownLanguage'));
  const percent = d && d.totalChars ? Math.round(d.share * 100) : 0;
  $('langMeta').textContent = percent ? t('shareOfText', [String(percent)]) : '';
  $('shareBar').style.width = percent + '%';
  $('declared').textContent = describeDeclared(report.declared);
  $('action').textContent = describeAction(report);
  $('action').classList.toggle('good', report.status === 'changed');
  $('model').textContent = describeModel(report);
  $('model').classList.toggle('good', Boolean(report.steering && report.steering.reason === 'fixed'));
  $('raw').textContent = JSON.stringify(report, null, 2);
  show('details', true);
  show('report', true);
}

// ----------------------------------------------------------------- shared

function webHost(tab) {
  try {
    const url = new URL(tab.url);
    return /^https?:$/.test(url.protocol) ? url.hostname : null;
  } catch (e) {
    return null;
  }
}

function showSiteToggle(tab, host, settings) {
  const toggle = $('siteToggle');
  toggle.checked = Settings.isEnabledFor(settings, host);
  show('siteRow', true);
  toggle.addEventListener('change', async () => {
    await Settings.setHostEnabled(host, toggle.checked);
    show('reloadRow', true);
  });
  $('reloadBtn').addEventListener('click', () => {
    chrome.tabs.reload(tab.id);
    window.close();
  });
}

async function main() {
  localize(document);
  $('optionsLink').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const settings = await Settings.load();
  let report = null;
  if (tab && tab.id !== undefined) {
    try {
      report = await chrome.tabs.sendMessage(tab.id, { type: 'nt:getReport' }, { frameId: 0 });
    } catch (e) {
      report = null;
    }
  }

  if (report) {
    $('host').textContent = report.host;
    $('host').title = report.url;
    if (report.status === 'waiting') {
      show('waiting', true);
    } else {
      await renderTranslateCard(tab, report, settings);
      renderReport(report);
    }
    if (report.host) showSiteToggle(tab, report.host, settings);
    return;
  }

  // No content script: either NuTranslate is off for this site (then the
  // script is not injected at all), or extensions cannot run here.
  const host = tab ? webHost(tab) : null;
  if (host && !Settings.isEnabledFor(settings, host)) {
    $('host').textContent = host;
    $('disabledText').textContent = t('popupDisabledSite');
    show('disabled', true);
    showSiteToggle(tab, host, settings);
    return;
  }
  show('unavailable', true);
}

main();
