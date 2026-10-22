'use strict';

const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const path = require('path');

require('./utils/env').load();

const { NewsEngine } = require('./core/engine');
const { PersonaManager } = require('./core/persona');
const { parseIntent } = require('./core/intent');
const { OutputGenerator, SUPPORTED_FORMATS } = require('./output/generator');
const logger = require('./utils/logger');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname.replace(/[\\/]src$/, '');

const app = express();
let engine;
let personas;
let generator;

app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '1mb' }));

/* --------------------------- profile parsing --------------------------- */

/**
 * Build a user profile from either `?profile={"language":"zh-CN"}` or
 * individual query parameters. Individual parameters win.
 */
function readProfile(query = {}) {
  let profile = {};

  if (query.profile) {
    try {
      const parsed = typeof query.profile === 'string' ? JSON.parse(query.profile) : query.profile;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        profile = { ...parsed };
      }
    } catch {
      throw badRequest('`profile` must be valid JSON');
    }
  }

  const list = (value) =>
    typeof value === 'string'
      ? value.split(',').map((item) => item.trim()).filter(Boolean)
      : Array.isArray(value)
        ? value
        : undefined;

  if (query.language) profile.language = query.language;
  if (query.persona) profile.persona = query.persona;
  if (query.categories) profile.categories = list(query.categories);
  if (query.tags) profile.tags = list(query.tags);
  if (query.keywords) profile.keywords = list(query.keywords);
  if (query.minRelevance !== undefined) profile.minRelevance = Number(query.minRelevance);

  return profile;
}

/**
 * Turn `profile.persona` (an id such as "academic-researcher") into the persona
 * object the engine can actually filter on. Unknown ids are rejected instead of
 * silently matching everything.
 */
function resolvePersona(profile = {}) {
  if (!profile.persona) return profile;

  if (typeof profile.persona === 'object') {
    return profile;
  }

  const persona = personas.getPersona(String(profile.persona));
  if (!persona) {
    const available = personas.listPersonas().map((item) => item.id).join(', ');
    throw badRequest(`Unknown persona "${profile.persona}". Available: ${available}`);
  }

  return { ...profile, persona };
}

function readFormats(query = {}) {
  const raw = query.formats || query.format;
  if (!raw) return ['json'];

  const requested = String(raw)
    .split(',')
    .map((format) => format.trim().toLowerCase())
    .filter(Boolean);

  const invalid = requested.filter((format) => !SUPPORTED_FORMATS.includes(format));
  if (invalid.length > 0) {
    throw badRequest(
      `Unsupported format(s): ${invalid.join(', ')}. Supported: ${SUPPORTED_FORMATS.join(', ')}`
    );
  }

  return [...new Set(requested)];
}

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

/* ------------------------------- routes ------------------------------- */

app.get('/', (req, res) => {
  res.json({
    name: 'smart-ai-radar',
    version: require('../package.json').version,
    description: '按用户画像定制的 AI 资讯雷达',
    endpoints: {
      health: 'GET /api/health',
      news: 'GET /api/news?formats=html,markdown&limit=10&language=zh-CN&categories=tech',
      sources: 'GET /api/sources',
      personas: 'GET /api/personas',
      persona: 'GET /api/personas/:id',
      recommend: 'GET /api/personas/recommend?categories=research&language=zh-CN',
      export: 'POST /api/export { "formats": ["html", "markdown"] }'
    },
    formats: SUPPORTED_FORMATS
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    status: 'healthy',
    uptime: Number(process.uptime().toFixed(3)),
    sources: engine.sources.length,
    personas: personas.listPersonas().length,
    timestamp: new Date().toISOString()
  });
});

app.get('/api/sources', (req, res) => {
  res.json({
    success: true,
    data: engine.sources.map((source) => ({
      name: source.name,
      type: source.type || 'auto',
      url: source.url,
      language: source.language,
      category: source.category,
      priority: source.priority ?? 99
    }))
  });
});

