import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { Environment } from '../src/Environment.js';
import { clearCookie, COOKIE, seal, SESSION_AGE } from '../src/session.js';
import { mockFetch, NOT_FOUND } from './support/fetch.js';
import { environment, pages, sessionCookie, url } from './support/fixtures.js';

const user = {
  login: 'abnegate',
  token: 'gho_user_token_marker',
  avatar: 'https://avatars.githubusercontent.com/u/1',
};

const policy = (formAction, scripts = "'none'") =>
  `default-src 'none'; script-src ${scripts}; style-src 'unsafe-inline'; img-src https://avatars.githubusercontent.com; connect-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`;

function start({
  configuration = environment(),
  routes = {},
  documents = pages,
  now,
} = {}) {
  const { fetch, calls } = mockFetch(routes);
  const logs = [];
  const errors = [];
  const options = { environment: configuration, fetch, pages: documents };
  const handle = createApp(now === undefined ? options : { ...options, now });
  const send = (request) =>
    handle(
      { method: 'GET', query: {}, headers: {}, bodyText: '', ...request },
      {
        log: (...values) => logs.push(values),
        error: (...values) => errors.push(values),
      },
    );
  return { send, calls, logs, errors };
}

function header(response, name) {
  const matches = Object.keys(response.headers).filter(
    (key) => key.toLowerCase() === name,
  );
  assert.ok(matches.length <= 1, `expected at most one ${name} header`);
  return matches.length === 0 ? undefined : response.headers[matches[0]];
}

function assertSingleCookie(response) {
  const value = header(response, 'set-cookie');
  assert.equal(typeof value, 'string', 'expected one set-cookie string');
  assert.equal(value.split(`${COOKIE}=`).length, 2, 'expected one cookie');
  return value;
}

function assertFailure(response, status, error) {
  assert.equal(response.status, status);
  assert.equal(typeof response.body, 'string');
  assert.equal(JSON.parse(response.body).error, error);
  assert.equal(
    header(response, 'content-type'),
    'application/json; charset=utf-8',
  );
  assert.equal(header(response, 'cache-control'), 'no-store');
}

function assertBaseHeaders(response, referrer = 'same-origin') {
  assert.equal(header(response, 'referrer-policy'), referrer);
  assert.equal(header(response, 'x-content-type-options'), 'nosniff');
}

const authenticated = (headers = {}) => ({
  cookie: sessionCookie(user),
  ...headers,
});

const writing = (headers = {}) => authenticated({ origin: url, ...headers });

describe('configuration gates', () => {
  const unconfigured = () => start({ configuration: Environment.from({}) });

  it('serves the UI while unconfigured', async () => {
    const response = await unconfigured().send({ path: '/' });
    assert.equal(response.status, 200);
    assert.equal(response.body, pages.ui);
    assert.equal(header(response, 'content-type'), 'text/html; charset=utf-8');
    assert.equal(header(response, 'x-frame-options'), 'DENY');
    assert.equal(header(response, 'content-security-policy'), policy("'self'"));
    assertBaseHeaders(response);
  });

  it('serves the manifest page with a GitHub form action while unconfigured', async () => {
    const response = await unconfigured().send({ path: '/setup' });
    assert.equal(response.status, 200);
    assert.equal(response.body, pages.manifest);
    assert.equal(
      header(response, 'content-security-policy'),
      policy('https://github.com'),
    );
    assertBaseHeaders(response);
  });

  it('serves the created page while unconfigured', async () => {
    const response = await unconfigured().send({ path: '/setup/complete' });
    assert.equal(response.status, 200);
    assert.equal(response.body, pages.created);
    assert.equal(header(response, 'content-security-policy'), policy("'self'"));
    assertBaseHeaders(response, 'no-referrer');
  });

  it('refuses every other route with 503 while unconfigured', async () => {
    const { send, calls } = unconfigured();
    const requests = [
      { path: '/api/me', headers: authenticated() },
      { path: '/api/repositories', headers: authenticated() },
      { path: '/auth/login' },
      { path: '/auth/callback', query: { code: 'code', state: 'state' } },
      { method: 'POST', path: '/auth/logout', headers: { origin: url } },
    ];
    for (const request of requests) {
      const response = await send(request);
      assertFailure(response, 503, 'unconfigured');
      assertBaseHeaders(response);
    }
    assert.equal(calls.length, 0);
  });

  it('treats a partial environment as unconfigured', async () => {
    const { send } = start({
      configuration: environment({ GITHUB_CLIENT_SECRET: '' }),
    });
    assertFailure(
      await send({ path: '/api/me', headers: authenticated() }),
      503,
      'unconfigured',
    );
    assert.equal((await send({ path: '/setup' })).status, 200);
  });

  it('serves the UI once configured', async () => {
    const response = await start().send({ path: '/' });
    assert.equal(response.status, 200);
    assert.equal(response.body, pages.ui);
  });

  it('hides the setup pages once configured', async () => {
    const { send } = start();
    assertFailure(await send({ path: '/setup' }), 404, 'not_found');
    assertFailure(await send({ path: '/setup/complete' }), 404, 'not_found');
  });
});

