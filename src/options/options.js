'use strict';

const Settings = globalThis.NuTranslateSettings;
const $ = (id) => document.getElementById(id);
const t = (key, subs) => chrome.i18n.getMessage(key, subs) || key;
const COMMAND = 'toggle-translation';

// Languages Google Translate and Chrome's offline translator commonly support.
const LANGUAGES = [
  'af', 'am', 'ar', 'az', 'be', 'bg', 'bn', 'bs', 'ca', 'cs', 'cy', 'da', 'de', 'el', 'en', 'eo', 'es', 'et',
  'eu', 'fa', 'fi', 'fil', 'fr', 'ga', 'gl', 'gu', 'he', 'hi', 'hr', 'hu', 'hy', 'id', 'is', 'it', 'ja', 'ka',
  'kk', 'km', 'kn', 'ko', 'ky', 'lo', 'lt', 'lv', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my', 'ne', 'nl', 'no',
  'pa', 'pl', 'pt', 'ro', 'ru', 'si', 'sk', 'sl', 'sq', 'sr', 'sv', 'sw', 'ta', 'te', 'th', 'tr', 'uk', 'ur',
  'uz', 'vi', 'zh-CN', 'zh-TW',
];

const uiLocale = (chrome.i18n.getMessage('messagesLocale') || chrome.i18n.getUILanguage()).replace('_', '-');
let names = null;
try {
  names = new Intl.DisplayNames([uiLocale], { type: 'language' });
} catch (e) {
  names = null;
}

function languageName(code) {
  try {
    const name = names ? names.of(code) : code;
    return name ? name.charAt(0).toLocaleUpperCase(uiLocale) + name.slice(1) : code;
  } catch (e) {
    return code;
  }
}

function localize(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

function fillLanguageSelect(select, includeBrowserDefault) {
  select.textContent = '';
  if (includeBrowserDefault) {
    const browser = chrome.i18n.getUILanguage().split('-')[0];
    select.append(new Option(t('optTargetBrowser', [languageName(browser)]), ''));
  }
  LANGUAGES.map((code) => [code, languageName(code)])
    .sort((a, b) => a[1].localeCompare(b[1], uiLocale))
    .forEach(([code, name]) => select.append(new Option(`${name} (${code})`, code)));
}

let current = Settings.normalize();

function fill(settings) {
  current = settings;
  $('targetLang').value = settings.targetLang;
  for (const radio of document.querySelectorAll('input[name="engine"]')) radio.checked = radio.value === settings.engine;
  $('cloudApiKey').value = settings.cloudApiKey;
  $('autoLanguages').value = settings.autoLanguages.join(', ');
  $('restoreOnSubmit').checked = settings.restoreOnSubmit;
  $('toast').checked = settings.toast;
  $('enabled').checked = settings.enabled;
  $('steering').checked = settings.steering;
  $('steering').disabled = !settings.enabled;
  $('debug').checked = settings.debug;
  $('disabledHosts').value = settings.disabledHosts.join('\n');
}

function readForm() {
  const engine = document.querySelector('input[name="engine"]:checked');
  return {
    targetLang: $('targetLang').value,
    engine: engine ? engine.value : 'auto',
    cloudApiKey: $('cloudApiKey').value,
    autoLanguages: $('autoLanguages').value,
    restoreOnSubmit: $('restoreOnSubmit').checked,
    toast: $('toast').checked,
    enabled: $('enabled').checked,
    steering: $('steering').checked,
    debug: $('debug').checked,
    disabledHosts: $('disabledHosts').value.split(/[\s,]+/).filter(Boolean),
  };
}

let statusTimer = null;
async function save() {
  const next = await Settings.save(readForm());
  current = next;
  $('steering').disabled = !next.enabled;
  $('status').textContent = t('optSaved');
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    $('status').textContent = '';
  }, 1500);
  refreshPackStatus();
  return next;
}

// -------------------------------------------------------------- cloud key

