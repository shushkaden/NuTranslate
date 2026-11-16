/*
 * Shared helpers for the end-to-end runs: starting Chrome for Testing with the
 * unpacked extension, and finding the extension's service worker.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_DIR = path.join(ROOT, 'test', '.cache');
const MODEL_PATH = path.join(CACHE_DIR, 'language_detection_model.tflite');
const MODEL_URL = 'https://raw.githubusercontent.com/chromium/chromium/main/components/test/data/translate/valid_model.tflite';

const argv = new Set(process.argv.slice(2));
const HEADED = argv.has('--headed');

function loadPlaywright() {
  for (const candidate of ['playwright', 'playwright-core', process.env.PLAYWRIGHT_PATH, '/opt/node-tools/node_modules/playwright']) {
    if (!candidate) continue;
    try {
      return require(candidate);
    } catch (e) {
      // try the next one
    }
  }
  console.error('Playwright is not installed. Run: npm i -D playwright');
  process.exit(2);
}

function download(url, file, redirects = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(download(res.headers.location, file, redirects - 1));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }
      const tmp = file + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => {
        fs.renameSync(tmp, file);
        resolve(file);
      }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

async function ensureModel() {
  if (fs.existsSync(MODEL_PATH)) return MODEL_PATH;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  try {
    await download(MODEL_URL, MODEL_PATH);
    return MODEL_PATH;
  } catch (e) {
    console.warn(`Could not download the language model (${e.message}). Model-dependent checks are skipped.`);
    return null;
  }
}

async function waitForFile(file, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (fs.existsSync(file)) {
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('\n')) return text;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome did not start (no DevToolsActivePort)');
}

/**
 * Starts Chrome directly instead of through Playwright's launcher, because
 * Playwright's default flags disable Translate, model downloads and component
 * updates, all of which matter here.
 */

async function launchChrome({ withExtension, modelPath, lang }) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nutranslate-e2e-'));
  const executable = process.env.CHROME_PATH || playwright.chromium.executablePath();
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
    '--password-store=basic',
    '--use-mock-keychain',
    `--lang=${lang || 'en-US'}`,
  ];
  if (!HEADED) args.push('--headless=new');
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  if (modelPath) args.push(`--optimization-guide-model-override=OPTIMIZATION_TARGET_LANGUAGE_DETECTION:${modelPath}`);
  if (withExtension) args.push(`--disable-extensions-except=${ROOT}`, `--load-extension=${ROOT}`);
  args.push('about:blank');

  const proc = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr = (stderr + d).slice(-4000);
  });
  let port;
  try {
    const active = await waitForFile(path.join(userDataDir, 'DevToolsActivePort'), 20000);
    port = Number(active.split('\n')[0]);
  } catch (e) {
    proc.kill('SIGKILL');
    throw new Error(e.message + '\n' + stderr);
  }
  const browser = await playwright.chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  const close = async () => {
    await browser.close().catch(() => {});
    const exited = new Promise((resolve) => proc.once('exit', resolve));
    proc.kill('SIGKILL');
    await Promise.race([exited, new Promise((r) => setTimeout(r, 3000))]);
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (e) {
      // A leftover temp profile is harmless.
    }
  };
  return { browser, context, close };
}

async function extensionWorker(context) {
  const ours = (w) => w.url().startsWith('chrome-extension://') && w.url().endsWith('/src/background.js');
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const worker = context.serviceWorkers().find(ours);
    if (worker) return worker;
    await context.waitForEvent('serviceworker', { timeout: 2000 }).catch(() => {});
  }
  throw new Error('the extension service worker did not start');
}

const playwright = loadPlaywright();

module.exports = { ROOT, argv, playwright, ensureModel, launchChrome, extensionWorker };
