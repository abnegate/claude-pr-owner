import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import {
  clearCookie,
  COOKIE,
  open,
  SESSION_AGE,
  setCookie,
  STATE_AGE,
} from '../src/session.js';
import { mockFetch } from './support/fetch.js';
import {
  environment,
  pages,
  sessionCookie,
  sessionKey,
  url,
} from './support/fixtures.js';

const exchangeKey = 'POST https://github.com/login/oauth/access_token';
const accessToken = 'gho_access_token_marker';
const code = 'code_marker_1234';
const profile = {
  login: 'abnegate',
  id: 1,
  avatar_url: 'https://avatars.githubusercontent.com/u/1',
};

function start({ routes = {}, configuration = environment(), now } = {}) {
  const { fetch, calls } = mockFetch(routes);
  const logs = [];
  const errors = [];
  const options = { environment: configuration, fetch, pages };
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

const signedIn = {
  [exchangeKey]: { data: { access_token: accessToken, token_type: 'bearer' } },
  'GET /user': { data: profile },
};

function header(response, name) {
  const matches = Object.keys(response.headers).filter(
    (key) => key.toLowerCase() === name,
  );
  assert.ok(matches.length <= 1, `expected at most one ${name} header`);
  return matches.length === 0 ? undefined : response.headers[matches[0]];
}

function cookieValue(response) {
  const value = header(response, 'set-cookie');
  assert.equal(typeof value, 'string', 'expected one set-cookie string');
  assert.equal(value.split(`${COOKIE}=`).length, 2, 'expected one cookie');
  assert.ok(value.startsWith(`${COOKIE}=`));
  return value.slice(`${COOKIE}=`.length).split(';')[0];
}

function assertInvalid(response) {
  assert.equal(response.status, 400);
  assert.equal(JSON.parse(response.body).error, 'invalid');
}

async function login(send) {
  const response = await send({ path: '/auth/login' });
  const value = cookieValue(response);
  const location = new URL(header(response, 'location'));
  return {
    response,
    value,
    location,
    state: location.searchParams.get('state'),
    cookie: `${COOKIE}=${value}`,
  };
}

describe('/auth/login', () => {
  it('redirects to the GitHub authorize page', async () => {
    const { send, calls } = start();
    const { response, location } = await login(send);
    assert.equal(response.status, 302);
    assert.equal(location.protocol, 'https:');
    assert.equal(location.host, 'github.com');
    assert.equal(location.pathname, '/login/oauth/authorize');
    assert.equal(location.searchParams.get('client_id'), 'Iv1.client');
    assert.equal(
      location.searchParams.get('redirect_uri'),
      'https://ureview.test/auth/callback',
    );
    assert.match(location.searchParams.get('state'), /^[0-9a-f]{32}$/);
    assert.deepEqual([...location.searchParams.keys()].sort(), [
      'client_id',
      'redirect_uri',
      'state',
    ]);
    assert.equal(header(response, 'referrer-policy'), 'same-origin');
    assert.equal(header(response, 'x-content-type-options'), 'nosniff');
    assert.equal(calls.length, 0);
  });

  it('sets exactly one state cookie with the session attributes', async () => {
    const { send } = start();
    const { response, value } = await login(send);
    const cookie = header(response, 'set-cookie');
    assert.equal(cookie, setCookie(value, STATE_AGE));
    const attributes = cookie.split('; ').slice(1);
    for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/']) {
      assert.ok(attributes.includes(attribute), `missing ${attribute}`);
    }
    assert.ok(attributes.includes(`Max-Age=${STATE_AGE}`));
  });

  it('seals the state and the issue time from now()', async () => {
    const issued = Date.now() - 5000;
    const { send } = start({ now: () => issued });
    const { value, state } = await login(send);
    const payload = open(value, sessionKey, STATE_AGE, issued);
    assert.deepEqual(payload, { state, issued });
  });

  it('generates a fresh state for every login', async () => {
    const { send } = start();
    const first = await login(send);
    const second = await login(send);
    assert.notEqual(first.state, second.state);
  });

  it('builds the redirect URI from a public URL with a trailing slash', async () => {
    const { send } = start({
      configuration: environment({ PUBLIC_URL: 'https://ureview.test/' }),
    });
    const { location } = await login(send);
    assert.equal(
      location.searchParams.get('redirect_uri'),
      'https://ureview.test/auth/callback',
    );
  });
});