describe('session', () => {
  it('rejects /api/me without a cookie', async () => {
    const response = await start().send({ path: '/api/me' });
    assertFailure(response, 401, 'unauthenticated');
    assertBaseHeaders(response);
  });

  it('returns the login and avatar, never the token, with a session', async () => {
    const { send, calls } = start();
    const response = await send({ path: '/api/me', headers: authenticated() });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      login: user.login,
      avatar: user.avatar,
    });
    assert.ok(!response.body.includes(user.token));
    assert.equal(calls.length, 0);
  });

  it('finds the session among other cookies', async () => {
    const response = await start().send({
      path: '/api/me',
      headers: { cookie: `theme=dark; ${sessionCookie(user)}; other=1` },
    });
    assert.equal(response.status, 200);
  });

  it('rejects an expired session', async () => {
    const issued = Date.now() - (SESSION_AGE * 1000 + 1000);
    const response = await start().send({
      path: '/api/me',
      headers: { cookie: sessionCookie(user, issued) },
    });
    assertFailure(response, 401, 'unauthenticated');
  });

  it('accepts a session inside its lifetime', async () => {
    const issued = Date.now() - (SESSION_AGE * 1000 - 60_000);
    const response = await start().send({
      path: '/api/me',
      headers: { cookie: sessionCookie(user, issued) },
    });
    assert.equal(response.status, 200);
  });

  it('rejects sessions without a string login and token', async () => {
    const { send } = start();
    const payloads = [
      { login: 'a', token: 5 },
      { login: 'a' },
      { token: 'gho_token' },
      { login: 5, token: 'gho_token' },
      { login: null, token: null },
    ];
    for (const payload of payloads) {
      const response = await send({
        path: '/api/me',
        headers: { cookie: sessionCookie(payload) },
      });
      assertFailure(response, 401, 'unauthenticated');
    }
  });

  it('never authenticates /api/* with a state-only cookie', async () => {
    const { send, calls } = start();
    const cookie = sessionCookie({ state: 'a'.repeat(32) });
    for (const path of [
      '/api/me',
      '/api/repositories',
      '/api/organizations',
      '/api/organizations/appwrite',
    ]) {
      assertFailure(
        await send({ path, headers: { cookie } }),
        401,
        'unauthenticated',
      );
    }
    assertFailure(
      await send({
        method: 'PUT',
        path: '/api/repositories/abnegate/edge/config',
        headers: { cookie, origin: url },
        bodyText: '{"review":true}',
      }),
      401,
      'unauthenticated',
    );
    assert.equal(calls.length, 0);
  });

  it('rejects a tampered session', async () => {
    const cookie = sessionCookie(user);
    const last = cookie.at(-2);
    const tampered = `${cookie.slice(0, -2)}${last === 'A' ? 'B' : 'A'}${cookie.at(-1)}`;
    const response = await start().send({
      path: '/api/me',
      headers: { cookie: tampered },
    });
    assertFailure(response, 401, 'unauthenticated');
  });

  it('rejects a session sealed with another key', async () => {
    const value = seal({ ...user, issued: Date.now() }, randomBytes(32));
    const response = await start().send({
      path: '/api/me',
      headers: { cookie: `${COOKIE}=${value}` },
    });
    assertFailure(response, 401, 'unauthenticated');
  });

  it('rejects a garbage session', async () => {
    const { send } = start();
    for (const value of ['', 'garbage', '%%%', 'a'.repeat(200)]) {
      assertFailure(
        await send({
          path: '/api/me',
          headers: { cookie: `${COOKIE}=${value}` },
        }),
        401,
        'unauthenticated',
      );
    }
  });
});

