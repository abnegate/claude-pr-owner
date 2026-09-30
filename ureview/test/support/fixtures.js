import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { Environment } from '../../src/Environment.js';
import { COOKIE, seal } from '../../src/session.js';

export const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const sessionKey = randomBytes(32);

export const url = 'https://ureview.test';

export function environment(overrides = {}) {
  return Environment.from({
    GITHUB_APP_ID: '123',
    GITHUB_APP_SLUG: 'ureview',
    GITHUB_CLIENT_ID: 'Iv1.client',
    GITHUB_CLIENT_SECRET: 'client-secret',
    GITHUB_APP_PRIVATE_KEY: privateKey,
    SESSION_KEY: sessionKey.toString('base64'),
    PUBLIC_URL: url,
    ...overrides,
  });
}

export function sessionCookie(payload, now = Date.now()) {
  return `${COOKIE}=${seal({ ...payload, issued: now }, sessionKey)}`;
}

export const pages = {
  ui: '<!doctype html><title>ui</title>',
  manifest: '<!doctype html><title>manifest</title>',
  created: '<!doctype html><title>created</title>',
};
