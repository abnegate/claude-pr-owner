import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { describe, test } from 'node:test';
import { GitHubAppError } from '../src/GitHubAppError.js';
import { GitHubError } from '../src/GitHubError.js';
import {
  API,
  appToken,
  exchangeCode,
  installations,
  installationToken,
  paginate,
  repositoryInstallation,
  request,
  revoke,
  user,
} from '../src/github.js';
import { mockFetch, NOT_FOUND } from './support/fetch.js';
import { privateKey, publicKey } from './support/fixtures.js';

const WRITE = {
  secrets: 'write',
  actions_variables: 'write',
  metadata: 'read',
};

function decodeSegment(segment) {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('API', () => {
  test('points at the public GitHub API', () => {
    assert.equal(API, 'https://api.github.com');
  });
});

describe('appToken', () => {
  const now = 1_700_000_000_000;
  const seconds = now / 1000;

  test('builds a three-segment RS256 JWT', async () => {
    const jwt = await appToken(123, privateKey, now);
    const segments = jwt.split('.');
    assert.equal(segments.length, 3);
    assert.deepEqual(decodeSegment(segments[0]), {
      alg: 'RS256',
      typ: 'JWT',
    });
  });

  test('issues for the app id with a ten-minute window backdated a minute', async () => {
    const jwt = await appToken(123, privateKey, now);
    const payload = decodeSegment(jwt.split('.')[1]);
    assert.equal(payload.iss, '123');
    assert.equal(payload.iat, seconds - 60);
    assert.equal(payload.exp, seconds + 540);
    assert.equal(payload.exp - payload.iat, 600);
  });

  test('accepts a string app id', async () => {
    const fromString = await appToken('456', privateKey, now);
    assert.equal(decodeSegment(fromString.split('.')[1]).iss, '456');
  });

  test('signs header and payload with the private key', async () => {
    const jwt = await appToken(123, privateKey, now);
    const [header, payload, signature] = jwt.split('.');
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    assert.equal(valid, true);
  });

  test('a tampered payload fails verification', async () => {
    const jwt = await appToken(123, privateKey, now);
    const [header, , signature] = jwt.split('.');
    const forged = Buffer.from(
      JSON.stringify({ iat: 0, exp: 1e10, iss: '123' }),
    ).toString('base64url');
    const valid = verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${forged}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    );
    assert.equal(valid, false);
  });
});

describe('request', () => {
  test('sends the documented headers and the bearer token', async () => {
    const { fetch, calls } = mockFetch({
      'GET /user': { data: { login: 'abnegate' } },
    });
    const response = await request(fetch, { path: '/user', token: 'gho_t' });
    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { login: 'abnegate' });
    assert.ok(response.headers);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, 'GET');
    assert.equal(call.url, 'https://api.github.com/user');
    assert.equal(call.headers.get('accept'), 'application/vnd.github+json');
    assert.equal(call.headers.get('x-github-api-version'), '2022-11-28');
    assert.equal(call.headers.get('user-agent'), 'ureview');
    assert.equal(call.headers.get('authorization'), 'Bearer gho_t');
    assert.equal(call.body, undefined);
  });

  test('omits authorization without a token', async () => {
    const { fetch, calls } = mockFetch({ 'GET /meta': { data: {} } });
    await request(fetch, { path: '/meta' });
    assert.equal(calls[0].headers.has('authorization'), false);
  });

  test('sends a JSON body with a content type', async () => {
    const { fetch, calls } = mockFetch({
      'POST /things': { status: 201, data: { id: 1 } },
    });
    const response = await request(fetch, {
      method: 'POST',
      path: '/things',
      token: 't',
      body: { name: 'thing' },
    });
    assert.equal(response.status, 201);
    assert.deepEqual(response.data, { id: 1 });
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.get('content-type'), 'application/json');
    assert.deepEqual(calls[0].body, { name: 'thing' });
  });

  test('accepts an absolute https URL as the path', async () => {
    const { fetch, calls } = mockFetch({
      'GET https://uploads.github.com/assets': { data: [] },
    });
    const response = await request(fetch, {
      path: 'https://uploads.github.com/assets',
    });
    assert.equal(response.status, 200);
    assert.equal(calls[0].url, 'https://uploads.github.com/assets');
  });

  test('returns null data for a 204', async () => {
    const { fetch } = mockFetch({ 'DELETE /things/1': { status: 204 } });
    const response = await request(fetch, {
      method: 'DELETE',
      path: '/things/1',
    });
    assert.equal(response.status, 204);
    assert.equal(response.data, null);
  });

  test('returns null data for an empty body', async () => {
    const fetch = async () => new Response('', { status: 200 });
    const response = await request(fetch, { path: '/empty' });
    assert.equal(response.status, 200);
    assert.equal(response.data, null);
  });

  test('never throws on an HTTP error status', async () => {
    const { fetch } = mockFetch({
      'GET /broken': { status: 500, data: { message: 'boom' } },
      'GET /missing': NOT_FOUND,
    });
    const response = await request(fetch, { path: '/broken' });
    assert.equal(response.status, 500);
    assert.deepEqual(response.data, { message: 'boom' });
    const missing = await request(fetch, { path: '/missing' });
    assert.equal(missing.status, 404);
  });
});

