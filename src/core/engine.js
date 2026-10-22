'use strict';

const fs = require('fs').promises;
const path = require('path');
const logger = require('../utils/logger');

const AI_KEYWORDS = [
  'ai', 'artificial intelligence', 'machine learning', 'deep learning',
  'neural', 'llm', 'transformer', 'gpt', 'diffusion', 'nlp',
  'computer vision', 'reinforcement learning', '人工智能', '机器学习',
  '深度学习', '大模型', '神经网络', '算法'
];

const FETCH_TIMEOUT_MS = 5000;

class NewsEngine {
  constructor(config = {}) {
    this.rootDir = config.rootDir || process.cwd();
    this.sourcesFile = path.resolve(this.rootDir, config.sourcesFile || 'data/sources-config.json');
    this.maxArticles = config.maxArticles ?? 100;
    this.cacheTimeout = config.cacheTimeout ?? 5 * 60 * 1000;
    this.sources = [];
    this.cache = new Map();
  }

  async initialize() {
    this.sources = await this.loadSources();
    logger.info('NewsEngine ready', {
      sources: this.sources.length,
      config: path.relative(this.rootDir, this.sourcesFile)
    });
    return this;
  }

  async loadSources() {
    try {
      const raw = await fs.readFile(this.sourcesFile, 'utf8');
      const parsed = JSON.parse(raw);
      const list = Array.isArray(parsed) ? parsed : parsed.sources;

      if (!Array.isArray(list)) {
        throw new Error('sources-config.json must contain a "sources" array');
      }

      return list
        .filter((source) => source && source.enabled !== false && source.url)
        .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99));
    } catch (error) {
      logger.warn('Could not load sources config, starting with no sources', {
        error: error.message
      });
      return [];
    }
  }

  /**
   * Fetch every enabled source, de-duplicate, score and sort.
   * Individual source failures are logged and skipped.
   */
  async fetchNews(userProfile = null) {
    const cacheKey = JSON.stringify(userProfile || {});
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      logger.debug('Cache hit', { cacheKey });
      return cached;
    }

    const batches = await Promise.all(
      this.sources.map(async (source) => {
        try {
          const articles = await this.fetchFromSource(source);
          logger.info('Source fetched', { source: source.name, count: articles.length });
          return articles;
        } catch (error) {
          logger.warn('Source failed', { source: source.name, error: error.message });
          return [];
        }
      })
    );

    const articles = this.dedupe(batches.flat())
      .map((article) => ({ ...article, relevance: this.scoreRelevance(article) }))
      .sort((a, b) => {
        const byDate = toTimestamp(b.publishedAt) - toTimestamp(a.publishedAt);
        return byDate !== 0 ? byDate : b.relevance - a.relevance;
      })
      .slice(0, this.maxArticles);

    this.setCache(cacheKey, articles);
    logger.info('News fetched', { total: articles.length, sources: this.sources.length });
    return articles;
  }

  async fetchFromSource(source) {
    if (/^https?:\/\//i.test(source.url)) {
      return this.fetchRemote(source);
    }
    return this.fetchLocal(source);
  }

  async fetchLocal(source) {
    const filePath = path.resolve(this.rootDir, source.url);
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw);
    const items = Array.isArray(data) ? data : data.articles || data.items || [];
    return items.map((item) => this.normalize(item, source));
  }

  async fetchRemote(source) {
    const response = await fetch(source.url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { 'user-agent': 'smart-ai-radar/1.0 (+https://github.com/stonearro/smart-ai-radar)' }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${source.url}`);
    }

    const body = await response.text();
    const type = (source.type || '').toLowerCase();

    if (type === 'json' || body.trim().startsWith('{') || body.trim().startsWith('[')) {
      const data = JSON.parse(body);
      const items = Array.isArray(data) ? data : data.articles || data.items || [];
      return items.map((item) => this.normalize(item, source));
    }

    return parseFeed(body).map((item) => this.normalize(item, source));
  }

  normalize(item, source) {
    const title = cleanText(item.title);
    return {
      id: item.id || item.guid || hashId(`${source.name}:${title}`),
      title,
      summary: cleanText(item.summary || item.description || ''),
      content: cleanText(item.content || item['content:encoded'] || ''),
      url: item.url || item.link || '',
      publishedAt: resolvePublishedAt(item),
      language: item.language || source.language || 'zh-CN',
      category: item.category || source.category || 'general',
      tags: Array.isArray(item.tags) ? item.tags : item.category ? [item.category] : [],
      author: cleanText(item.author || ''),
      source: source.name,
      sourcePriority: source.priority ?? 99
    };
  }

  dedupe(articles) {
    const seen = new Set();
    const unique = [];
    for (const article of articles) {
      if (!article.title) continue;
      const key = article.url ? article.url.toLowerCase() : article.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(article);
    }
    return unique;
  }

  scoreRelevance(article) {
    let score = 0.4;

    const haystack = `${article.title || ''} ${article.summary || ''}`.toLowerCase();
    const matches = AI_KEYWORDS.filter((keyword) => haystack.includes(keyword)).length;
    if (matches > 0) score += Math.min(matches * 0.12, 0.36);

    const ageHours = (Date.now() - toTimestamp(article.publishedAt)) / 36e5;
    if (Number.isFinite(ageHours) && ageHours >= 0) {
      if (ageHours < 24) score += 0.2;
      else if (ageHours < 72) score += 0.1;
    }

    if (article.url) score += 0.04;

    return Math.min(Number(score.toFixed(3)), 1);
  }

  /**
   * Apply a user profile on top of an already fetched list.
   */
  filterNews(articles, userProfile = {}) {
    let result = [...articles];

    if (userProfile.language) {
      result = result.filter((article) => article.language === userProfile.language);
    }

    if (Array.isArray(userProfile.categories) && userProfile.categories.length > 0) {
      result = result.filter((article) => userProfile.categories.includes(article.category));
    }

    if (Array.isArray(userProfile.tags) && userProfile.tags.length > 0) {
      const wanted = userProfile.tags.map((tag) => String(tag).toLowerCase());
      result = result.filter((article) =>
        article.tags.some((tag) => wanted.includes(String(tag).toLowerCase()))
      );
    }

    if (typeof userProfile.minRelevance === 'number') {
      result = result.filter((article) => article.relevance >= userProfile.minRelevance);
    }

    if (typeof userProfile.sinceDays === 'number' && userProfile.sinceDays > 0) {
      const cutoff = Date.now() - userProfile.sinceDays * 24 * 60 * 60 * 1000;
      result = result.filter((article) => {
        const time = new Date(article.publishedAt || 0).getTime();
        return Number.isFinite(time) && time >= cutoff;
      });
    }

    if (userProfile.persona) {
      result = result.filter((article) => this.matchesPersona(article, userProfile.persona));
    }

    if (Array.isArray(userProfile.keywords) && userProfile.keywords.length > 0) {
      const terms = userProfile.keywords.map((term) => String(term).toLowerCase());
      result = result.filter((article) => {
        const haystack = `${article.title} ${article.summary} ${article.content}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      });
    }

    return result;
  }

  /**
   * persona may be a persona id/name (string) or a persona object with a
   * `filter` block: { categories: [], tags: [], keywords: [] }.
   */
  matchesPersona(article, persona) {
    if (!persona) return true;

    if (typeof persona === 'object') {
      const { categories = [], tags = [], keywords = [] } = persona.filter || {};
      const signals = [];

      if (categories.length > 0) {
        signals.push(categories.includes(article.category));
      }

      if (tags.length > 0) {
        const wanted = tags.map((tag) => String(tag).toLowerCase());
        signals.push(article.tags.some((tag) => wanted.includes(String(tag).toLowerCase())));
      }

      if (keywords.length > 0) {
        const haystack = `${article.title} ${article.summary} ${article.content}`.toLowerCase();
        signals.push(keywords.some((keyword) => haystack.includes(String(keyword).toLowerCase())));
      }

      // No filter block means the persona does not narrow anything.
      return signals.length === 0 ? true : signals.some(Boolean);
    }

    const id = String(persona).toLowerCase();

    if (id === 'academic' || id === 'academic-researcher') {
      return (
        article.category === 'research' ||
        article.tags.some((tag) => ['paper', 'research', 'study'].includes(String(tag).toLowerCase())) ||
        /研究|论文|paper|study|benchmark/i.test(`${article.title} ${article.summary}`)
      );
    }

    if (id === 'industry' || id === 'industry-practitioner') {
      return (
        article.category === 'application' ||
        article.tags.some((tag) => ['product', 'launch', 'business'].includes(String(tag).toLowerCase())) ||
        /发布|上线|商业化|launch|release|product/i.test(`${article.title} ${article.summary}`)
      );
    }

    if (id === 'startup') {
      return (
        article.category === 'startup' ||
        article.tags.some((tag) => ['funding', 'venture'].includes(String(tag).toLowerCase())) ||
        /融资|创业|startup|funding|venture/i.test(`${article.title} ${article.summary}`)
      );
    }

    if (id === 'technical') {
      return (
        article.category === 'technical' ||
        article.tags.some((tag) => ['tutorial', 'code'].includes(String(tag).toLowerCase())) ||
        /教程|实现|源码|tutorial|how-to|implementation/i.test(`${article.title} ${article.summary}`)
      );
    }

    return true;
  }

  getFromCache(key) {
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.timestamp < this.cacheTimeout) {
      return entry.data;
    }
    this.cache.delete(key);
    return null;
  }

  setCache(key, data) {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  clearCache() {
    this.cache.clear();
  }
}