describe('request gates', () => {
  const put = {
    method: 'PUT',
    path: '/api/repositories/abnegate/edge/config',
    bodyText: '{"review":true}',
  };

  it('rejects writes without an origin', async () => {
    const { send, calls } = start();
    const response = await send({ ...put, headers: authenticated() });
    assertFailure(response, 403, 'origin');
    assertBaseHeaders(response);
    assert.equal(calls.length, 0);
  });

  it('rejects writes from another origin', async () => {
    const { send, calls } = start();
    for (const origin of [
      'https://evil.test',
      'https://ureview.test.evil.test',
      'http://ureview.test',
      `${url}/`,
      'null',
    ]) {
      assertFailure(
        await send({ ...put, headers: authenticated({ origin }) }),
        403,
        'origin',
      );
    }
    assert.equal(calls.length, 0);
  });

  it('checks the origin on every non-GET method', async () => {
    const { send } = start();
    const requests = [
      { method: 'POST', path: '/auth/logout' },
      { method: 'DELETE', path: '/api/repositories/abnegate/edge' },
      {
        method: 'PUT',
        path: '/api/repositories/abnegate/edge/tokens',
        bodyText: '{"oauth":"token"}',
      },
      { method: 'PUT', path: '/api/organizations/appwrite/config' },
      { method: 'DELETE', path: '/api/organizations/appwrite' },
    ];
    for (const request of requests) {
      assertFailure(
        await send({ ...request, headers: authenticated() }),
        403,
        'origin',
      );
    }
  });

  it('checks the origin before the session', async () => {
    const response = await start().send({
      ...put,
      headers: { origin: 'https://evil.test' },
    });
    assertFailure(response, 403, 'origin');
  });

  it('requires a session on writes with a valid origin', async () => {
    const response = await start().send({ ...put, headers: { origin: url } });
    assertFailure(response, 401, 'unauthenticated');
  });

  it('rejects invalid JSON bodies before calling GitHub', async () => {
    const { send, calls } = start();
    for (const path of [
      '/api/repositories/abnegate/edge/config',
      '/api/repositories/abnegate/edge/tokens',
      '/api/organizations/appwrite/config',
      '/api/organizations/appwrite/tokens',
    ]) {
      const response = await send({
        method: 'PUT',
        path,
        headers: writing(),
        bodyText: '{"review":',
      });
      assertFailure(response, 400, 'invalid_json');
    }
    assert.equal(calls.length, 0);
  });

  it('returns 404 for unknown routes', async () => {
    const { send, calls } = start();
    assertFailure(await send({ path: '/nope' }), 404, 'not_found');
    assertFailure(
      await send({ path: '/api/nope', headers: authenticated() }),
      404,
      'not_found',
    );
    assertFailure(
      await send({
        path: '/api/repositories/abnegate/edge/config',
        headers: authenticated(),
      }),
      404,
      'not_found',
    );
    assertFailure(
      await send({
        method: 'PUT',
        path: '/api/repositories/abnegate/edge/secrets',
        headers: writing(),
        bodyText: '{}',
      }),
      404,
      'not_found',
    );
    assert.equal(calls.length, 0);
  });

  it('returns 404 for invalid route params before calling GitHub', async () => {
    const { send, calls } = start();
    const requests = [
      { method: 'PUT', path: '/api/repositories/bad!owner/edge/config' },
      { method: 'PUT', path: '/api/repositories/bad_owner/edge/config' },
      {
        method: 'PUT',
        path: `/api/repositories/${'a'.repeat(40)}/edge/config`,
      },
      { method: 'PUT', path: '/api/repositories/abnegate/bad repo/config' },
      {
        method: 'PUT',
        path: `/api/repositories/abnegate/${'a'.repeat(101)}/config`,
      },
      { method: 'PUT', path: '/api/repositories/abnegate/edge/extra/config' },
      { method: 'PUT', path: '/api/repositories/abnegate//tokens' },
      { method: 'DELETE', path: '/api/repositories/abnegate/bad%2Frepo' },
      { method: 'GET', path: '/api/organizations/bad.org' },
      { method: 'PUT', path: '/api/organizations/bad_org/config' },
      { method: 'DELETE', path: `/api/organizations/${'a'.repeat(40)}` },
    ];
    for (const request of requests) {
      const response = await send({
        ...request,
        headers: writing(),
        bodyText: '{}',
      });
      assertFailure(response, 404, 'not_found');
    }
    assert.equal(calls.length, 0);
  });
});

