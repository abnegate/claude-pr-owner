import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createApp } from '../src/app.js';
import { Environment } from '../src/Environment.js';
import { adapt } from '../src/main.js';
import { COOKIE, STATE_AGE, setCookie } from '../src/session.js';
import { mockFetch } from './support/fetch.js';
import { environment, pages } from './support/fixtures.js';

function response() {
  const sent = [];
  const result = Symbol('sent');
  return {
    sent,
    result,
    res: {
      text: (...values) => {
        sent.push(values);
        return result;
      },
    },
  };
}

describe('adapt', () => {
  it('forwards the request and callbacks and sends the response as text', async () => {
    const received = [];
    const app = async (...values) => {
      received.push(values);
      return {
        status: 201,
        headers: { 'x-ureview': 'yes', 'set-cookie': 'a=b' },
        body: '{"ok":true}',
      };
    };
    const log = () => {};
    const error = () => {};
    const { sent, result, res } = response();
    const request = {
      method: 'PUT',
      path: '/api/repositories/abnegate/edge/config',
      query: { a: '1' },
      headers: { origin: 'https://ureview.test' },
      bodyText: '{"review":true}',
      bodyJson: { review: true },
      host: 'internal',
    };

    const returned = await adapt(app)({ req: request, res, log, error });

    assert.equal(returned, result);
    assert.equal(received.length, 1);
    const [forwarded, callbacks] = received[0];
    assert.deepEqual(forwarded, {
      method: 'PUT',
      path: '/api/repositories/abnegate/edge/config',
      query: { a: '1' },
      headers: { origin: 'https://ureview.test' },
      bodyText: '{"review":true}',
    });
    assert.equal(callbacks.log, log);
    assert.equal(callbacks.error, error);
    assert.deepEqual(sent, [
      ['{"ok":true}', 201, { 'x-ureview': 'yes', 'set-cookie': 'a=b' }],
    ]);
  });

  it('defaults a missing query, headers and body', async () => {
    const received = [];
    const app = async (request) => {
      received.push(request);
      return { status: 204, headers: {}, body: '' };
    };
    const { sent, res } = response();

    await adapt(app)({
      req: { method: 'GET', path: '/' },
      res,
      log: () => {},
      error: () => {},
    });

    assert.deepEqual(received, [
      { method: 'GET', path: '/', query: {}, headers: {}, bodyText: '' },
    ]);
    assert.deepEqual(sent, [['', 204, {}]]);
  });

  it('serves the app through the runtime response', async () => {
    const { fetch } = mockFetch();
    const handler = adapt(
      createApp({ environment: environment(), fetch, pages }),
    );
    const { sent, res } = response();

    await handler({
      req: { method: 'GET', path: '/', query: {}, headers: {}, bodyText: '' },
      res,
      log: () => {},
      error: () => {},
    });

    assert.equal(sent.length, 1);
    const [body, status, headers] = sent[0];
    assert.equal(body, pages.ui);
    assert.equal(status, 200);
    assert.equal(headers['content-type'], 'text/html; charset=utf-8');
  });

  it('passes the redirect location and cookie through text()', async () => {
    const { fetch } = mockFetch();
    const handler = adapt(
      createApp({ environment: environment(), fetch, pages }),
    );
    const { sent, res } = response();

    await handler({
      req: { method: 'GET', path: '/auth/login', query: {}, headers: {} },
      res,
      log: () => {},
      error: () => {},
    });

    const [body, status, headers] = sent[0];
    assert.equal(status, 302);
    assert.equal(body, '');
    assert.equal(new URL(headers.location).pathname, '/login/oauth/authorize');
    const value = headers['set-cookie']
      .slice(`${COOKIE}=`.length)
      .split(';')[0];
    assert.equal(headers['set-cookie'], setCookie(value, STATE_AGE));
  });

  it('passes the unconfigured refusal through text()', async () => {
    const { fetch, calls } = mockFetch();
    const handler = adapt(
      createApp({ environment: Environment.from({}), fetch, pages }),
    );
    const { sent, res } = response();

    await handler({
      req: { method: 'GET', path: '/api/me', query: {}, headers: {} },
      res,
      log: () => {},
      error: () => {},
    });

    const [body, status] = sent[0];
    assert.equal(status, 503);
    assert.equal(JSON.parse(body).error, 'unconfigured');
    assert.equal(calls.length, 0);
  });
});

describe('main', () => {
  it('imports without throwing and serves the bundled UI', async () => {
    const module = await import('../src/main.js');
    assert.equal(typeof module.default, 'function');
    const { sent, res } = response();

    await module.default({
      req: { method: 'GET', path: '/', query: {}, headers: {}, bodyText: '' },
      res,
      log: () => {},
      error: () => {},
    });

    const [body, status, headers] = sent[0];
    assert.equal(status, 200);
    assert.equal(
      body,
      readFileSync(new URL('../ui.html', import.meta.url), 'utf8'),
    );
    assert.equal(headers['content-type'], 'text/html; charset=utf-8');
  });
});

describe('bundled pages', () => {
  const served = [
    ['/', 'ui.html', 'same-origin'],
    ['/setup', 'manifest.html', 'same-origin'],
    ['/setup/complete', 'created.html', 'no-referrer'],
  ];

  function inlineScripts(html) {
    return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(
      ([, content]) => content,
    );
  }

  for (const [path, file, referrer] of served) {
    it(`allows exactly the inline scripts of ${file} by hash`, async () => {
      const module = await import('../src/main.js');
      const { sent, res } = response();

      await module.default({
        req: { method: 'GET', path, query: {}, headers: {}, bodyText: '' },
        res,
        log: () => {},
        error: () => {},
      });

      const [body, status, headers] = sent[0];
      assert.equal(status, 200);
      assert.equal(
        body,
        readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'),
      );
      const scripts = inlineScripts(body);
      assert.ok(scripts.length > 0, `${file} has an inline script`);
      const directive = headers['content-security-policy']
        .split('; ')
        .find((entry) => entry.startsWith('script-src '));
      assert.ok(!directive.includes("'unsafe-inline'"), directive);
      const expected = [
        ...new Set(
          scripts.map(
            (script) =>
              `'sha256-${createHash('sha256').update(script).digest('base64')}'`,
          ),
        ),
      ];
      assert.equal(directive, `script-src ${expected.join(' ')}`);
      assert.equal(headers['referrer-policy'], referrer);
    });
  }
});
