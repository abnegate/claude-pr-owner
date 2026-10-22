import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../src/ValidationError.js';
import { loginKey, names } from '../src/names.js';

describe('loginKey', () => {
  it('upper-cases the login and turns hyphens into underscores', () => {
    assert.equal(loginKey('some-user'), 'SOME_USER');
  });

  it('upper-cases a mixed-case login with digits', () => {
    assert.equal(loginKey('Some-User-2'), 'SOME_USER_2');
  });

  it('accepts a login of exactly 39 characters', () => {
    assert.equal(loginKey('a'.repeat(39)), 'A'.repeat(39));
  });

  for (const login of [
    '',
    'a'.repeat(40),
    'dependabot[bot]',
    'some user',
    'some_user',
    'user.name',
    '../secrets',
  ]) {
    it(`throws a ValidationError for ${JSON.stringify(login)}`, () => {
      assert.throws(() => loginKey(login), ValidationError);
    });
  }
});

describe('names', () => {
  it('derives every variable and secret name from the login', () => {
    assert.deepEqual(names('abnegate'), {
      variable: 'UREVIEW_ABNEGATE',
      oauth: 'UREVIEW_OAUTH_TOKEN_ABNEGATE',
      apiKey: 'UREVIEW_API_KEY_ABNEGATE',
      push: 'UREVIEW_PUSH_TOKEN_ABNEGATE',
    });
  });

  it('uses the login key for hyphenated logins', () => {
    assert.deepEqual(names('some-user'), {
      variable: 'UREVIEW_SOME_USER',
      oauth: 'UREVIEW_OAUTH_TOKEN_SOME_USER',
      apiKey: 'UREVIEW_API_KEY_SOME_USER',
      push: 'UREVIEW_PUSH_TOKEN_SOME_USER',
    });
  });

  it('returns a frozen object', () => {
    assert.ok(Object.isFrozen(names('abnegate')));
  });

  it('throws a ValidationError for an invalid login', () => {
    assert.throws(() => names('dependabot[bot]'), ValidationError);
  });
});