describe('error mapping', () => {
  const tokens = {
    oauth: 'sk-ant-oat01-oauth-marker',
    push: 'github_pat_push_marker',
  };

  function assertNothingLeaked({ logs, errors }, markers) {
    const logged = JSON.stringify([logs, errors]);
    for (const marker of markers) {
      assert.ok(!logged.includes(marker), `logged ${marker}`);
    }
  }

  it('maps a GitHub 401 to 401 and clears the cookie', async () => {
    const { send } = start({
      routes: { 'GET /user/installations': { status: 401, data: {} } },
    });
    const response = await send({
      path: '/api/repositories',
      headers: authenticated(),
    });
    assertFailure(response, 401, 'unauthenticated');
    assert.equal(assertSingleCookie(response), clearCookie());
    assertBaseHeaders(response);
  });

  it('maps a GitHub 500 to 502 and reports the failure', async () => {
    const context = start({
      routes: {
        'GET /user/installations': { status: 500, data: { message: 'boom' } },
      },
    });
    const response = await context.send({
      path: '/api/repositories',
      headers: authenticated(),
    });
    assertFailure(response, 502, 'github');
    assert.equal(header(response, 'set-cookie'), undefined);
    assert.ok(
      context.errors.some((values) => values.join(' ').includes('500')),
      'expected the error callback to receive the GitHub failure',
    );
    assertNothingLeaked(context, [user.token]);
  });

  it('never logs tokens or request bodies when a write fails upstream', async () => {
    const bodyText = JSON.stringify(tokens);
    const context = start({
      routes: {
        'GET /repos/abnegate/edge': { status: 500, data: { message: 'boom' } },
      },
    });
    const response = await context.send({
      method: 'PUT',
      path: '/api/repositories/abnegate/edge/tokens',
      headers: writing(),
      bodyText,
    });
    assertFailure(response, 502, 'github');
    assert.ok(context.errors.length > 0);
    assertNothingLeaked(context, [
      user.token,
      tokens.oauth,
      tokens.push,
      bodyText,
    ]);
  });

  it('maps a denied push gate to 403 forbidden', async () => {
    const { send, calls } = start({
      routes: {
        'GET /repos/abnegate/edge': {
          data: { full_name: 'abnegate/edge', permissions: { push: false } },
        },
      },
    });
    const response = await send({
      method: 'PUT',
      path: '/api/repositories/abnegate/edge/config',
      headers: writing(),
      bodyText: '{"review":true}',
    });
    assertFailure(response, 403, 'forbidden');
    assert.deepEqual(
      calls.map((call) => call.key),
      ['GET /repos/abnegate/edge'],
    );
  });

  it('maps a GitHub 404 to 404 not_found', async () => {
    const response = await start({
      routes: { 'GET /repos/abnegate/edge': NOT_FOUND },
    }).send({
      method: 'PUT',
      path: '/api/repositories/abnegate/edge/config',
      headers: writing(),
      bodyText: '{"review":true}',
    });
    assertFailure(response, 404, 'not_found');
  });
});

describe('content security policy', () => {
  const script = "\n  document.title = 'ready';\n";
  const scripted = {
    ...pages,
    ui: `<!doctype html><title>ui</title><script type="module">${script}</script><script>${script}</script>`,
    manifest: `<!doctype html><script>one()</script><p></p><script>two()</script>`,
  };
  const hash = (content) =>
    `'sha256-${createHash('sha256').update(content).digest('base64')}'`;

  function scriptSource(response) {
    return header(response, 'content-security-policy')
      .split('; ')
      .find((directive) => directive.startsWith('script-src '));
  }

  it('allows exactly the inline scripts of the page by hash', async () => {
    const response = await start({ documents: scripted }).send({ path: '/' });
    assert.equal(scriptSource(response), `script-src ${hash(script)}`);
    assert.ok(!scriptSource(response).includes("'unsafe-inline'"));
    assert.equal(
      header(response, 'content-security-policy'),
      policy("'self'", hash(script)),
    );
  });

  it('hashes every script of a page with several', async () => {
    const response = await start({
      configuration: Environment.from({}),
      documents: scripted,
    }).send({ path: '/setup' });
    assert.equal(
      scriptSource(response),
      `script-src ${hash('one()')} ${hash('two()')}`,
    );
  });

  it('allows no script on a page without one', async () => {
    const response = await start().send({ path: '/' });
    assert.equal(scriptSource(response), "script-src 'none'");
  });
});

