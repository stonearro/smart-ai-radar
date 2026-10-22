'use strict';

/**
 * Minimal dependency-free logger.
 * Keeps the same call shape used across the project: logger.info(msg, meta).
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function currentLevel() {
  return LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
}

function emit(level, message, meta) {
  if (LEVELS[level] > currentLevel()) return;

  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`;
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;

  if (meta && Object.keys(meta).length > 0) {
    sink(line, meta);
  } else {
    sink(line);
  }

  if (meta && meta.error instanceof Error) {
    sink(meta.error.stack);
  }
}

module.exports = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta)
};
