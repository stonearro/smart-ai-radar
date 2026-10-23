'use strict';

/**
 * 任意关键词检索。
 *
 * 规则表只认识有限的词，用户随口说的词是无限的。做法是：
 *   1. 把句子里剩下的自由文本切成候选词（中文 n-gram，英文按词）
 *   2. 和语料取交集 —— 只留下真实出现过的词，避免「的消」「息资」这类噪音
 *   3. 再按 idf 丢掉「到处都是」的词（比如整库都有的 ai），剩下的才当约束
 *
 * 如果候选词一个都没在语料里出现，说明确实没有这方面内容，如实返回 0，
 * 而不是悄悄退回「最新几条」。
 */

const MIN_CJK = 2;
const MAX_CJK = 8;
const UBIQUITY_LIMIT = 0.4; // 出现在超过 40% 文章里的词不算有效约束

const SPLIT_RE = /[\s,，、;；:：!?！？()（）[\]【】{}<>"'“”‘’/\\|]+/;
const ENGLISH_RE = /^[a-z0-9][a-z0-9.+#_-]*$/i;

/** 把一段自由文本切成候选词。 */
function candidateTerms(text) {
  const terms = new Set();

  for (const chunk of String(text || '').split(SPLIT_RE)) {
    const piece = chunk.trim();
    if (piece === '') continue;

    if (ENGLISH_RE.test(piece)) {
      if (piece.length >= 2) terms.add(piece.toLowerCase());
      continue;
    }

    const limit = Math.min(piece.length, MAX_CJK);
    for (let size = MIN_CJK; size <= limit; size += 1) {
      for (let start = 0; start + size <= piece.length; start += 1) {
        terms.add(piece.slice(start, start + size));
      }
    }
  }

  return [...terms];
}

/**
 * 分析自由文本在语料里的可用性。
 * 返回 { candidates, existing, terms }：
 *   candidates - 切出来的候选词数量
 *   existing   - 语料里出现过的词
 *   terms      - 去掉过于普遍的词之后，真正当约束用的词
 */
function analyzeTerms(articles, text) {
  const candidates = candidateTerms(text);
  if (candidates.length === 0) {
    return { candidates: 0, existing: [], terms: [] };
  }

  const haystacks = articles.map(searchableText);
  const existing = candidates.filter((term) => haystacks.some((hay) => hay.includes(term)));

  // 去掉被更长词包含的碎片：「人民币汇率」在场时不必再留「人民币」「民币」
  const longest = [...existing].sort((a, b) => b.length - a.length);
  const pruned = longest.filter(
    (term) => !longest.some((other) => other !== term && other.includes(term))
  );

  const total = articles.length || 1;
  const terms = pruned.filter((term) => {
    const hits = haystacks.reduce((count, hay) => (hay.includes(term) ? count + 1 : count), 0);
    return hits / total <= UBIQUITY_LIMIT;
  });

  return { candidates: candidates.length, existing, terms };
}

/**
 * 按词打分检索。标题 > 标签 > 摘要 > 正文，长词权重更高（更具体）。
 */
function searchArticles(articles, terms) {
  if (terms.length === 0) return [];

  const scored = [];

  for (const article of articles) {
    const title = String(article.title || '').toLowerCase();
    const summary = String(article.summary || '').toLowerCase();
    const content = String(article.content || '').toLowerCase();
    const tags = (article.tags || []).map((tag) => String(tag).toLowerCase()).join(' ');

    let score = 0;
    const matched = [];

    for (const term of terms) {
      const weight = Math.min(term.length, 6);
      let hit = 0;

      if (title.includes(term)) hit += 4;
      if (tags.includes(term)) hit += 3;
      if (summary.includes(term)) hit += 2;
      if (hit === 0 && content.includes(term)) hit += 1;

      if (hit > 0) {
        score += hit * weight;
        matched.push(term);
      }
    }

    if (score > 0) scored.push({ article, score, matched });
  }

  if (scored.length === 0) return [];

  const max = Math.max(...scored.map((entry) => entry.score));

  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return toTime(b.article.publishedAt) - toTime(a.article.publishedAt);
    })
    .map((entry) => ({
      ...entry.article,
      relevance: Number((0.35 + (entry.score / max) * 0.6).toFixed(3)),
      matchedTerms: entry.matched
        .sort((a, b) => b.length - a.length || a.localeCompare(b))
        .slice(0, 3)
    }));
}

function searchableText(article) {
  return `${article.title || ''} ${article.summary || ''} ${article.content || ''} ${(article.tags || []).join(' ')}`.toLowerCase();
}

function toTime(value) {
  const time = new Date(value || 0).getTime();
  return Number.isFinite(time) ? time : 0;
}

module.exports = { candidateTerms, analyzeTerms, searchArticles };