describe('paginate', () => {
  test('follows rel="next" across pages and concatenates the key', async () => {
    const next =
      'https://api.github.com/user/installations?per_page=100&page=2';
    const { fetch, calls } = mockFetch({
      'GET /user/installations': ({ url }) =>
        url.searchParams.get('page') === '2'
          ? {
              data: { total_count: 3, installations: [{ id: 3 }] },
              headers: {
                link: '<https://api.github.com/user/installations?per_page=100&page=1>; rel="prev", <https://api.github.com/user/installations?per_page=100&page=1>; rel="first"',
              },
            }
          : {
              data: { total_count: 3, installations: [{ id: 1 }, { id: 2 }] },
              headers: {
                link: `<${next}>; rel="next", <${next}>; rel="last"`,
              },
            },
    });
    const installations = await paginate(fetch, {
      path: '/user/installations?per_page=100',
      token: 'gho_t',
      key: 'installations',
    });
    assert.deepEqual(installations, [{ id: 1 }, { id: 2 }, { id: 3 }]);
    assert.equal(calls.length, 2);
    assert.equal(
      calls[0].url,
      'https://api.github.com/user/installations?per_page=100',
    );
    assert.equal(calls[1].url, next);
    for (const call of calls) {
      assert.equal(call.headers.get('authorization'), 'Bearer gho_t');
    }
  });

  test('stops after a single page without a link header', async () => {
    const { fetch, calls } = mockFetch({
      'GET /user/installations': { data: { installations: [{ id: 1 }] } },
    });
    const installations = await paginate(fetch, {
      path: '/user/installations',
      token: 't',
      key: 'installations',
    });
    assert.deepEqual(installations, [{ id: 1 }]);
    assert.equal(calls.length, 1);
  });

  test('throws GitHubError on a non-2xx page', async () => {
    const { fetch } = mockFetch({
      'GET /user/installations': { status: 401, data: { message: 'Bad' } },
    });
    await assert.rejects(
      paginate(fetch, {
        path: '/user/installations',
        token: 't',
        key: 'installations',
      }),
      (error) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.status, 401);
        assert.equal(error.method, 'GET');
        return true;
      },
    );
  });

  test('throws GitHubError when a later page fails', async () => {
    const next = 'https://api.github.com/user/installations?page=2';
    const { fetch } = mockFetch({
      'GET /user/installations': ({ url }) =>
        url.searchParams.get('page') === '2'
          ? { status: 502, data: { message: 'Bad gateway' } }
          : {
              data: { installations: [{ id: 1 }] },
              headers: { link: `<${next}>; rel="next"` },
            },
    });
    await assert.rejects(
      paginate(fetch, {
        path: '/user/installations',
        token: 't',
        key: 'installations',
      }),
      (error) => error instanceof GitHubError && error.status === 502,
    );
  });

  test('throws the given failure class', async () => {
    const { fetch } = mockFetch({
      'GET /repos/abnegate/edge/actions/organization-secrets': {
        status: 401,
        data: { message: 'Bad credentials' },
      },
    });
    await assert.rejects(
      paginate(fetch, {
        path: '/repos/abnegate/edge/actions/organization-secrets',
        token: 'ghs_install',
        key: 'secrets',
        Failure: GitHubAppError,
      }),
      (error) => error instanceof GitHubAppError && error.status === 401,
    );
  });
});

describe('installations', () => {
  test('lists every installation of the user, a hundred per page', async () => {
    const { fetch, calls } = mockFetch({
      'GET /user/installations': {
        data: { total_count: 1, installations: [{ id: 1 }] },
      },
    });
    assert.deepEqual(await installations(fetch, 'gho_t'), [{ id: 1 }]);
    assert.equal(
      calls[0].url,
      'https://api.github.com/user/installations?per_page=100',
    );
    assert.equal(calls[0].headers.get('authorization'), 'Bearer gho_t');
  });
});

