'use strict';

const Settings = globalThis.NuTranslateSettings;
const $ = (id) => document.getElementById(id);
const t = (key) => chrome.i18n.getMessage(key) || key;

function localize(root) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
}

function fill(settings) {
  $('enabled').checked = settings.enabled;
  $('steering').checked = settings.steering;
  $('debug').checked = settings.debug;
  $('disabledHosts').value = settings.disabledHosts.join('\n');
  $('steering').disabled = !settings.enabled;
}

async function save() {
  const hosts = $('disabledHosts').value.split(/[\s,]+/).filter(Boolean);
  const next = await Settings.save({
    enabled: $('enabled').checked,
    steering: $('steering').checked,
    debug: $('debug').checked,
    disabledHosts: hosts,
  });
  fill(next);
  $('status').textContent = t('optSaved');
  setTimeout(() => {
    $('status').textContent = '';
  }, 1500);
}

async function main() {
  localize(document);
  fill(await Settings.load());
  $('save').addEventListener('click', save);
  $('enabled').addEventListener('change', () => {
    $('steering').disabled = !$('enabled').checked;
  });
}

main();