describe('referrer policy', () => {
  it('sends same-origin on the UI, the manifest and JSON', async () => {
    const unconfigured = start({ configuration: Environment.from({}) });
    assertBaseHeaders(await start().send({ path: '/' }));
    assertBaseHeaders(await unconfigured.send({ path: '/setup' }));
    assertBaseHeaders(
      await start().send({ path: '/api/me', headers: authenticated() }),
    );
    assertBaseHeaders(await start().send({ path: '/nope' }));
  });

  it('sends no-referrer on the created page, which carries App secrets', async () => {
    const response = await start({
      configuration: Environment.from({}),
    }).send({ path: '/setup/complete' });
    assertBaseHeaders(response, 'no-referrer');
  });
});

describe('HEAD and OPTIONS', () => {
  it('answers HEAD like GET without a body', async () => {
    const { send } = start();
    const get = await send({ path: '/' });
    const head = await send({ method: 'HEAD', path: '/' });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    assert.deepEqual(head.headers, get.headers);
  });

  it('answers HEAD on an API route without the origin gate', async () => {
    const { send } = start();
    const head = await send({
      method: 'HEAD',
      path: '/api/me',
      headers: authenticated(),
    });
    assert.equal(head.status, 200);
    assert.equal(head.body, '');
    const refused = await send({ method: 'HEAD', path: '/api/me' });
    assert.equal(refused.status, 401);
    assert.equal(refused.body, '');
  });

  it('lists the allowed methods on OPTIONS without the origin gate', async () => {
    const { send, calls } = start();
    const cases = [
      ['/', 'GET, HEAD, OPTIONS'],
      ['/auth/logout', 'POST, OPTIONS'],
      ['/api/repositories/abnegate/edge', 'GET, DELETE, HEAD, OPTIONS'],
      ['/api/organizations/appwrite/config', 'PUT, OPTIONS'],
    ];
    for (const [path, allow] of cases) {
      const response = await send({ method: 'OPTIONS', path });
      assert.equal(response.status, 204, path);
      assert.equal(response.body, '');
      assert.equal(header(response, 'allow'), allow, path);
    }
    assert.equal(calls.length, 0);
  });

  it('answers OPTIONS on an unknown route with 404', async () => {
    const response = await start().send({ method: 'OPTIONS', path: '/nope' });
    assertFailure(response, 404, 'not_found');
  });

  it('still refuses OPTIONS while unconfigured', async () => {
    const response = await start({
      configuration: Environment.from({}),
    }).send({ method: 'OPTIONS', path: '/api/me' });
    assertFailure(response, 503, 'unconfigured');
  });
});