async function testKey() {
  $('keyResult').classList.remove('bad');
  $('keyResult').textContent = '…';
  const settings = await save();
  const target = (settings.targetLang || chrome.i18n.getUILanguage()).split('-')[0] || 'en';
  const result = await chrome.runtime.sendMessage({ type: 'nt:testKey', target }).catch((e) => ({ ok: false, error: String(e) }));
  if (result && result.ok) {
    $('keyResult').textContent = t('optCloudKeyOk', [result.translations[0]]);
  } else {
    $('keyResult').classList.add('bad');
    $('keyResult').textContent = t('optCloudKeyFail', [(result && result.error) || '?']);
  }
  showUsage();
}

async function showUsage() {
  const { usage } = await chrome.storage.local.get('usage');
  const month = new Date().toISOString().slice(0, 7);
  const chars = usage && usage.month === month ? usage.chars : 0;
  $('usage').textContent = t('optUsage', [chars.toLocaleString(uiLocale)]);
}

// ---------------------------------------------------- offline language packs

function packLanguages() {
  const source = $('packFrom').value;
  const target = (current.targetLang || chrome.i18n.getUILanguage()).split('-')[0] || 'en';
  return { sourceLanguage: source === 'zh-CN' ? 'zh' : source === 'zh-TW' ? 'zh-Hant' : source, targetLanguage: target };
}

async function refreshPackStatus() {
  const status = $('packStatus');
  const { targetLanguage } = packLanguages();
  $('packTarget').textContent = '→ ' + languageName(targetLanguage);
  if (typeof Translator === 'undefined') {
    status.textContent = t('optOnDeviceUnsupported');
    $('packDownload').disabled = true;
    return;
  }
  try {
    const availability = await Translator.availability(packLanguages());
    const text = {
      available: t('optOnDeviceAvailable'),
      downloadable: t('optOnDeviceDownloadable'),
      downloading: t('optOnDeviceDownloading', ['…']),
      unavailable: t('optOnDeviceUnavailable'),
    }[availability] || availability;
    status.textContent = text;
    $('packDownload').disabled = availability === 'available' || availability === 'unavailable';
  } catch (e) {
    status.textContent = String(e && e.message ? e.message : e);
  }
}

async function downloadPack() {
  $('packDownload').disabled = true;
  try {
    // A click is the user activation Chrome requires to start a download.
    const translator = await Translator.create(Object.assign(packLanguages(), {
      monitor(m) {
        m.addEventListener('downloadprogress', (e) => {
          $('packStatus').textContent = t('optOnDeviceDownloading', [String(Math.round((e.loaded || 0) * 100))]);
        });
      },
    }));
    if (translator && translator.destroy) translator.destroy();
  } catch (e) {
    $('packStatus').textContent = String(e && e.message ? e.message : e);
  }
  refreshPackStatus();
}

// ------------------------------------------------------------------ main

async function main() {
  localize(document);
  fillLanguageSelect($('targetLang'), true);
  fillLanguageSelect($('packFrom'), false);

  const settings = await Settings.load();
  fill(settings);
  $('packFrom').value = settings.autoLanguages[0] || 'lt';

  const command = (await chrome.commands.getAll()).find((c) => c.name === COMMAND);
  $('shortcut').textContent = command && command.shortcut ? command.shortcut : t('optShortcutNone');
  $('shortcutOpen').addEventListener('click', () => chrome.tabs.create({ url: 'chrome://extensions/shortcuts' }));

  // Switches and choices are saved at once, text fields when they lose focus.
  for (const el of document.querySelectorAll('input[type="checkbox"], input[type="radio"], select:not(#packFrom)')) {
    el.addEventListener('change', save);
  }
  for (const el of document.querySelectorAll('input[type="text"], input[type="password"], textarea')) {
    el.addEventListener('change', save);
  }
  $('save').addEventListener('click', save);
  $('testKey').addEventListener('click', testKey);
  $('packFrom').addEventListener('change', refreshPackStatus);
  $('packDownload').addEventListener('click', downloadPack);

  showUsage();
  refreshPackStatus();
}

main();
