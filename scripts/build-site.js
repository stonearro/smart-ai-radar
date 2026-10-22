#!/usr/bin/env node
'use strict';

/**
 * Build a static snapshot of the radar.
 *
 *   npm run build:site
 *   npm run build:site -- --persona academic-researcher --limit 10 --language zh-CN
 *
 * Writes output/index.html, output/feed.md, output/feed.json and output/widget.js.
 */

const fs = require('fs').promises;
const path = require('path');

const { NewsEngine } = require('../src/core/engine');
const { PersonaManager } = require('../src/core/persona');
const { OutputGenerator } = require('../src/output/generator');
const logger = require('../src/utils/logger');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;

    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Number(args.limit) || 20;
  const language = args.language;

  const engine = await new NewsEngine({ rootDir: ROOT }).initialize();
  const personas = await new PersonaManager({ rootDir: ROOT }).initialize();
  const generator = new OutputGenerator({ rootDir: ROOT });

  let persona = null;
  if (args.persona) {
    persona = personas.getPersona(String(args.persona));
    if (!persona) {
      const available = personas.listPersonas().map((item) => item.id).join(', ');
      throw new Error(`Unknown persona "${args.persona}". Available: ${available}`);
    }
  }

  const profile = {
    persona: persona || undefined,
    language: language || (persona ? persona.language : undefined),
    minRelevance: args.minRelevance ? Number(args.minRelevance) : undefined
  };

  const articles = engine.filterNews(await engine.fetchNews(), profile).slice(0, limit);
  const context = {
    title: persona ? `Smart AI Radar · ${persona.name}` : 'Smart AI Radar',
    subtitle: persona ? persona.description : '为你定制的 AI 资讯雷达',
    persona: persona ? persona.id : null
  };

  const outDir = path.join(ROOT, args.out || 'output');
  await fs.mkdir(outDir, { recursive: true });

  const targets = [
    ['index.html', 'html'],
    ['feed.md', 'markdown'],
    ['feed.json', 'json'],
    ['widget.js', 'javascript']
  ];

  for (const [fileName, format] of targets) {
    const content = generator.render(articles, format, context);
    await fs.writeFile(path.join(outDir, fileName), content, 'utf8');
    logger.info('written', { file: fileName, bytes: Buffer.byteLength(content, 'utf8') });
  }

  logger.info('build:site complete', {
    articles: articles.length,
    persona: context.persona || 'all',
    output: path.relative(ROOT, outDir)
  });
}

main().catch((error) => {
  logger.error('build:site failed', { error });
  process.exitCode = 1;
});