describe('GitHubError', () => {
  test('is rate limited on 403 or 429 with retry-after', () => {
    for (const status of [403, 429]) {
      const error = new GitHubError(
        status,
        'GET',
        '/user',
        new Headers({ 'retry-after': '30' }),
      );
      assert.equal(error.rateLimited, true);
      assert.equal(error.retryAfter, 30);
    }
  });

  test('is rate limited when no requests remain and exposes the reset', () => {
    const error = new GitHubError(
      403,
      'GET',
      '/user',
      new Headers({
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1700000000',
      }),
    );
    assert.equal(error.rateLimited, true);
    assert.equal(error.retryAfter, null);
    assert.equal(error.reset, 1700000000);
  });

  test('is not rate limited without the headers or on other statuses', () => {
    const cases = [
      [403, {}],
      [403, { 'x-ratelimit-remaining': '12' }],
      [404, { 'retry-after': '30' }],
      [500, { 'x-ratelimit-remaining': '0' }],
    ];
    for (const [status, headers] of cases) {
      const error = new GitHubError(
        status,
        'GET',
        '/user',
        new Headers(headers),
      );
      assert.equal(error.rateLimited, false, JSON.stringify([status, headers]));
    }
    assert.equal(new GitHubError(403, 'GET', '/user').rateLimited, false);
  });

  test('ignores a retry-after that is not a number of seconds', () => {
    const error = new GitHubError(
      429,
      'GET',
      '/user',
      new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    );
    assert.equal(error.rateLimited, true);
    assert.equal(error.retryAfter, null);
  });

  test('describes the status, method and path only', () => {
    const error = new GitHubAppError(401, 'POST', '/app/installations/1');
    assert.ok(error instanceof GitHubError);
    assert.equal(error.name, 'GitHubAppError');
    assert.equal(
      error.message,
      'GitHub responded 401 to POST /app/installations/1',
    );
  });
});

describe('installationToken', () => {
  test('mints with repositories and passes permissions through unchanged', async () => {
    const { fetch, calls } = mockFetch({
      'POST /app/installations/42/access_tokens': {
        status: 201,
        data: { token: 'ghs_write', expires_at: '2026-09-30T01:00:00Z' },
      },
    });
    const permissions = { ...WRITE };
    const token = await installationToken(fetch, {
      jwt: 'app.jwt.value',
      installation: 42,
      repositories: ['edge'],
      permissions,
    });
    assert.equal(token, 'ghs_write');
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.get('authorization'), 'Bearer app.jwt.value');
    assert.deepEqual(call.body, {
      repositories: ['edge'],
      permissions: {
        secrets: 'write',
        actions_variables: 'write',
        metadata: 'read',
      },
    });
    assert.deepEqual(permissions, WRITE);
  });

  test('omits repositories when none are given', async () => {
    const read = {
      secrets: 'read',
      actions_variables: 'read',
      metadata: 'read',
    };
    const { fetch, calls } = mockFetch({
      'POST /app/installations/7/access_tokens': {
        status: 201,
        data: { token: 'ghs_read' },
      },
    });
    const token = await installationToken(fetch, {
      jwt: 'jwt',
      installation: 7,
      permissions: read,
    });
    assert.equal(token, 'ghs_read');
    assert.deepEqual(calls[0].body, { permissions: read });
  });

  test('throws GitHubError on a non-201 response', async () => {
    const { fetch } = mockFetch({
      'POST /app/installations/42/access_tokens': {
        status: 422,
        data: { message: 'Unprocessable' },
      },
    });
    await assert.rejects(
      installationToken(fetch, {
        jwt: 'jwt',
        installation: 42,
        repositories: ['edge'],
        permissions: WRITE,
      }),
      (error) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.status, 422);
        assert.equal(error.method, 'POST');
        return true;
      },
    );
  });

  test('treats a 200 as a failure because only 201 mints a token', async () => {
    const { fetch } = mockFetch({
      'POST /app/installations/42/access_tokens': {
        status: 200,
        data: { token: 'ghs_unexpected' },
      },
    });
    await assert.rejects(
      installationToken(fetch, {
        jwt: 'jwt',
        installation: 42,
        permissions: WRITE,
      }),
      (error) => error instanceof GitHubError && error.status === 200,
    );
  });

  test('throws GitHubAppError when the App JWT is rejected', async () => {
    const { fetch } = mockFetch({
      'POST /app/installations/42/access_tokens': {
        status: 401,
        data: { message: 'A JSON web token could not be decoded' },
      },
    });
    await assert.rejects(
      installationToken(fetch, {
        jwt: 'jwt',
        installation: 42,
        permissions: WRITE,
      }),
      (error) => error instanceof GitHubAppError && error.status === 401,
    );
  });
});

