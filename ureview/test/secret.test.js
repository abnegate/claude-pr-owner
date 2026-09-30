import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import sodium from 'libsodium-wrappers';
import { ValidationError } from '../src/ValidationError.js';
import { encrypt, validateTokens } from '../src/secret.js';

const limit = 48 * 1024;

describe('encrypt', () => {
  let keypair;
  let publicKey;

  before(async () => {
    await sodium.ready;
    keypair = sodium.crypto_box_keypair();
    publicKey = sodium.to_base64(
      keypair.publicKey,
      sodium.base64_variants.ORIGINAL,
    );
  });

  function decrypt(encrypted) {
    const opened = sodium.crypto_box_seal_open(
      sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
      keypair.publicKey,
      keypair.privateKey,
    );
    return sodium.to_string(opened);
  }

  it('seals a value that opens with the matching keypair', async () => {
    const encrypted = await encrypt(publicKey, 'sk-ant-oat01-token');
    assert.equal(typeof encrypted, 'string');
    assert.equal(decrypt(encrypted), 'sk-ant-oat01-token');
  });

  it('encodes the output as standard base64', async () => {
    const encrypted = await encrypt(publicKey, 'ghp_token');
    assert.match(encrypted, /^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('round-trips unicode values', async () => {
    assert.equal(decrypt(await encrypt(publicKey, 'tökén-✓')), 'tökén-✓');
  });

  it('round-trips a value at the size limit', async () => {
    const value = 'a'.repeat(limit);
    assert.equal(decrypt(await encrypt(publicKey, value)), value);
  });

  it('produces a different ciphertext on every call', async () => {
    const first = await encrypt(publicKey, 'ghp_token');
    const second = await encrypt(publicKey, 'ghp_token');
    assert.notEqual(first, second);
  });

  it('cannot be opened by another keypair', async () => {
    const encrypted = await encrypt(publicKey, 'ghp_token');
    const other = sodium.crypto_box_keypair();
    assert.throws(() =>
      sodium.crypto_box_seal_open(
        sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
        other.publicKey,
        other.privateKey,
      ),
    );
  });
});

describe('validateTokens', () => {
  it('accepts an oauth token', () => {
    assert.deepEqual(validateTokens({ oauth: 'sk-ant-oat01-token' }), {
      oauth: 'sk-ant-oat01-token',
    });
  });

  it('accepts a push token', () => {
    assert.deepEqual(validateTokens({ push: 'ghp_token' }), {
      push: 'ghp_token',
    });
  });

  it('accepts both tokens', () => {
    assert.deepEqual(
      validateTokens({ oauth: 'sk-ant-oat01-token', push: 'ghp_token' }),
      {
        oauth: 'sk-ant-oat01-token',
        push: 'ghp_token',
      },
    );
  });

  it('trims surrounding whitespace', () => {
    assert.deepEqual(
      validateTokens({ oauth: '  sk-ant-oat01-token\n', push: '\tghp_token ' }),
      {
        oauth: 'sk-ant-oat01-token',
        push: 'ghp_token',
      },
    );
  });

  it('drops an empty value', () => {
    assert.deepEqual(
      validateTokens({ oauth: 'sk-ant-oat01-token', push: '' }),
      {
        oauth: 'sk-ant-oat01-token',
      },
    );
  });

  it('drops a whitespace-only value', () => {
    assert.deepEqual(validateTokens({ oauth: ' \n ', push: 'ghp_token' }), {
      push: 'ghp_token',
    });
  });

  it('accepts a value of exactly 48 KiB', () => {
    const value = 'a'.repeat(limit);
    assert.deepEqual(validateTokens({ oauth: value }), { oauth: value });
  });

  it('measures the size after trimming', () => {
    const value = 'a'.repeat(limit);
    assert.deepEqual(validateTokens({ push: `  ${value}\n` }), { push: value });
  });

  it('rejects a value larger than 48 KiB', () => {
    assert.throws(
      () => validateTokens({ oauth: 'a'.repeat(limit + 1) }),
      ValidationError,
    );
  });

  for (const body of [
    null,
    undefined,
    'sk-ant-oat01-token',
    5,
    true,
    ['sk-ant-oat01-token'],
  ]) {
    it(`rejects the non-object body ${JSON.stringify(body)}`, () => {
      assert.throws(() => validateTokens(body), ValidationError);
    });
  }

  for (const key of [
    'apiKey',
    'name',
    'UREVIEW_OAUTH_TOKEN_OTHER',
    'variable',
    'Oauth',
  ]) {
    it(`rejects the unknown key ${key}`, () => {
      assert.throws(
        () => validateTokens({ oauth: 'sk-ant-oat01-token', [key]: 'value' }),
        ValidationError,
      );
    });
  }

  for (const value of [5, null, true, {}, ['token']]) {
    it(`rejects the non-string value ${JSON.stringify(value)}`, () => {
      assert.throws(() => validateTokens({ oauth: value }), ValidationError);
      assert.throws(() => validateTokens({ push: value }), ValidationError);
    });
  }

  for (const value of [
    'sk-ant oat01',
    'ghp_\ttoken',
    'ghp_\ntoken',
    'ghp_\r\ntoken',
  ]) {
    it(`rejects inner whitespace in ${JSON.stringify(value)}`, () => {
      assert.throws(() => validateTokens({ oauth: value }), ValidationError);
      assert.throws(() => validateTokens({ push: value }), ValidationError);
    });
  }

  for (const body of [
    {},
    { oauth: '' },
    { push: '   ' },
    { oauth: '\n', push: '' },
  ]) {
    it(`asks for a token when nothing remains in ${JSON.stringify(body)}`, () => {
      assert.throws(() => validateTokens(body), {
        name: 'ValidationError',
        message: 'Provide oauth or push.',
      });
      assert.throws(() => validateTokens(body), ValidationError);
    });
  }
});
