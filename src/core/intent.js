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

/**
 * 主题词 -> 分类。priority 用来处理「一句话命中多个领域」：
 * 只保留优先级最高的一组，避免「比特币行情」同时命中 财经 和 加密 后
 * 用财经新闻冒充加密行情。
 */
const CATEGORY_RULES = [
  {
    category: 'crypto',
    label: '加密',
    priority: 1,
    re: /加密|比特币|以太坊|数字货币|区块链|crypto|bitcoin|ethereum|blockchain/i
  },

  // 明确识别、但通常没有接源的领域：识别出来是为了回答「没有这方面的源」，
  // 而不是静默退回「最新几条」把不相关的内容当成结果。
  { category: 'sports', label: '体育', priority: 1, re: /体育|足球|篮球|奥运|赛事|sports?|football|nba|olympic/i },
  { category: 'entertainment', label: '娱乐', priority: 1, re: /娱乐|明星|影视|综艺|电影|entertainment|celebrity|movie/i },
  { category: 'gaming', label: '游戏', priority: 1, re: /游戏|手游|主机|电竞|gaming|esports/i },
  { category: 'military', label: '军事', priority: 1, re: /军事|国防|武器|military|defense/i },
  { category: 'realestate', label: '房产', priority: 1, re: /房产|楼市|房地产|real\s*estate|housing/i },
  { category: 'health', label: '健康', priority: 1, re: /健康|养生|疾病|医疗|health|wellness|medical/i },

  {
    category: 'finance',
    label: '财经',
    priority: 2,
    re: /财经|金融|股市|股票|债券|基金|银行|利率|汇率|经济|美联储|通胀|行情|大盘|指数|美股|港股|A股|finance|financial|stock|market|economy|bond|fund|bank|fed|inflation/i
  },
  {
    category: 'policy',
    label: '政策',
    priority: 2,
    re: /政策|监管|法案|合规|反垄断|policy|regulation|compliance|antitrust/i
  },

  { category: 'research', label: '研究', priority: 3, re: /论文|研究|学术|科研|paper|research|arxiv|benchmark/i },
  { category: 'startup', label: '创业', priority: 3, re: /创业|融资|投资|funding|startup|venture/i },
  { category: 'technical', label: '工程', priority: 3, re: /教程|源码|代码|工程|tutorial|code|engineering/i },
  { category: 'application', label: '落地', priority: 3, re: /落地|案例|应用|商用|case|deploy/i },
  { category: 'tech', label: '科技', priority: 3, re: /模型|产品|发布|大模型|model|product|release/i }
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

  /*
   * 优先级：点名人格 > 强主题（财经/加密/体育…）> 软性人格 > 弱主题分类。
   * 「全球财经资讯」走强主题，不会被「市场」误判成行业人格；
   * 「最近一周的 AI 论文」仍然走学术人格，因为它本来就有专门的人格。
   */
  const explicit = findExplicitPersona(text);
  const strongTopic = explicit ? null : matchTopic(text, 2);
  const softPersona = explicit || strongTopic ? null : pickPersona(text);
  const weakTopic = explicit || strongTopic || softPersona ? null : matchTopic(text, 3);
  const topic = strongTopic || weakTopic;

  if (explicit) {
    profile.persona = explicit;
    explanation.push(`视角 → ${explicit}`);
  } else if (topic) {
    profile.categories = topic.categories;
    profile.categoryLabels = topic.labels;
    explanation.push(`分类 → ${topic.described}`);
  } else if (softPersona) {
    profile.persona = softPersona.id;
    explanation.push(`视角 → ${softPersona.id}`);
  }

  /* ------------------------------ persona ------------------------------ */
  // 已在上面决定，这里不再重复判断

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

/** 用户直接写人格 id 时，不用猜。 */
function findExplicitPersona(text) {
  const lowered = text.toLowerCase();
  for (const rule of PERSONA_RULES) {
    if (lowered.includes(rule.id)) return rule.id;
  }
  return null;
}

/** 主题词 -> 分类，用来命中除 AI 之外的内容（财经等）。 */
function matchTopic(text, maxPriority = 3) {
  const hits = CATEGORY_RULES.filter((rule) => rule.re.test(text) && rule.priority <= maxPriority);
  if (hits.length === 0) return null;

  // 只留优先级最高的一组，避免宽泛词把专指词吃掉
  const best = Math.min(...hits.map((rule) => rule.priority));
  const matched = hits.filter((rule) => rule.priority === best);

  return {
    categories: [...new Set(matched.map((rule) => rule.category))],
    labels: [...new Set(matched.map((rule) => rule.label))],
    described: matched.map((rule) => `${rule.label}（${rule.category}）`).join(' / ')
  };
}

/** 按命中强度挑人格，避免一句话里多个词平票时永远取第一个。 */
function pickPersona(text) {
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

module.exports = { parseIntent, DEFAULT_LIMIT, CATEGORY_RULES };