app.get('/api/news', async (req, res, next) => {
  try {
    const profile = resolvePersona(readProfile(req.query));
    const formats = readFormats(req.query);
    const limit = clamp(Number(req.query.limit) || 20, 1, 100);

    const articles = await engine.fetchNews();
    const filtered = engine.filterNews(articles, profile).slice(0, limit);

    const context = {
      title: req.query.title || 'Smart AI Radar',
      persona: profile.persona ? profile.persona.id : null
    };

    const rendered = {};
    for (const format of formats) {
      rendered[format] = generator.render(filtered, format, context);
    }

    if (formats.length === 1 && req.query.raw === '1') {
      return res.type(contentType(formats[0])).send(rendered[formats[0]]);
    }

    // `json` is already a document, so return the object instead of a string.
    const data = { ...rendered };
    if (data.json) data.json = JSON.parse(data.json);

    res.json({
      success: true,
      data,
      metadata: {
        total: filtered.length,
        available: articles.length,
        formats,
        profile: {
          ...profile,
          persona: profile.persona ? profile.persona.id : null
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    next(error);
  }
});

/**
 * 自然语言入口：用一句话描述想看什么，返回解析出的参数 + 渲染结果。
 */
app.post('/api/ask', async (req, res, next) => {
  try {
    const query = String(req.body?.q ?? req.query.q ?? '').trim();
    if (!query) {
      throw badRequest('需要 q：用一句话描述你想看什么，例如「最近一周的 AI 论文，中文的，5 条」');
    }

    const format = String(req.body?.format || req.query.format || 'html').toLowerCase();
    if (!SUPPORTED_FORMATS.includes(format)) {
      throw badRequest(`Unsupported format "${format}". Supported: ${SUPPORTED_FORMATS.join(', ')}`);
    }

    const intent = parseIntent(query);
    const profile = resolvePersona({ ...intent.profile });
    const limit = profile.limit || 8;

    const articles = await engine.fetchNews();
    const filtered = engine.filterNews(articles, profile).slice(0, limit);

    const context = {
      title: query.length > 40 ? `${query.slice(0, 40)}…` : query,
      persona: profile.persona ? profile.persona.id : null
    };
    const content = generator.render(filtered, format, context);

    res.json({
      success: true,
      query,
      understood: intent.explanation,
      profile: {
        ...profile,
        persona: profile.persona ? profile.persona.id : null
      },
      metadata: { total: filtered.length, available: articles.length },
      data: { [format]: format === 'json' ? JSON.parse(content) : content },
      hint:
        filtered.length === 0
          ? '这个组合没找到结果，试试去掉时间限制，或者换成更宽的说法（比如只提「论文」）。'
          : null
    });
  } catch (error) {
    next(error);
  }
});

app.get('/chat', (req, res) => {
  res.sendFile(path.join(ROOT, 'public', 'chat.html'));
});

app.get('/api/personas', (req, res) => {
  const data = req.query.category
    ? personas.getPersonasByCategory(req.query.category)
    : personas.listPersonas();

  res.json({ success: true, data: data.map((persona) => persona.toJSON()) });
});

app.get('/api/personas/recommend', (req, res, next) => {
  try {
    const profile = readProfile(req.query);
    res.json({ success: true, data: personas.recommendPersonas(profile) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/personas/:id', (req, res) => {
  const persona = personas.getPersona(req.params.id);
  if (!persona) {
    return res.status(404).json({ success: false, error: `Persona "${req.params.id}" not found` });
  }
  res.json({ success: true, data: persona.toJSON() });
});

app.post('/api/personas', async (req, res, next) => {
  try {
    const created = await personas.addPersona(req.body || {});
    res.status(201).json({ success: true, data: created.toJSON() });
  } catch (error) {
    next(error);
  }
});

app.put('/api/personas/:id', async (req, res, next) => {
  try {
    const updated = await personas.updatePersona(req.params.id, req.body || {});
    res.json({ success: true, data: updated.toJSON() });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/personas/:id', async (req, res, next) => {
  try {
    const removed = await personas.deletePersona(req.params.id);
    res.json({ success: true, data: { id: removed.id } });
  } catch (error) {
    next(error);
  }
});

app.post('/api/export', async (req, res, next) => {
  try {
    const profile = resolvePersona(req.body?.profile || {});
    const formats = req.body?.formats || ['html', 'markdown', 'json'];
    const limit = clamp(Number(req.body?.limit) || 20, 1, 100);

    const invalid = formats.filter((format) => !SUPPORTED_FORMATS.includes(format));
    if (invalid.length > 0) {
      throw badRequest(`Unsupported format(s): ${invalid.join(', ')}`);
    }

    const articles = engine.filterNews(await engine.fetchNews(), profile).slice(0, limit);
    const context = {
      title: req.body?.title || 'Smart AI Radar',
      persona: profile.persona ? profile.persona.id : null
    };

    const written = [];
    for (const format of formats) {
      written.push(await generator.generate(articles, format, context));
    }

    res.json({
      success: true,
      data: written.map((entry) => ({
        format: entry.format,
        file: path.relative(ROOT, entry.path),
        bytes: Buffer.byteLength(entry.content, 'utf8')
      })),
      metadata: { articles: articles.length, timestamp: new Date().toISOString() }
    });
  } catch (error) {
    next(error);
  }
});

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route ${req.method} ${req.path} not found` });
});

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  const status = error.status || 500;
  if (status >= 500) {
    logger.error('Unhandled error', { error });
  }
  res.status(status).json({ success: false, error: error.message || 'Internal server error' });
});

/* ------------------------------ bootstrap ------------------------------ */

function contentType(format) {
  if (format === 'html') return 'text/html; charset=utf-8';
  if (format === 'markdown') return 'text/markdown; charset=utf-8';
  if (format === 'javascript') return 'application/javascript; charset=utf-8';
  return 'application/json; charset=utf-8';
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function start(port = PORT) {
  engine = await new NewsEngine({
    rootDir: ROOT,
    sourcesFile: process.env.RADAR_SOURCES_FILE || 'data/sources-config.json'
  }).initialize();
  personas = await new PersonaManager({ rootDir: ROOT }).initialize();
  generator = new OutputGenerator({ rootDir: ROOT });

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      logger.info(`smart-ai-radar listening on http://localhost:${server.address().port}`, {
        sources: engine.sources.length,
        personas: personas.listPersonas().length
      });
      resolve(server);
    });
    server.on('error', reject);
  });
}

if (require.main === module) {
  start().catch((error) => {
    logger.error('Failed to start', { error });
    process.exit(1);
  });
}

module.exports = { app, start };
