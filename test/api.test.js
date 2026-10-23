'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

process.env.RADAR_SOURCES_FILE = path.join(__dirname, 'fixtures', 'sources.offline.json');
process.env.LOG_LEVEL = 'error';

const { start } = require('../src/index');
const { parseIntent } = require('../src/core/intent');

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
  assert.equal(res.json.sources, 3, 'offline fixture exposes exactly three sources');
  assert.equal(res.json.personas, 4);
});

test('GET /api/sources lists the configured feeds', async () => {
  const res = await get('/api/sources');
  assert.equal(res.status, 200);
  assert.equal(res.json.data.length, 3);
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

/* ------------------------- 自然语言 -> 参数 ------------------------- */

const post = async (route, payload) => {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json };
};

test('parseIntent maps 视角 / 语言 / 时间 / 条数', () => {
  const { profile, explanation } = parseIntent('最近一周的 AI 论文，中文的，5 条');

  assert.equal(profile.persona, 'academic-researcher');
  assert.equal(profile.language, 'zh-CN');
  assert.equal(profile.sinceDays, 7);
  assert.equal(profile.limit, 5);
  assert.equal(explanation.length, 4);
});

test('parseIntent picks up quoted keywords and quality intent', () => {
  const keyword = parseIntent('有没有「vLLM」推理优化的教程？');
  assert.equal(keyword.profile.persona, 'technical-builder');
  assert.deepEqual(keyword.profile.keywords, ['vLLM']);

  const quality = parseIntent('创业公司融资，重要的，3 条');
  assert.equal(quality.profile.persona, 'startup-watcher');
  assert.equal(quality.profile.minRelevance, 0.6);
  assert.equal(quality.profile.limit, 3);
});

test('parseIntent falls back gracefully on vague input', () => {
  const { profile, explanation } = parseIntent('随便看看');
  assert.equal(profile.persona, undefined);
  assert.equal(profile.limit, 8);
  assert.match(explanation[0], /没识别到/);
});

test('POST /api/ask returns parameters plus a rendered result', async () => {
  const res = await post('/api/ask', { q: '最近一周的 AI 论文，中文的，5 条' });

  assert.equal(res.status, 200);
  assert.equal(res.json.profile.persona, 'academic-researcher');
  assert.equal(res.json.profile.language, 'zh-CN');
  assert.ok(res.json.understood.length === 4);
  assert.ok(res.json.metadata.total > 0, '样例数据的时间是相对的，时间筛选应当有结果');
  assert.ok(res.json.metadata.total <= 5);
  assert.match(res.json.data.html, /^<!DOCTYPE html>/);
});

test('POST /api/ask honours the requested format', async () => {
  const res = await post('/api/ask', { q: '教程', format: 'markdown' });
  assert.equal(res.status, 200);
  assert.match(res.json.data.markdown, /^# /);
  assert.equal(res.json.data.html, undefined);
});

test('POST /api/ask validates input', async () => {
  const missing = await post('/api/ask', {});
  assert.equal(missing.status, 400);
  assert.match(missing.json.error, /需要 q/);

  const badFormat = await post('/api/ask', { q: '论文', format: 'pdf' });
  assert.equal(badFormat.status, 400);
  assert.match(badFormat.json.error, /Unsupported format/);
});

test('GET /chat serves the dialog page', async () => {
  const res = await get('/chat');
  assert.equal(res.status, 200);
  assert.match(res.type, /text\/html/);
  assert.match(res.text, /Smart AI Radar/);
  assert.match(res.text, /\/api\/ask/);
});

/* ------------------------- 主题识别与空结果 ------------------------- */

test('parseIntent routes 财经 to the finance category', () => {
  const { profile, explanation } = parseIntent('全球财经资讯');
  assert.deepEqual(profile.categories, ['finance']);
  assert.equal(profile.persona, undefined, '财经是主题不是人格');
  assert.match(explanation[0], /财经/);
});

test('parseIntent lets a specific domain beat a broad word', () => {
  // 「行情」本来会命中财经，但「比特币」更具体，应该只留加密
  const { profile } = parseIntent('比特币行情');
  assert.deepEqual(profile.categories, ['crypto']);
});

test('parseIntent keeps the persona for AI-domain queries', () => {
  const { profile } = parseIntent('最近一周的 AI 论文，中文的，5 条');
  assert.equal(profile.persona, 'academic-researcher');
  assert.equal(profile.categories, undefined);
});

test('POST /api/ask returns finance news for 全球财经资讯', async () => {
  const res = await post('/api/ask', { q: '全球财经资讯', format: 'json' });

  assert.equal(res.status, 200);
  assert.deepEqual(res.json.profile.categories, ['finance']);
  assert.ok(res.json.metadata.total > 0, '财经源应该能给出结果');
  assert.equal(res.json.hint, null);

  for (const article of res.json.data.json.articles) {
    assert.equal(article.category, 'finance', `不该把 ${article.category} 当成财经：${article.title}`);
  }
});

test('POST /api/ask explains an uncovered topic instead of returning noise', async () => {
  const res = await post('/api/ask', { q: '体育新闻', format: 'json' });

  assert.equal(res.status, 200);
  assert.equal(res.json.metadata.total, 0, '没有体育源就不该返回别的内容');
  assert.match(res.json.hint, /没有体育/);
  assert.match(res.json.hint, /已配置的分类/);
});

test('POST /api/ask narrows finance by language', async () => {
  const res = await post('/api/ask', { q: '中文财经资讯，5 条', format: 'json' });

  assert.equal(res.status, 200);
  assert.ok(res.json.metadata.total > 0);
  for (const article of res.json.data.json.articles) {
    assert.equal(article.category, 'finance');
    assert.equal(article.language, 'zh-CN');
  }
});

/* --------------------------- 任意关键词 --------------------------- */

test('任意关键词只要语料里有就能搜到', async () => {
  const expected = [
    ['vLLM', /vLLM/i],
    ['AlphaFold', /AlphaFold/i],
    ['工业质检', /质检/],
    ['美联储', /美联储/]
  ];

  for (const [q, pattern] of expected) {
    const res = await post('/api/ask', { q, format: 'json' });
    assert.equal(res.status, 200, `${q} 应当被接受`);
    assert.ok(res.json.metadata.total > 0, `${q} 应当有结果`);

    const titles = res.json.data.json.articles.map((article) => article.title).join(' ');
    assert.match(titles, pattern, `${q} 的返回里应当真的出现该词`);
  }
});

test('语料里没有的关键词返回空并说明原因', async () => {
  const res = await post('/api/ask', { q: '固态电池', format: 'json' });

  assert.equal(res.status, 200);
  assert.equal(res.json.metadata.total, 0, '不该拿不相关的内容凑数');
  assert.match(res.json.hint, /没有找到包含「固态电池」的资讯/);
});

test('关键词检索的解释里带上真正用到的词', async () => {
  const res = await post('/api/ask', { q: '推理优化', format: 'json' });

  assert.equal(res.status, 200);
  assert.ok(res.json.metadata.total > 0);
  assert.ok(
    res.json.understood.some((line) => line.includes('关键词 → 推理优化')),
    `应当说明用到的关键词，实际：${res.json.understood.join(' | ')}`
  );
});

test('/api/news 也支持 q 全文检索', async () => {
  const res = await get('/api/news?q=vLLM&formats=json');
  assert.equal(res.status, 200);
  assert.equal(res.json.metadata.total, 1);
  assert.match(res.json.data.json.articles[0].title, /vLLM/i);
});

test('q 与分类同时存在时，分类优先且不跨分类兜底', async () => {
  const res = await get('/api/news?q=美联储&categories=research&formats=json');

  assert.equal(res.status, 200);
  assert.equal(res.json.metadata.total, 0, 'research 分类下没有美联储相关内容');
});
