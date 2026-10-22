import sodium from 'libsodium-wrappers';
import { ValidationError } from './ValidationError.js';

export const TOKENS = Object.freeze([
  'oauth',
  'push',
  'openai',
  'deepApiKey',
  'deepOpenai',
]);

const MAXIMUM_BYTES = 48 * 1024;
const ANTHROPIC_PREFIX = 'sk-ant-';
const ANTHROPIC_API_KEY_PREFIX = 'sk-ant-api';
const OPENAI_PREFIX = 'sk-';

const Format = Object.freeze({
  ANTHROPIC_API_KEY: Object.freeze({
    description: `an Anthropic API key starting with ${ANTHROPIC_API_KEY_PREFIX}`,
    matches: (value) => value.startsWith(ANTHROPIC_API_KEY_PREFIX),
  }),
  OPENAI_API_KEY: Object.freeze({
    description: `an OpenAI API key starting with ${OPENAI_PREFIX}`,
    matches: (value) =>
      value.startsWith(OPENAI_PREFIX) && !value.startsWith(ANTHROPIC_PREFIX),
  }),
});

const FORMATS = Object.freeze({
  openai: Format.OPENAI_API_KEY,
  deepApiKey: Format.ANTHROPIC_API_KEY,
  deepOpenai: Format.OPENAI_API_KEY,
});

export async function encrypt(publicKey, value) {
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export function validateTokens(body, { required = true } = {}) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Tokens must be a JSON object.');
  }
  for (const key of Object.keys(body)) {
    if (!TOKENS.includes(key)) {
      throw new ValidationError(`Unknown token: ${key}.`);
    }
  }
  const tokens = {};
  for (const key of TOKENS) {
    if (body[key] === undefined) {
      continue;
    }
    if (typeof body[key] !== 'string') {
      throw new ValidationError(`${key} must be a string.`);
    }
    const value = body[key].trim();
    if (value === '') {
      continue;
    }
    if (/\s/.test(value)) {
      throw new ValidationError(`${key} must not contain whitespace.`);
    }
    if (Buffer.byteLength(value, 'utf8') > MAXIMUM_BYTES) {
      throw new ValidationError(`${key} must be at most 48 KiB.`);
    }
    const format = FORMATS[key];
    if (format !== undefined && !format.matches(value)) {
      throw new ValidationError(`${key} must be ${format.description}.`);
    }
    tokens[key] = value;
  }
  if (required && Object.keys(tokens).length === 0) {
    throw new ValidationError('Provide oauth or push.');
  }
  return tokens;
}
