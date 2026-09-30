import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const COOKIE = '__Host-ureview_session';
export const STATE_AGE = 600;
export const SESSION_AGE = 28800;

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function seal(payload, key) {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, {
    authTagLength: TAG_LENGTH,
  });
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString(
    'base64url',
  );
}

export function open(value, key, maxAge, now = Date.now()) {
  try {
    if (typeof value !== 'string') {
      return null;
    }
    const sealed = Buffer.from(value, 'base64url');
    if (
      sealed.length <= IV_LENGTH + TAG_LENGTH ||
      sealed.toString('base64url') !== value
    ) {
      return null;
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      key,
      sealed.subarray(0, IV_LENGTH),
      {
        authTagLength: TAG_LENGTH,
      },
    );
    decipher.setAuthTag(sealed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
    const plaintext = Buffer.concat([
      decipher.update(sealed.subarray(IV_LENGTH + TAG_LENGTH)),
      decipher.final(),
    ]).toString('utf8');
    const payload = JSON.parse(plaintext);
    if (
      payload === null ||
      typeof payload !== 'object' ||
      Array.isArray(payload)
    ) {
      return null;
    }
    if (
      typeof payload.issued !== 'number' ||
      !Number.isFinite(payload.issued)
    ) {
      return null;
    }
    if (now - payload.issued > maxAge * 1000) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

export function readCookie(headers) {
  const header = headers?.cookie;
  const cookies = Array.isArray(header) ? header.join('; ') : header;
  if (typeof cookies !== 'string') {
    return null;
  }
  const prefix = `${COOKIE}=`;
  for (const cookie of cookies.split(';')) {
    const trimmed = cookie.trim();
    if (trimmed.startsWith(prefix)) {
      return trimmed.slice(prefix.length) || null;
    }
  }
  return null;
}

export function setCookie(value, maxAge) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie() {
  return setCookie('', 0);
}
