'use strict';

/**
 * Turn a sentence into radar parameters.
 *
 * Deliberately rule-based: no model call, no key, no latency, and the mapping is
 * reviewable. Every recognised signal is reported back so the user can see what
 * the system understood instead of guessing.
 */

const PERSONA_RULES = [
  {
    id: 'academic-researcher',
    re: /论文|研究|学术|科研|实验|paper|research|arxiv|benchmark|study/i
  },
  {
    id: 'technical-builder',
    re: /教程|源码|代码|工程|实现|部署|踩坑|tutorial|code|engineering|implementation|how-?to/i
  },
  {
    id: 'startup-watcher',
    re: /创业|融资|投资|赛道|估值|初创|funding|startup|venture|seed/i
  },
  {
    id: 'industry-practitioner',
    re: /产品|商业|落地|行业|案例|市场|product|industry|business|launch|release/i
  }
];

const CATEGORY_RULES = [
  { category: 'research', re: /论文|研究|学术|科研|paper|research|arxiv|benchmark/i },
  { category: 'startup', re: /创业|融资|投资|funding|startup|venture/i },
  { category: 'technical', re: /教程|源码|代码|工程|tutorial|code|engineering/i },
  { category: 'application', re: /落地|案例|应用|商用|case|deploy/i },
  { category: 'tech', re: /模型|产品|发布|大模型|model|product|release/i }
];

const LANGUAGE_RULES = [
  { language: 'zh-CN', re: /中文|汉语|国产|国内|chinese/i },
  { language: 'en', re: /英文|英语|外文|english/i }
];

const RANGE_RULES = [
  { days: 1, re: /今天|今日|当天|today/i },
  { days: 2, re: /昨天|昨日|yesterday/i },
  { days: 3, re: /三天|3\s*天|近三天|最近几天|last\s*3\s*days/i },
  { days: 7, re: /本周|这周|一周|7\s*天|七天|week|weekly/i },
  { days: 30, re: /本月|这个月|一个月|30\s*天|month|monthly/i }
];

const QUALITY_RE = /重要|高质量|核心|重磅|值得看|精选|important|best|top\s*quality/i;
const DEFAULT_LIMIT = 8;

function parseIntent(input) {
  const text = String(input || '').trim();
  const explanation = [];

  if (text === '') {
    return {
      profile: { limit: DEFAULT_LIMIT },
      explanation: ['没有收到描述，先给你最新的几条。']
    };
  }

  const profile = { limit: DEFAULT_LIMIT };

  /* ------------------------------ persona ------------------------------ */
  const persona = pickPersona(text);
  if (persona) {
    profile.persona = persona.id;
    explanation.push(`视角 → ${persona.name || persona.id}`);
  }

  /* ----------------------------- categories ---------------------------- */
  if (!persona) {
    const categories = CATEGORY_RULES.filter((rule) => rule.re.test(text)).map((rule) => rule.category);
    if (categories.length > 0) {
      profile.categories = [...new Set(categories)];
      explanation.push(`分类 → ${profile.categories.join(' / ')}`);
    }
  }

  /* ------------------------------ language ----------------------------- */
  for (const rule of LANGUAGE_RULES) {
    if (rule.re.test(text)) {
      profile.language = rule.language;
      explanation.push(`语言 → ${rule.language}`);
      break;
    }
  }

  /* ------------------------------- 时间范围 ----------------------------- */
  for (const rule of RANGE_RULES) {
    if (rule.re.test(text)) {
      profile.sinceDays = rule.days;
      explanation.push(`时间 → 最近 ${rule.days} 天`);
      break;
    }
  }
  if (profile.sinceDays === undefined && /最近|latest|recent|new/i.test(text)) {
    profile.sinceDays = 7;
    explanation.push('时间 → 最近 7 天');
  }

  /* -------------------------------- 条数 ------------------------------- */
  const counted = text.match(/(\d+)\s*(?:条|个|篇|则|items?|articles?|results?)/i);
  const ranked = text.match(/(?:top|前)\s*(\d+)/i);
  const amount = Number(counted?.[1] || ranked?.[1]);

  if (Number.isFinite(amount) && amount > 0) {
    profile.limit = Math.min(amount, 50);
    explanation.push(`条数 → ${profile.limit}`);
  }

  /* ------------------------------- 质量门槛 ----------------------------- */
  if (QUALITY_RE.test(text)) {
    profile.minRelevance = 0.6;
    explanation.push('质量 → 相关性 ≥ 60%');
  }

  /* --------------------------- 显式引用的关键词 -------------------------- */
  const quoted = [...text.matchAll(/[「"“]([^」"”]{2,20})[」"”]/g)].map((match) => match[1].trim());
  if (quoted.length > 0) {
    profile.keywords = quoted;
    explanation.push(`关键词 → ${quoted.join(' / ')}`);
  }

  if (explanation.length === 0) {
    explanation.push('没识别到具体偏好，先按时间给你最新的几条。');
  }

  return { profile, explanation };
}

function pickPersona(text) {
  const lowered = text.toLowerCase();

  // 1) 用户直接点名
  for (const rule of PERSONA_RULES) {
    if (lowered.includes(rule.id)) {
      return { id: rule.id };
    }
  }

  // 2) 按命中强度打分，避免一句话里多个词平票时取第一个
  let best = null;
  for (const rule of PERSONA_RULES) {
    const matches = text.match(new RegExp(rule.re.source, `${rule.re.flags}g`));
    const score = matches ? matches.length : 0;
    if (score > 0 && (!best || score > best.score)) {
      best = { id: rule.id, score };
    }
  }

  return best;
}

module.exports = { parseIntent, DEFAULT_LIMIT };
