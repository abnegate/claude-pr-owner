import assert from 'node:assert/strict';
import { createDecipheriv, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import {
  COOKIE,
  SESSION_AGE,
  STATE_AGE,
  clearCookie,
  open,
  readCookie,
  seal,
  setCookie,
} from '../src/session.js';

const key = randomBytes(32);
const now = 1_760_000_000_000;

function tamper(value, index) {
  const bytes = Buffer.from(value, 'base64url');
  bytes[index] ^= 0x01;
  return bytes.toString('base64url');
}

describe('session constants', () => {
  it('names the cookie with the __Host- prefix', () => {
    assert.equal(COOKIE, '__Host-ureview_session');
  });

  it('allows ten minutes for the login state and eight hours for a session', () => {
    assert.equal(STATE_AGE, 600);
    assert.equal(SESSION_AGE, 28800);
  });
});

describe('seal and open', () => {
  it('round-trips a session payload', () => {
    const payload = {
      login: 'abnegate',
      token: 'ghu_token',
      avatar: 'https://avatars.githubusercontent.com/u/1',
      issued: now,
    };
    assert.deepEqual(open(seal(payload, key), key, SESSION_AGE, now), payload);
  });

  it('round-trips a state payload', () => {
    const payload = { state: randomBytes(16).toString('hex'), issued: now };
    assert.deepEqual(
      open(seal(payload, key), key, STATE_AGE, now + 1000),
      payload,
    );
  });

  it('defaults now to the current time', () => {
    const payload = { login: 'abnegate', issued: Date.now() };
    assert.deepEqual(open(seal(payload, key), key, SESSION_AGE), payload);
  });

  it('produces base64url without padding', () => {
    assert.match(seal({ issued: now }, key), /^[A-Za-z0-9_-]+$/);
  });

  it('lays out iv, tag and AES-256-GCM ciphertext of the JSON payload', () => {
    const payload = { login: 'abnegate', issued: now };
    const bytes = Buffer.from(seal(payload, key), 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      bytes.subarray(0, 12),
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    const plaintext = Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString('utf8');
    assert.deepEqual(JSON.parse(plaintext), payload);
  });

  it('uses a fresh iv for every seal', () => {
    const payload = { login: 'abnegate', issued: now };
    const first = Buffer.from(seal(payload, key), 'base64url');
    const second = Buffer.from(seal(payload, key), 'base64url');
    assert.notDeepEqual(first.subarray(0, 12), second.subarray(0, 12));
  });

  for (const [part, index] of [
    ['iv', 0],
    ['tag', 12],
    ['ciphertext', 28],
    ['last byte', -1],
  ]) {
    it(`returns null when a byte of the ${part} is tampered with`, () => {
      const value = seal({ login: 'abnegate', issued: now }, key);
      const length = Buffer.from(value, 'base64url').length;
      const tampered = tamper(value, index < 0 ? length + index : index);
      assert.equal(open(tampered, key, SESSION_AGE, now), null);
    });
  }

  it('returns null when the payload has expired', () => {
    const value = seal({ login: 'abnegate', issued: now }, key);
    assert.equal(
      open(value, key, SESSION_AGE, now + SESSION_AGE * 1000 + 1),
      null,
    );
  });

  it('accepts a payload exactly at its maximum age', () => {
    const payload = { login: 'abnegate', issued: now };
    assert.deepEqual(
      open(seal(payload, key), key, STATE_AGE, now + STATE_AGE * 1000),
      payload,
    );
  });

  it('applies the maximum age it is given', () => {
    const value = seal({ state: 'abc', issued: now }, key);
    const later = now + (STATE_AGE + 1) * 1000;
    assert.equal(open(value, key, STATE_AGE, later), null);
    assert.deepEqual(open(value, key, SESSION_AGE, later), {
      state: 'abc',
      issued: now,
    });
  });

  it('returns null under the wrong key', () => {
    const value = seal({ login: 'abnegate', issued: now }, key);
    assert.equal(open(value, randomBytes(32), SESSION_AGE, now), null);
  });

  it('returns null when issued is missing', () => {
    assert.equal(
      open(seal({ login: 'abnegate' }, key), key, SESSION_AGE, now),
      null,
    );
  });

  for (const issued of [String(now), null, true, { at: now }]) {
    it(`returns null when issued is ${JSON.stringify(issued)}`, () => {
      const value = seal({ login: 'abnegate', issued }, key);
      assert.equal(open(value, key, SESSION_AGE, now), null);
    });
  }

  for (const value of [
    '',
    'garbage',
    '!!!!',
    'a'.repeat(10),
    randomBytes(64).toString('base64url'),
    null,
    undefined,
  ]) {
    it(`returns null for the garbage value ${JSON.stringify(value)}`, () => {
      assert.equal(open(value, key, SESSION_AGE, now), null);
    });
  }

  it('returns null for a sealed non-object payload', () => {
    assert.equal(open(seal('abnegate', key), key, SESSION_AGE, now), null);
    assert.equal(open(seal(null, key), key, SESSION_AGE, now), null);
  });
});

describe('readCookie', () => {
  it('finds the session among several cookies', () => {
    assert.equal(
      readCookie({ cookie: `theme=dark; ${COOKIE}=sealed-value; _ga=GA1.2.3` }),
      'sealed-value',
    );
  });

  it('finds the session when it is the only cookie', () => {
    assert.equal(
      readCookie({ cookie: `${COOKIE}=sealed-value` }),
      'sealed-value',
    );
  });

  it('ignores cookies whose name only ends with the session name', () => {
    assert.equal(
      readCookie({ cookie: `x${COOKIE}=wrong; ${COOKIE}=right` }),
      'right',
    );
  });

  it('returns null when the session cookie is absent', () => {
    assert.equal(readCookie({ cookie: 'theme=dark; _ga=GA1.2.3' }), null);
  });

  it('returns null without a cookie header', () => {
    assert.equal(readCookie({}), null);
  });

  it('reads a value sealed by seal', () => {
    const value = seal({ login: 'abnegate', issued: now }, key);
    assert.equal(readCookie({ cookie: `a=1; ${COOKIE}=${value}` }), value);
  });
});

describe('setCookie and clearCookie', () => {
  it('sets the exact attribute string', () => {
    assert.equal(
      setCookie('sealed-value', SESSION_AGE),
      '__Host-ureview_session=sealed-value; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=28800',
    );
  });

  it('uses the maximum age it is given', () => {
    assert.equal(
      setCookie('state-value', STATE_AGE),
      '__Host-ureview_session=state-value; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600',
    );
  });

  it('clears the cookie with an empty value and a zero maximum age', () => {
    assert.equal(
      clearCookie(),
      '__Host-ureview_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
  });
});
