import sodium from 'libsodium-wrappers';
import { ValidationError } from './ValidationError.js';

const KEYS = ['oauth', 'push'];
const MAXIMUM_BYTES = 48 * 1024;

export async function encrypt(publicKey, value) {
  await sodium.ready;
  const sealed = sodium.crypto_box_seal(
    sodium.from_string(value),
    sodium.from_base64(publicKey, sodium.base64_variants.ORIGINAL),
  );
  return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

export function validateTokens(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Tokens must be a JSON object.');
  }
  for (const key of Object.keys(body)) {
    if (!KEYS.includes(key)) {
      throw new ValidationError(`Unknown token: ${key}.`);
    }
  }
  const tokens = {};
  for (const key of KEYS) {
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
    tokens[key] = value;
  }
  if (Object.keys(tokens).length === 0) {
    throw new ValidationError('Provide oauth or push.');
  }
  return tokens;
}
