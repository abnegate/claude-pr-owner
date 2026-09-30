import { ValidationError } from './ValidationError.js';

export const FLAGS = ['review', 'comments', 'improvement', 'healing', 'bots'];
export const SEVERITIES = ['critical', 'high', 'medium', 'low'];
export const MODEL = /^[A-Za-z0-9][A-Za-z0-9._-]*(\[[A-Za-z0-9]+\])?$/;
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const KEYS = new Set([...FLAGS, 'severities', 'model', 'effort']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalSeverities(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const levels = new Set(value.split(',').map((level) => level.trim()));
  if (![...levels].every((level) => SEVERITIES.includes(level))) {
    return null;
  }
  return SEVERITIES.filter((level) => levels.has(level)).join(',');
}

function canonicalModel(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const model = value.trim();
  if (model === '') {
    return '';
  }
  return MODEL.test(model) ? model : null;
}

function canonicalEffort(value) {
  if (value === '') {
    return '';
  }
  return EFFORTS.includes(value) ? value : null;
}

export function validate(body) {
  if (!isPlainObject(body)) {
    throw new ValidationError('Settings must be a JSON object.');
  }
  for (const key of Object.keys(body)) {
    if (!KEYS.has(key)) {
      throw new ValidationError(`Unknown setting: ${key}.`);
    }
  }
  const config = {};
  for (const flag of FLAGS) {
    if (!(flag in body)) {
      continue;
    }
    if (typeof body[flag] !== 'boolean') {
      throw new ValidationError(`${flag} must be true or false.`);
    }
    config[flag] = body[flag];
  }
  if ('severities' in body) {
    const severities = canonicalSeverities(body.severities);
    if (severities === null) {
      throw new ValidationError(
        `severities must be a comma-separated list of ${SEVERITIES.join(', ')}.`,
      );
    }
    config.severities = severities;
  }
  if ('model' in body) {
    const model = canonicalModel(body.model);
    if (model === null) {
      throw new ValidationError(
        'model must start with a letter or digit and contain only letters, digits, dots, underscores and hyphens.',
      );
    }
    if (model !== '') {
      config.model = model;
    }
  }
  if ('effort' in body) {
    const effort = canonicalEffort(body.effort);
    if (effort === null) {
      throw new ValidationError(`effort must be one of ${EFFORTS.join(', ')}.`);
    }
    if (effort !== '') {
      config.effort = effort;
    }
  }
  return config;
}

export function parse(value) {
  if (typeof value !== 'string') {
    return null;
  }
  let body;
  try {
    body = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isPlainObject(body)) {
    return null;
  }
  const config = {};
  for (const flag of FLAGS) {
    if (typeof body[flag] === 'boolean') {
      config[flag] = body[flag];
    }
  }
  const severities = canonicalSeverities(body.severities);
  if (severities !== null) {
    config.severities = severities;
  }
  const model = canonicalModel(body.model);
  if (model) {
    config.model = model;
  }
  const effort = canonicalEffort(body.effort);
  if (effort) {
    config.effort = effort;
  }
  return config;
}

export function serialize(config) {
  const ordered = {};
  for (const key of KEYS) {
    if (config[key] !== undefined) {
      ordered[key] = config[key];
    }
  }
  return JSON.stringify(ordered);
}
