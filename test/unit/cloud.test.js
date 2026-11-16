'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Cloud = require('../../src/translate/cloud.js');

test('language codes for Cloud Translation', () => {
  assert.equal(Cloud.cloudCode('zh'), 'zh-CN');
  assert.equal(Cloud.cloudCode('zh-Hant'), 'zh-TW');
  assert.equal(Cloud.cloudCode('lt'), 'lt');
});

test('requests respect the item and size limits and keep the order', () => {
  const items = Array.from({ length: 300 }, (_, i) => 'x'.repeat(i % 2 ? 10 : 40));
  const chunks = Cloud.chunk(items);
  assert.ok(chunks.every((c) => c.length <= Cloud.MAX_ITEMS));
  assert.deepEqual(chunks.flat(), items.map((_, i) => i));
  const big = Cloud.chunk(['a'.repeat(4000), 'b'.repeat(4000), 'c'.repeat(10)]);
  assert.deepEqual(big, [[0], [1, 2]]);
});

test('the key goes in a header, the source only when known', () => {
  const withSource = Cloud.buildRequest(['<a i=0>Labas</a>'], 'lt', 'ru', 'KEY');
  assert.equal(withSource.url, Cloud.ENDPOINT);
  assert.equal(withSource.init.headers['X-Goog-Api-Key'], 'KEY');
  assert.ok(!withSource.url.includes('KEY'), 'the key is not in the URL');
  assert.deepEqual(JSON.parse(withSource.init.body), { q: ['<a i=0>Labas</a>'], target: 'ru', format: 'html', source: 'lt' });
  const auto = Cloud.buildRequest(['x'], 'auto', 'ru', 'KEY', 'http://127.0.0.1:1/mock');
  assert.equal(auto.url, 'http://127.0.0.1:1/mock');
  assert.equal(JSON.parse(auto.init.body).source, undefined);
});

test('errors carry the message from Google', () => {
  assert.throws(() => Cloud.parseResponse(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }, 1), (e) => e.code === 'bad-key');
  assert.throws(() => Cloud.parseResponse(403, { error: { message: 'Cloud Translation API has not been used in project 1' } }, 1), /has not been used/);
  assert.throws(() => Cloud.parseResponse(200, { data: { translations: [] } }, 1), (e) => e.code === 'bad-response');
});

test('translate splits, sends and reassembles in order', async () => {
  const sent = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return { status: 200, json: async () => ({ data: { translations: body.q.map((q) => ({ translatedText: q.toUpperCase() })) } }) };
  };
  const items = Array.from({ length: 140 }, (_, i) => `labas ${i}`);
  const out = await Cloud.translate(items, 'lt', 'ru', 'KEY', { fetch: fakeFetch });
  assert.equal(sent.length, 2, '128 + 12');
  assert.deepEqual(out, items.map((s) => s.toUpperCase()));
});

test('same source and target languages are not sent at all', async () => {
  let calls = 0;
  const out = await Cloud.translate(['привет'], 'ru', 'ru', 'KEY', { fetch: async () => { calls++; } });
  assert.equal(calls, 0);
  assert.deepEqual(out, ['привет']);
});

test('no key, no request', async () => {
  await assert.rejects(Cloud.translate(['x'], 'lt', 'ru', ''), (e) => e.code === 'no-key');
});
