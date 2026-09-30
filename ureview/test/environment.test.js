import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { Environment } from '../src/Environment.js';

const sessionKey = randomBytes(32);
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

const complete = {
  GITHUB_APP_ID: '123',
  GITHUB_APP_SLUG: 'ureview',
  GITHUB_CLIENT_ID: 'Iv1.client',
  GITHUB_CLIENT_SECRET: 'client-secret',
  GITHUB_APP_PRIVATE_KEY: privateKey,
  SESSION_KEY: sessionKey.toString('base64'),
  PUBLIC_URL: 'https://ureview.test',
};

function without(name) {
  const variables = { ...complete };
  delete variables[name];
  return variables;
}

describe('Environment.from', () => {
  it('is configured when every variable is valid', () => {
    const environment = Environment.from(complete);
    assert.equal(environment.configured, true);
    assert.equal(String(environment.appId), '123');
    assert.equal(environment.slug, 'ureview');
    assert.equal(environment.clientId, 'Iv1.client');
    assert.equal(environment.clientSecret, 'client-secret');
    assert.equal(environment.privateKey, complete.GITHUB_APP_PRIVATE_KEY);
    assert.equal(environment.url, 'https://ureview.test');
  });

  it('decodes the session key into a 32-byte Buffer', () => {
    const environment = Environment.from(complete);
    assert.ok(Buffer.isBuffer(environment.sessionKey));
    assert.equal(environment.sessionKey.length, 32);
    assert.ok(environment.sessionKey.equals(sessionKey));
  });

  it('returns a frozen instance', () => {
    const environment = Environment.from(complete);
    assert.ok(environment instanceof Environment);
    assert.ok(Object.isFrozen(environment));
  });

  it('defaults the slug to ureview', () => {
    const environment = Environment.from(without('GITHUB_APP_SLUG'));
    assert.equal(environment.slug, 'ureview');
  });

  it('keeps a custom slug', () => {
    const environment = Environment.from({
      ...complete,
      GITHUB_APP_SLUG: 'ureview-staging',
    });
    assert.equal(environment.slug, 'ureview-staging');
  });

  for (const name of [
    'GITHUB_APP_ID',
    'GITHUB_CLIENT_ID',
    'GITHUB_CLIENT_SECRET',
    'GITHUB_APP_PRIVATE_KEY',
    'SESSION_KEY',
    'PUBLIC_URL',
  ]) {
    it(`is unconfigured when ${name} is missing`, () => {
      assert.equal(Environment.from(without(name)).configured, false);
    });

    it(`is unconfigured when ${name} is empty`, () => {
      assert.equal(
        Environment.from({ ...complete, [name]: '' }).configured,
        false,
      );
    });
  }

  it('is unconfigured with a 16-byte session key', () => {
    const environment = Environment.from({
      ...complete,
      SESSION_KEY: randomBytes(16).toString('base64'),
    });
    assert.equal(environment.configured, false);
    assert.equal(environment.sessionKey, null);
  });

  it('is unconfigured with a 64-byte session key', () => {
    const environment = Environment.from({
      ...complete,
      SESSION_KEY: randomBytes(64).toString('base64'),
    });
    assert.equal(environment.configured, false);
    assert.equal(environment.sessionKey, null);
  });

  it('has a null session key when SESSION_KEY is missing', () => {
    assert.equal(Environment.from(without('SESSION_KEY')).sessionKey, null);
  });

  it('turns a literal backslash-n in the private key into a newline', () => {
    const environment = Environment.from({
      ...complete,
      GITHUB_APP_PRIVATE_KEY: privateKey.replaceAll('\n', '\\n'),
    });
    assert.equal(environment.privateKey, privateKey);
    assert.equal(environment.configured, true);
  });

  it('strips a trailing slash from the public URL', () => {
    const environment = Environment.from({
      ...complete,
      PUBLIC_URL: 'https://ureview.test/',
    });
    assert.equal(environment.url, 'https://ureview.test');
    assert.equal(environment.configured, true);
  });

  it('never throws on an empty environment', () => {
    const environment = Environment.from({});
    assert.equal(environment.configured, false);
    assert.equal(environment.sessionKey, null);
  });

  it('never throws on garbage values', () => {
    const environment = Environment.from({
      GITHUB_APP_ID: 'not a number',
      GITHUB_APP_SLUG: '',
      GITHUB_CLIENT_ID: ' ',
      GITHUB_CLIENT_SECRET: '',
      GITHUB_APP_PRIVATE_KEY: '\\n',
      SESSION_KEY: '%%% not base64 %%%',
      PUBLIC_URL: '/',
    });
    assert.equal(environment.configured, false);
    assert.equal(environment.sessionKey, null);
  });

  it('never throws on a process-like environment', () => {
    assert.doesNotThrow(() => Environment.from({ ...process.env }));
  });
});
