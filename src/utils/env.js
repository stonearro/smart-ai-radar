'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Load a .env file into process.env without pulling in a dependency.
 * Existing environment variables always win, so shell overrides keep working.
 */
function load(file) {
  const target = path.resolve(file || path.join(process.cwd(), '.env'));

  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch {
    return {}; // no .env is a normal case
  }

  const applied = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;

    const key = trimmed.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(separator + 1).trim();
    if (/^(['"]).*\1$/.test(value)) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied[key] = value;
    }
  }

  return applied;
}

module.exports = { load };