describe('/auth/callback', () => {
  it('exchanges the code, stores the session and redirects home', async () => {
    const context = start({ routes: signedIn });
    const { state, cookie } = await login(context.send);
    const response = await context.send({
      path: '/auth/callback',
      query: { code, state },
      headers: { cookie },
    });
    assert.equal(response.status, 302);
    assert.equal(header(response, 'location'), '/');
    const value = cookieValue(response);
    assert.equal(header(response, 'set-cookie'), setCookie(value, SESSION_AGE));
    const payload = open(value, sessionKey, SESSION_AGE);
    assert.equal(typeof payload.issued, 'number');
    assert.deepEqual(
      { login: payload.login, token: payload.token, avatar: payload.avatar },
      { login: 'abnegate', token: accessToken, avatar: profile.avatar_url },
    );
    assert.equal(payload.state, undefined);

    assert.deepEqual(
      context.calls.map((call) => call.key),
      [exchangeKey, 'GET /user'],
    );
    const [exchange, identity] = context.calls;
    assert.deepEqual(exchange.body, {
      client_id: 'Iv1.client',
      client_secret: 'client-secret',
      code,
      redirect_uri: 'https://ureview.test/auth/callback',
    });
    assert.equal(exchange.headers.get('accept'), 'application/json');
    assert.equal(
      identity.headers.get('authorization'),
      `Bearer ${accessToken}`,
    );

    const me = await context.send({
      path: '/api/me',
      headers: { cookie: `${COOKIE}=${value}` },
    });
    assert.equal(me.status, 200);
    assert.deepEqual(JSON.parse(me.body), {
      login: 'abnegate',
      avatar: profile.avatar_url,
    });
  });

  it('decodes query values before exchanging the code', async () => {
    const context = start({ routes: signedIn });
    const { state, cookie } = await login(context.send);
    const response = await context.send({
      path: '/auth/callback',
      query: { code: 'abc%2Fdef', state },
      headers: { cookie },
    });
    assert.equal(response.status, 302);
    assert.equal(context.calls[0].body.code, 'abc/def');
  });

  it('accepts a state cookie inside its lifetime', async () => {
    const { send } = start({ routes: signedIn });
    const state = 'c'.repeat(32);
    const issued = Date.now() - (STATE_AGE * 1000 - 30_000);
    const response = await send({
      path: '/auth/callback',
      query: { code, state },
      headers: { cookie: sessionCookie({ state }, issued) },
    });
    assert.equal(response.status, 302);
  });

  it('rejects a state mismatch without calling GitHub', async () => {
    const { send, calls } = start({ routes: signedIn });
    const { state, cookie } = await login(send);
    const other = state.replace(/^./, state[0] === 'a' ? 'b' : 'a');
    assertInvalid(
      await send({
        path: '/auth/callback',
        query: { code, state: other },
        headers: { cookie },
      }),
    );
    assert.equal(calls.length, 0);
  });

  it('rejects a state of a different length', async () => {
    const { send, calls } = start({ routes: signedIn });
    const { state, cookie } = await login(send);
    for (const candidate of [state.slice(1), `${state}0`, '']) {
      assertInvalid(
        await send({
          path: '/auth/callback',
          query: { code, state: candidate },
          headers: { cookie },
        }),
      );
    }
    assert.equal(calls.length, 0);
  });

  it('rejects a callback without a state or a cookie', async () => {
    const { send, calls } = start({ routes: signedIn });
    const { state, cookie } = await login(send);
    assertInvalid(
      await send({
        path: '/auth/callback',
        query: { code },
        headers: { cookie },
      }),
    );
    assertInvalid(
      await send({ path: '/auth/callback', query: { code, state } }),
    );
    assert.equal(calls.length, 0);
  });

  it('rejects a state cookie older than ten minutes', async () => {
    const { send, calls } = start({ routes: signedIn });
    const state = 'd'.repeat(32);
    const issued = Date.now() - (STATE_AGE * 1000 + 1000);
    assertInvalid(
      await send({
        path: '/auth/callback',
        query: { code, state },
        headers: { cookie: sessionCookie({ state }, issued) },
      }),
    );
    assert.equal(calls.length, 0);
  });

  it('rejects a cookie whose state is not a string', async () => {
    const { send, calls } = start({ routes: signedIn });
    for (const state of [1234, null, ['1234'], { value: '1234' }]) {
      assertInvalid(
        await send({
          path: '/auth/callback',
          query: { code, state: '1234' },
          headers: { cookie: sessionCookie({ state }) },
        }),
      );
    }
    assert.equal(calls.length, 0);
  });

  it('rejects a signed-in session cookie in place of a state cookie', async () => {
    const { send, calls } = start({ routes: signedIn });
    const cookie = sessionCookie({
      login: 'abnegate',
      token: 'gho_token',
      avatar: profile.avatar_url,
    });
    assertInvalid(
      await send({
        path: '/auth/callback',
        query: { code, state: 'e'.repeat(32) },
        headers: { cookie },
      }),
    );
    assert.equal(calls.length, 0);
  });

  it('maps a refused code exchange to 502 without logging secrets', async () => {
    const context = start({
      routes: {
        [exchangeKey]: {
          data: {
            error: 'bad_verification_code',
            error_description: 'The code passed is incorrect or expired.',
          },
        },
        'GET /user': { data: profile },
      },
    });
    const { state, cookie } = await login(context.send);
    const response = await context.send({
      path: '/auth/callback',
      query: { code, state },
      headers: { cookie },
    });
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.body).error, 'github');
    assert.deepEqual(
      context.calls.map((call) => call.key),
      [exchangeKey],
    );
    const logged = JSON.stringify([context.logs, context.errors]);
    for (const marker of [code, 'client-secret', state]) {
      assert.ok(!logged.includes(marker), `logged ${marker}`);
    }
  });

  it('maps a failed user lookup to 502 without logging the token', async () => {
    const context = start({
      routes: {
        [exchangeKey]: signedIn[exchangeKey],
        'GET /user': { status: 500, data: { message: 'boom' } },
      },
    });
    const { state, cookie } = await login(context.send);
    const response = await context.send({
      path: '/auth/callback',
      query: { code, state },
      headers: { cookie },
    });
    assert.equal(response.status, 502);
    assert.equal(JSON.parse(response.body).error, 'github');
    assert.ok(context.errors.length > 0);
    const logged = JSON.stringify([context.logs, context.errors]);
    for (const marker of [accessToken, code, 'client-secret']) {
      assert.ok(!logged.includes(marker), `logged ${marker}`);
    }
  });

  it('sends a cancelled sign-in home and clears only the pending state cookie', async () => {
    const { send, calls } = start({ routes: signedIn });
    const { state, cookie } = await login(send);
    const cancellations = [
      { error: 'access_denied', state },
      { error: 'access_denied', code, state },
      { state },
      { code: '', state },
    ];
    for (const query of cancellations) {
      const response = await send({
        path: '/auth/callback',
        query,
        headers: { cookie },
      });
      assert.equal(response.status, 302, JSON.stringify(query));
      assert.equal(header(response, 'location'), '/?signin=cancelled');
      assert.equal(header(response, 'set-cookie'), clearCookie());
    }
    assert.equal(calls.length, 0);
  });

  it('keeps a signed-in session when a stray cancelled callback arrives', async () => {
    const { send, calls } = start({ routes: signedIn });
    const cookie = sessionCookie({
      login: 'abnegate',
      token: 'gho_token',
      avatar: profile.avatar_url,
    });
    for (const headers of [{ cookie }, {}]) {
      const response = await send({
        path: '/auth/callback',
        query: { error: 'access_denied' },
        headers,
      });
      assert.equal(response.status, 302);
      assert.equal(header(response, 'location'), '/?signin=cancelled');
      assert.equal(header(response, 'set-cookie'), undefined);
    }
    assert.equal(calls.length, 0);
  });

  it('maps a revoked token on user lookup to 401 and clears the cookie', async () => {
    const context = start({
      routes: {
        [exchangeKey]: signedIn[exchangeKey],
        'GET /user': { status: 401, data: { message: 'Bad credentials' } },
      },
    });
    const { state, cookie } = await login(context.send);
    const response = await context.send({
      path: '/auth/callback',
      query: { code, state },
      headers: { cookie },
    });
    assert.equal(response.status, 401);
    assert.equal(JSON.parse(response.body).error, 'unauthenticated');
    assert.equal(header(response, 'set-cookie'), clearCookie());
  });
});

