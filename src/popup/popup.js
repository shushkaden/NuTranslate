'use strict';

const Settings = globalThis.NuTranslateSettings;
const $ = (id) => document.getElementById(id);
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;

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

function describeAction(report) {
  switch (report.status) {
    case 'changed': return t('statusChanged', [report.applied]);
    case 'kept': return t('statusKept');
    case 'uncertain': return t('statusUncertain');
    case 'no-text': return t('statusNoText');
    case 'disabled': return t('statusDisabled');
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

function show(id, visible) {
  $(id).hidden = !visible;
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

  const helped = report.status === 'changed' || (report.steering && report.steering.applied);
  if (helped && lang) {
    $('tip').textContent = t('tipAlwaysTranslate', [languageName(lang)]);
    show('tip', true);
  }

  $('raw').textContent = JSON.stringify(report, null, 2);
  show('details', true);
  show('report', true);
}

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
  toggle.disabled = !settings.enabled;
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
    if (report.status === 'waiting') show('waiting', true);
    else renderReport(report);
    if (report.host) showSiteToggle(tab, report.host, settings);
    return;
  }

  // No content script: either the extension is off for this site (then the
  // script is not injected at all), or extensions cannot run here.
  const host = tab ? webHost(tab) : null;
  if (host && !Settings.isEnabledFor(settings, host)) {
    $('host').textContent = host;
    $('disabledText').textContent = t(settings.enabled ? 'popupDisabledSite' : 'popupDisabledAll');
    show('disabled', true);
    showSiteToggle(tab, host, settings);
    return;
  }
  show('unavailable', true);
}

main();