/* ------------------------------ helpers ------------------------------ */

function toTimestamp(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

/**
 * Sample data ships with a fixed snapshot date, which would fall outside any
 * "最近一周" style filter a few weeks later. `publishedAtOffsetDays` lets a
 * fixture stay relative to load time; real feeds always carry a date.
 */
function resolvePublishedAt(item) {
  if (item.publishedAt || item.pubDate || item.published || item.date) {
    return item.publishedAt || item.pubDate || item.published || item.date;
  }

  if (typeof item.publishedAtOffsetDays === 'number') {
    return new Date(Date.now() - item.publishedAtOffsetDays * 864e5).toISOString();
  }

  return null;
}

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return decodeEntities(
    String(value)
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
  ).trim();
}

const NAMED_ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”'
};

/**
 * Decode the entities that turn up in real feeds, including numeric ones
 * such as &#8217; and &#x2019;.
 */
function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    if (entity[0] === '#') {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const code = parseInt(isHex ? entity.slice(2) : entity.slice(1), isHex ? 16 : 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : match;
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

function hashId(input) {
  let hash = 0;
  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) | 0;
  }
  return `a${(hash >>> 0).toString(36)}`;
}

/**
 * Tiny RSS 2.0 / Atom reader. Intentionally minimal: it extracts the fields a
 * radar needs and tolerates the usual real-world feed noise.
 */
function parseFeed(xml) {
  const items = [];

  const rssItems = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  const atomEntries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  const blocks = rssItems.length > 0 ? rssItems : atomEntries;

  for (const block of blocks) {
    const title = tag(block, 'title');
    const link =
      tag(block, 'link') ||
      (block.match(/<link[^>]*href="([^"]+)"/i) || [])[1] ||
      '';

    items.push({
      title,
      link,
      guid: tag(block, 'guid') || tag(block, 'id'),
      summary: tag(block, 'description') || tag(block, 'summary'),
      content: tag(block, 'content:encoded') || tag(block, 'content'),
      pubDate: tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated'),
      author: tag(block, 'author') || tag(block, 'dc:creator')
    });
  }

  return items.filter((item) => item.title);
}

function tag(block, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const match = block.match(pattern);
  return match ? cleanText(match[1]) : '';
}

module.exports = { NewsEngine, parseFeed, cleanText };
