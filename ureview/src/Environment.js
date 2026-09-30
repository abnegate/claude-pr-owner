import { createPrivateKey } from 'node:crypto';

const DEFAULT_SLUG = 'ureview';
const APP_ID = /^[0-9]+$/;
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
const TOKEN = /^\S+$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SESSION_KEY_BYTES = 32;

function raw(value) {
  return typeof value === 'string' ? value : '';
}

function text(value) {
  return raw(value).trim();
}

function decodePrivateKey(value) {
  return raw(value).replaceAll('\\n', '\n');
}

function isRsaPrivateKey(value) {
  try {
    return createPrivateKey(value).asymmetricKeyType === 'rsa';
  } catch {
    return false;
  }
}

function decodeSessionKey(value) {
  const encoded = text(value);
  if (!BASE64.test(encoded)) {
    return null;
  }
  const key = Buffer.from(encoded, 'base64');
  return key.length === SESSION_KEY_BYTES ? key : null;
}

function decodeUrl(value) {
  return text(value).replace(/\/+$/, '');
}

function isOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  } catch {
    return false;
  }
}

export class Environment {
  constructor({
    configured,
    appId,
    slug,
    clientId,
    clientSecret,
    privateKey,
    sessionKey,
    url,
  }) {
    this.configured = configured;
    this.appId = appId;
    this.slug = slug;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.privateKey = privateKey;
    this.sessionKey = sessionKey;
    this.url = url;
    Object.freeze(this);
  }

  static from(variables) {
    const source =
      variables !== null && typeof variables === 'object' ? variables : {};
    const appId = text(source.GITHUB_APP_ID);
    const slug = text(source.GITHUB_APP_SLUG) || DEFAULT_SLUG;
    const clientId = text(source.GITHUB_CLIENT_ID);
    const clientSecret = text(source.GITHUB_CLIENT_SECRET);
    const privateKey = decodePrivateKey(source.GITHUB_APP_PRIVATE_KEY);
    const sessionKey = decodeSessionKey(source.SESSION_KEY);
    const url = decodeUrl(source.PUBLIC_URL);
    const configured =
      APP_ID.test(appId) &&
      SLUG.test(slug) &&
      TOKEN.test(clientId) &&
      TOKEN.test(clientSecret) &&
      isRsaPrivateKey(privateKey) &&
      sessionKey !== null &&
      isOrigin(url);
    return new Environment({
      configured,
      appId,
      slug,
      clientId,
      clientSecret,
      privateKey,
      sessionKey,
      url,
    });
  }
}