describe('/auth/logout', () => {
  const revokeKey = 'DELETE /applications/Iv1.client/token';

  it('clears the cookie with exactly one set-cookie', async () => {
    const { send } = start({ routes: { [revokeKey]: { status: 204 } } });
    const response = await send({
      method: 'POST',
      path: '/auth/logout',
      headers: {
        origin: url,
        cookie: sessionCookie({ login: 'abnegate', token: 'gho_token' }),
      },
    });
    assert.equal(response.status, 204);
    assert.equal(response.body, '');
    assert.equal(cookieValue(response), '');
    assert.equal(header(response, 'set-cookie'), clearCookie());
    assert.ok(header(response, 'set-cookie').endsWith('Max-Age=0'));
    assert.equal(header(response, 'referrer-policy'), 'same-origin');
  });

  it('revokes the user token with the App client credentials', async () => {
    const { send, calls } = start({
      routes: { [revokeKey]: { status: 204 } },
    });
    await send({
      method: 'POST',
      path: '/auth/logout',
      headers: {
        origin: url,
        cookie: sessionCookie({ login: 'abnegate', token: 'gho_token' }),
      },
    });
    assert.deepEqual(
      calls.map((call) => call.key),
      [revokeKey],
    );
    assert.equal(
      calls[0].headers.get('authorization'),
      `Basic ${Buffer.from('Iv1.client:client-secret').toString('base64')}`,
    );
    assert.deepEqual(calls[0].body, { access_token: 'gho_token' });
  });

  it('logs out even when revoking the token fails', async () => {
    const failures = [
      { [revokeKey]: { status: 500, data: { message: 'boom' } } },
      {
        [revokeKey]: () => {
          throw new TypeError('fetch failed');
        },
      },
    ];
    for (const routes of failures) {
      const { send, calls } = start({ routes });
      const response = await send({
        method: 'POST',
        path: '/auth/logout',
        headers: {
          origin: url,
          cookie: sessionCookie({ login: 'abnegate', token: 'gho_token' }),
        },
      });
      assert.equal(response.status, 204);
      assert.equal(header(response, 'set-cookie'), clearCookie());
      assert.equal(calls.length, 1);
    }
  });

  it('logs out without a session and revokes nothing', async () => {
    const { send, calls } = start();
    const response = await send({
      method: 'POST',
      path: '/auth/logout',
      headers: { origin: url },
    });
    assert.equal(response.status, 204);
    assert.equal(header(response, 'set-cookie'), clearCookie());
    assert.equal(calls.length, 0);
  });

  it('only accepts POST', async () => {
    const response = await start().send({ path: '/auth/logout' });
    assert.equal(response.status, 404);
    assert.equal(header(response, 'set-cookie'), undefined);
  });
});
