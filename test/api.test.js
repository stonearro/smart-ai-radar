'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.RADAR_SOURCES_FILE = path.join(__dirname, 'fixtures', 'sources.offline.json');
process.env.LOG_LEVEL = 'error';

const { start } = require('../src/index');

let server;
let base;

test.before(async () => {
  server = await start(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  if (server) server.close();
});

const get = async (route) => {
  const response = await fetch(`${base}${route}`);
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, type: response.headers.get('content-type'), text, json };
};

test('GET / describes the service', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.json.name, 'smart-ai-radar');
  assert.deepEqual(res.json.formats, ['html', 'markdown', 'json', 'javascript']);
  assert.ok(res.json.endpoints.news);
});

test('GET /api/health reports loaded sources and personas', async () => {
  const res = await get('/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.json.status, 'healthy');
  assert.equal(res.json.sources, 2, 'offline fixture exposes exactly two sources');
  assert.equal(res.json.personas, 4);
});

test('GET /api/sources lists the configured feeds', async () => {
  const res = await get('/api/sources');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 2);
  assert.ok(res.json.data.every((source) => source.name && source.url));
});

test('GET /api/news returns articles with metadata', async () => {
  const res = await get('/api/news?limit=5');
  assert.equal(res.status, 200);
  assert.equal(res.json.success, true);
  assert.ok(res.json.metadata.available >= 5);
  assert.equal(res.json.metadata.total, 5);
  assert.equal(res.json.data.json.articles.length, 5);

  const [first] = res.json.data.json.articles;
  assert.ok(first.title);
  assert.ok(first.source);
  assert.equal(typeof first.relevance, 'number');
  assert.ok(first.relevance >= 0 && first.relevance <= 1);
});

test('GET /api/news renders html as a raw document', async () => {
  const res = await get('/api/news?formats=html&raw=1&limit=2');
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/html/);
  assert.match(res.text, /^<!DOCTYPE html>/);
  assert.match(res.text, /Smart AI Radar/);
});

test('GET /api/news returns every requested format at once', async () => {
  const res = await get('/api/news?formats=html,markdown,json,javascript&limit=3');
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.metadata.formats, ['html', 'markdown', 'json', 'javascript']);
  assert.match(res.json.data.html, /<!DOCTYPE html>/);
  assert.match(res.json.data.markdown, /^# Smart AI Radar/);
  assert.ok(Array.isArray(res.json.data.json.articles));
  assert.match(res.json.data.javascript, /global\.SmartAIRadar/);
});

test('GET /api/news rejects an unknown format with 400', async () => {
  const res = await get('/api/news?formats=pdf');
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Unsupported format/);
});

test('GET /api/news rejects malformed profile JSON with 400', async () => {
  const res = await get('/api/news?profile=%7Bnot-json');
  assert.equal(res.status, 400);
  assert.match(res.json.error, /valid JSON/);
});

test('a persona narrows the result set', async () => {
  const all = await get('/api/news?limit=50');
  const scoped = await get('/api/news?limit=50&persona=academic-researcher');

  assert.equal(scoped.status, 200);
  assert.ok(scoped.json.metadata.total > 0, 'academic persona still finds something');
  assert.ok(
    scoped.json.metadata.total < all.json.metadata.total,
    'persona filtering must reduce the set'
  );
});

test('every built-in persona id actually filters', async () => {
  const all = await get('/api/news?limit=50');
  const ids = (await get('/api/personas')).json.data.map((persona) => persona.id);

  for (const id of ids) {
    const res = await get(`/api/news?limit=50&persona=${id}`);
    assert.equal(res.status, 200, `${id} should be accepted`);
    assert.equal(res.json.metadata.profile.persona, id, `${id} should be echoed back`);
    assert.ok(
      res.json.metadata.total < all.json.metadata.total,
      `${id} must narrow the set, got ${res.json.metadata.total} of ${all.json.metadata.total}`
    );
  }
});

test('an unknown persona is rejected instead of matching everything', async () => {
  const res = await get('/api/news?persona=not-a-persona');
  assert.equal(res.status, 400);
  assert.match(res.json.error, /Unknown persona/);
  assert.match(res.json.error, /academic-researcher/);
});

test('a language with no local articles yields an empty list', async () => {
  const res = await get('/api/news?language=en');
  assert.equal(res.status, 200);
  assert.equal(res.json.metadata.total, 0);
  assert.equal(res.json.data.json.articles.length, 0);
});

test('category and relevance filters are applied', async () => {
  const res = await get('/api/news?categories=research,startup&minRelevance=0.5&limit=50');
  assert.equal(res.status, 200);
  const categories = res.json.data.json.articles.map((article) => article.category);
  assert.ok(categories.every((category) => ['research', 'startup'].includes(category)));
});

test('GET /api/personas lists built-in personas', async () => {
  const res = await get('/api/personas');
  assert.equal(res.status, 200);
  const ids = res.json.data.map((persona) => persona.id).sort();
  assert.deepEqual(ids, [
    'academic-researcher',
    'industry-practitioner',
    'startup-watcher',
    'technical-builder'
  ]);
  assert.ok(res.json.data.every((persona) => Array.isArray(persona.filter.categories)));
});

test('GET /api/personas/:id returns one persona and 404s otherwise', async () => {
  const found = await get('/api/personas/technical-builder');
  assert.equal(found.status, 200);
  assert.equal(found.json.data.name, '工程实践者');

  const missing = await get('/api/personas/does-not-exist');
  assert.equal(missing.status, 404);
  assert.match(missing.json.error, /not found/);
});

test('GET /api/personas/recommend ranks by profile', async () => {
  const res = await get('/api/personas/recommend?categories=research&language=zh-CN');
  assert.equal(res.status, 200);
  assert.equal(res.json.data[0].id, 'academic-researcher');
  assert.ok(res.json.data[0].matchScore > 0);
});

test('POST /api/export writes real files', async () => {
  const response = await fetch(`${base}/api/export`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ formats: ['markdown'], limit: 2 })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.length, 1);

  const written = body.data[0];
  assert.equal(written.format, 'markdown');
  assert.match(written.file, /^output[\\/].+\.md$/);

  const absolute = path.join(__dirname, '..', written.file);
  assert.ok(fs.existsSync(absolute), `${absolute} should exist`);
  assert.match(fs.readFileSync(absolute, 'utf8'), /^# Smart AI Radar/);

  fs.unlinkSync(absolute);
});

test('unknown routes return a JSON 404', async () => {
  const res = await get('/api/nope');
  assert.equal(res.status, 404);
  assert.equal(res.json.success, false);
  assert.match(res.json.error, /not found/);
});