describe('repositoryInstallation', () => {
  test('returns the installation id with the app JWT', async () => {
    const { fetch, calls } = mockFetch({
      'GET /repos/abnegate/edge/installation': { data: { id: 99 } },
    });
    const id = await repositoryInstallation(fetch, {
      jwt: 'jwt',
      owner: 'abnegate',
      name: 'edge',
    });
    assert.equal(id, 99);
    assert.equal(calls[0].headers.get('authorization'), 'Bearer jwt');
  });

  test('returns null when the app is not installed', async () => {
    const { fetch } = mockFetch({
      'GET /repos/abnegate/missing/installation': NOT_FOUND,
    });
    const id = await repositoryInstallation(fetch, {
      jwt: 'jwt',
      owner: 'abnegate',
      name: 'missing',
    });
    assert.equal(id, null);
  });

  test('throws GitHubAppError when the App JWT is rejected', async () => {
    const { fetch } = mockFetch({
      'GET /repos/abnegate/edge/installation': {
        status: 401,
        data: { message: 'Bad credentials' },
      },
    });
    await assert.rejects(
      repositoryInstallation(fetch, {
        jwt: 'jwt',
        owner: 'abnegate',
        name: 'edge',
      }),
      (error) => error instanceof GitHubAppError && error.status === 401,
    );
  });

  for (const data of [{}, null, { id: '99' }, { id: 1.5 }]) {
    test(`throws GitHubAppError 502 for an installation of ${JSON.stringify(data)}`, async () => {
      const { fetch } = mockFetch({
        'GET /repos/abnegate/edge/installation': { data },
      });
      await assert.rejects(
        repositoryInstallation(fetch, {
          jwt: 'jwt',
          owner: 'abnegate',
          name: 'edge',
        }),
        (error) => error instanceof GitHubAppError && error.status === 502,
      );
    });
  }
});

describe('exchangeCode', () => {
  const key = 'POST https://github.com/login/oauth/access_token';
  const options = {
    clientId: 'Iv1.client',
    clientSecret: 'client-secret',
    code: 'code-123',
    redirectUri: 'https://ureview.test/auth/callback',
  };

  test('posts the credentials as JSON and returns the access token', async () => {
    const { fetch, calls } = mockFetch({
      [key]: { data: { access_token: 'ghu_user', token_type: 'bearer' } },
    });
    const token = await exchangeCode(fetch, options);
    assert.equal(token, 'ghu_user');
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.url, 'https://github.com/login/oauth/access_token');
    assert.equal(call.headers.get('accept'), 'application/json');
    assert.equal(call.headers.get('content-type'), 'application/json');
    assert.deepEqual(call.body, {
      client_id: 'Iv1.client',
      client_secret: 'client-secret',
      code: 'code-123',
      redirect_uri: 'https://ureview.test/auth/callback',
    });
  });

  test('throws GitHubError when the response carries an error', async () => {
    const { fetch } = mockFetch({
      [key]: {
        data: {
          error: 'bad_verification_code',
          error_description: 'The code passed is incorrect or expired.',
        },
      },
    });
    await assert.rejects(exchangeCode(fetch, options), (error) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 400);
      assert.equal(error.method, 'POST');
      assert.equal(error.path, '/login/oauth/access_token');
      return true;
    });
  });

  test('throws GitHubError when the token is missing', async () => {
    const { fetch } = mockFetch({ [key]: { data: {} } });
    await assert.rejects(
      exchangeCode(fetch, options),
      (error) => error instanceof GitHubError && error.status === 400,
    );
  });
});

describe('user', () => {
  test('returns the login and avatar for the token', async () => {
    const { fetch, calls } = mockFetch({
      'GET /user': {
        data: {
          login: 'abnegate',
          id: 1,
          avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
        },
      },
    });
    const result = await user(fetch, 'ghu_user');
    assert.deepEqual(result, {
      login: 'abnegate',
      avatar: 'https://avatars.githubusercontent.com/u/1?v=4',
    });
    assert.equal(calls[0].headers.get('authorization'), 'Bearer ghu_user');
  });
});

describe('revoke', () => {
  test('deletes the user token with the App client credentials', async () => {
    const { fetch, calls } = mockFetch({
      'DELETE /applications/Iv1.client/token': { status: 204 },
    });
    const status = await revoke(fetch, {
      clientId: 'Iv1.client',
      clientSecret: 'client-secret',
      token: 'ghu_user',
    });
    assert.equal(status, 204);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call.method, 'DELETE');
    assert.equal(
      call.headers.get('authorization'),
      `Basic ${Buffer.from('Iv1.client:client-secret').toString('base64')}`,
    );
    assert.deepEqual(call.body, { access_token: 'ghu_user' });
  });
});