describe('App and rate limit errors', () => {
  const pushable = {
    'GET /repos/abnegate/edge': {
      data: {
        name: 'edge',
        full_name: 'abnegate/edge',
        owner: { login: 'abnegate', type: 'User' },
        permissions: { push: true },
      },
    },
  };
  const put = {
    method: 'PUT',
    path: '/api/repositories/abnegate/edge/config',
    headers: writing(),
    bodyText: '{"review":true}',
  };

  function assertAppFailure(context, response, path) {
    assertFailure(response, 502, 'github_app');
    assert.equal(header(response, 'set-cookie'), undefined);
    assert.ok(
      context.errors.some((values) => values.join(' ').includes(`401`)),
      'expected the App failure to be reported',
    );
    assert.ok(
      context.errors.some((values) => values.join(' ').includes(path)),
      `expected ${path} to be reported`,
    );
    const logged = JSON.stringify([context.logs, context.errors]);
    assert.ok(!logged.includes(user.token));
    assert.ok(!logged.includes('Bearer'));
  }

  it('maps a rejected installation lookup to 502 github_app and keeps the session', async () => {
    const context = start({
      routes: {
        ...pushable,
        'GET /repos/abnegate/edge/installation': {
          status: 401,
          data: { message: 'A JSON web token could not be decoded' },
        },
      },
    });
    const response = await context.send(put);
    assertAppFailure(context, response, '/repos/abnegate/edge/installation');
  });

  it('maps a rejected installation token mint to 502 github_app', async () => {
    const context = start({
      routes: {
        ...pushable,
        'GET /repos/abnegate/edge/installation': { data: { id: 42 } },
        'POST /app/installations/42/access_tokens': {
          status: 401,
          data: { message: 'Bad credentials' },
        },
      },
    });
    const response = await context.send(put);
    assertAppFailure(context, response, '/app/installations/42/access_tokens');
  });

  it('maps a rejected installation token on a settings read to 502 github_app', async () => {
    const base = 'GET /repos/abnegate/edge/actions';
    const context = start({
      routes: {
        ...pushable,
        'GET /repos/abnegate/edge/installation': { data: { id: 42 } },
        'POST /app/installations/42/access_tokens': {
          status: 201,
          data: { token: 'ghs_read' },
        },
        [`${base}/variables/UREVIEW_ABNEGATE`]: {
          status: 401,
          data: { message: 'Bad credentials' },
        },
        [`${base}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: NOT_FOUND,
        [`${base}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: NOT_FOUND,
      },
    });
    const response = await context.send({
      path: '/api/repositories/abnegate/edge',
      headers: authenticated(),
    });
    assertAppFailure(
      context,
      response,
      '/repos/abnegate/edge/actions/variables/UREVIEW_ABNEGATE',
    );
  });

  it('still clears the session when the user token is rejected', async () => {
    const response = await start({
      routes: {
        'GET /repos/abnegate/edge': {
          status: 401,
          data: { message: 'Bad credentials' },
        },
      },
    }).send(put);
    assertFailure(response, 401, 'unauthenticated');
    assert.equal(assertSingleCookie(response), clearCookie());
  });

  for (const status of [403, 429]) {
    it(`maps a ${status} with retry-after to 429 rate_limited`, async () => {
      const response = await start({
        routes: {
          'GET /user/installations': {
            status,
            data: { message: 'You have exceeded a secondary rate limit.' },
            headers: { 'retry-after': '60' },
          },
        },
      }).send({ path: '/api/repositories', headers: authenticated() });
      assertFailure(response, 429, 'rate_limited');
      assert.deepEqual(JSON.parse(response.body), {
        error: 'rate_limited',
        retryAfter: 60,
      });
      assert.equal(header(response, 'retry-after'), '60');
      assert.equal(header(response, 'set-cookie'), undefined);
    });
  }

  it('derives retryAfter from the rate limit reset when no requests remain', async () => {
    const now = 1_700_000_000_000;
    const response = await start({
      now: () => now,
      routes: {
        'GET /repos/abnegate/edge': {
          status: 403,
          data: { message: 'API rate limit exceeded' },
          headers: {
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(now / 1000 + 90),
          },
        },
      },
    }).send(put);
    assertFailure(response, 429, 'rate_limited');
    assert.equal(JSON.parse(response.body).retryAfter, 90);
    assert.equal(header(response, 'retry-after'), '90');
  });

  it('maps a rate limit without timing headers to 429 without retryAfter', async () => {
    const response = await start({
      routes: {
        'GET /repos/abnegate/edge': {
          status: 429,
          data: { message: 'Too many requests' },
          headers: { 'x-ratelimit-remaining': '0' },
        },
      },
    }).send(put);
    assertFailure(response, 429, 'rate_limited');
    assert.deepEqual(JSON.parse(response.body), { error: 'rate_limited' });
    assert.equal(header(response, 'retry-after'), undefined);
  });

  it('keeps a plain 403 without rate limit headers as forbidden', async () => {
    const response = await start({
      routes: {
        'GET /repos/abnegate/edge': {
          status: 403,
          data: { message: 'Forbidden' },
          headers: { 'x-ratelimit-remaining': '4999' },
        },
      },
    }).send(put);
    assertFailure(response, 403, 'forbidden');
  });
});
