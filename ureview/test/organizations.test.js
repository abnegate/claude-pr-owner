import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sodium from 'libsodium-wrappers';
import { createApp } from '../src/app.js';
import { mockFetch, NOT_FOUND } from './support/fetch.js';
import { environment, pages, sessionCookie, url } from './support/fixtures.js';

await sodium.ready;

const USER_TOKEN = 'gho_user';
const keyPair = sodium.crypto_box_keypair();
const organizationKey = sodium.to_base64(
  keyPair.publicKey,
  sodium.base64_variants.ORIGINAL,
);
const ABSENT = { oauth: false, push: false };

function client(routes, { login = 'abnegate' } = {}) {
  const { fetch, calls } = mockFetch(routes);
  const handle = createApp({ environment: environment(), fetch, pages });
  const cookie = sessionCookie({
    login,
    token: USER_TOKEN,
    avatar: 'https://avatars.githubusercontent.com/u/1',
  });
  const send = async (method, path, body) => {
    const response = await handle({
      method,
      path,
      query: {},
      headers: { cookie, origin: url },
      bodyText: body === undefined ? '' : JSON.stringify(body),
    });
    return {
      ...response,
      data: response.body === '' ? null : JSON.parse(response.body),
    };
  };
  return { send, calls };
}

function keys(calls) {
  return calls.map((call) => call.key);
}

function bearer(call) {
  return call.headers.get('authorization');
}

function decrypt(encrypted) {
  return sodium.to_string(
    sodium.crypto_box_seal_open(
      sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
      keyPair.publicKey,
      keyPair.privateKey,
    ),
  );
}

function assertUserTokenOnly(calls) {
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(bearer(call), `Bearer ${USER_TOKEN}`, call.key);
  }
  assert.deepEqual(
    keys(calls).filter((key) => key.includes('/app/')),
    [],
  );
}

function routes({ key = 'ABNEGATE', repositorySelection = 'all' } = {}) {
  const base = '/orgs/appwrite-labs/actions';
  return {
    'GET /user/installations': {
      data: {
        total_count: 5,
        installations: [
          { id: 1, account: { login: 'abnegate', type: 'User' } },
          {
            id: 2,
            account: { login: 'appwrite-labs', type: 'Organization' },
            repository_selection: repositorySelection,
          },
          { id: 3, account: { login: 'other-org', type: 'Organization' } },
          { id: 4, account: { login: 'gone-org', type: 'Organization' } },
          { id: 5, account: { login: 'narrow-org', type: 'Organization' } },
        ],
      },
    },
    'GET /orgs/gone-org/actions/secrets/public-key': NOT_FOUND,
    'GET /orgs/narrow-org/actions/secrets/public-key': {
      status: 403,
      data: { message: 'Resource not accessible by integration' },
      headers: { 'x-accepted-github-permissions': 'secrets=read' },
    },
    [`GET ${base}/secrets/public-key`]: {
      data: { key_id: 'org-key-1', key: organizationKey },
    },
    'GET /orgs/other-org/actions/secrets/public-key': {
      status: 403,
      data: { message: 'Must have admin rights to Repository.' },
    },
    [`GET ${base}/variables/UREVIEW_${key}`]: {
      data: {
        name: `UREVIEW_${key}`,
        value: '{"review":true,"model":"claude-sonnet-4-6"}',
        visibility: 'all',
      },
    },
    [`GET ${base}/secrets/UREVIEW_OAUTH_TOKEN_${key}`]: {
      data: { name: `UREVIEW_OAUTH_TOKEN_${key}`, visibility: 'all' },
    },
    [`GET ${base}/secrets/UREVIEW_PUSH_TOKEN_${key}`]: NOT_FOUND,
    [`PATCH ${base}/variables/UREVIEW_${key}`]: { status: 204 },
    [`POST ${base}/variables`]: { status: 201 },
    [`PUT ${base}/secrets/UREVIEW_OAUTH_TOKEN_${key}`]: { status: 201 },
    [`PUT ${base}/secrets/UREVIEW_PUSH_TOKEN_${key}`]: { status: 204 },
    [`DELETE ${base}/variables/UREVIEW_${key}`]: { status: 204 },
    [`DELETE ${base}/secrets/UREVIEW_OAUTH_TOKEN_${key}`]: { status: 204 },
    [`DELETE ${base}/secrets/UREVIEW_API_KEY_${key}`]: { status: 204 },
    [`DELETE ${base}/secrets/UREVIEW_PUSH_TOKEN_${key}`]: NOT_FOUND,
  };
}

const admin = {
  login: 'appwrite-labs',
  admin: true,
  config: { review: true, model: 'claude-sonnet-4-6' },
  secrets: { oauth: true, push: false },
};

function byLogin(organizations) {
  return [...organizations].sort((a, b) => a.login.localeCompare(b.login));
}

describe('GET /api/organizations', () => {
  test('lists installed organizations with status for admins only', async () => {
    const { send } = client(routes());
    const response = await send('GET', '/api/organizations');

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.data), ['organizations']);
    assert.deepEqual(byLogin(response.data.organizations), [
      admin,
      {
        login: 'gone-org',
        admin: false,
        reason: 'not_admin',
        config: null,
        secrets: ABSENT,
      },
      {
        login: 'narrow-org',
        admin: false,
        reason: 'permission',
        config: null,
        secrets: ABSENT,
      },
      {
        login: 'other-org',
        admin: false,
        reason: 'not_admin',
        config: null,
        secrets: ABSENT,
      },
    ]);
  });

  test('reads the installations once', async () => {
    const { send, calls } = client(routes());
    await send('GET', '/api/organizations');

    assert.deepEqual(
      keys(calls).filter((key) => key === 'GET /user/installations'),
      ['GET /user/installations'],
    );
  });

  test('maps a rate-limited admin probe to 429 instead of reporting a non-admin', async () => {
    const { send } = client({
      ...routes(),
      'GET /orgs/other-org/actions/secrets/public-key': {
        status: 403,
        data: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'retry-after': '12' },
      },
    });
    const response = await send('GET', '/api/organizations');

    assert.equal(response.status, 429);
    assert.deepEqual(response.data, { error: 'rate_limited', retryAfter: 12 });
  });

  test('fails the listing when an admin probe fails upstream', async () => {
    const { send } = client({
      ...routes(),
      'GET /orgs/other-org/actions/secrets/public-key': {
        status: 500,
        data: { message: 'boom' },
      },
    });
    const response = await send('GET', '/api/organizations');

    assert.equal(response.status, 502);
    assert.equal(response.data.error, 'github');
  });

  test('makes no further calls for organizations where the user is not an admin', async () => {
    const { send, calls } = client(routes());
    await send('GET', '/api/organizations');

    assert.deepEqual(
      keys(calls).filter((key) => key.includes('/orgs/other-org')),
      ['GET /orgs/other-org/actions/secrets/public-key'],
    );
    assert.deepEqual(
      keys(calls).filter((key) => key.includes('/orgs/gone-org')),
      ['GET /orgs/gone-org/actions/secrets/public-key'],
    );
  });

  test('skips user accounts and reads the admin status with the user token', async () => {
    const { send, calls } = client(routes());
    await send('GET', '/api/organizations');

    assert.deepEqual(
      keys(calls).filter((key) => key.includes('/orgs/abnegate')),
      [],
    );
    assert.deepEqual(
      keys(calls)
        .filter((key) => key.startsWith('GET /orgs/appwrite-labs/'))
        .sort(),
      [
        'GET /orgs/appwrite-labs/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
        'GET /orgs/appwrite-labs/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
        'GET /orgs/appwrite-labs/actions/secrets/public-key',
        'GET /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE',
      ],
    );
    assertUserTokenOnly(calls);
  });

  test('returns an empty list when no organization is installed', async () => {
    const { send, calls } = client({
      'GET /user/installations': {
        data: {
          total_count: 1,
          installations: [
            { id: 1, account: { login: 'abnegate', type: 'User' } },
          ],
        },
      },
    });
    const response = await send('GET', '/api/organizations');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { organizations: [] });
    assert.deepEqual(keys(calls), ['GET /user/installations']);
  });
});

describe('GET /api/organizations/:organization', () => {
  test('returns the status of an organization the user administers', async () => {
    const { send, calls } = client(routes());
    const response = await send('GET', '/api/organizations/appwrite-labs');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, admin);
    assertUserTokenOnly(calls);
  });

  test('returns a non-admin organization without reading its settings', async () => {
    const { send, calls } = client(routes());
    const response = await send('GET', '/api/organizations/other-org');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      login: 'other-org',
      admin: false,
      reason: 'not_admin',
      config: null,
      secrets: ABSENT,
    });
    assert.deepEqual(keys(calls), [
      'GET /user/installations',
      'GET /orgs/other-org/actions/secrets/public-key',
    ]);
  });

  test('is not found when the organization is not installed', async () => {
    const { send } = client(routes());
    const response = await send('GET', '/api/organizations/missing-org');

    assert.equal(response.status, 404);
    assert.equal(response.data.error, 'not_found');
  });

  test('is not found for a user account installation', async () => {
    const { send } = client(routes());
    const response = await send('GET', '/api/organizations/abnegate');

    assert.equal(response.status, 404);
    assert.equal(response.data.error, 'not_found');
  });

  test('is not found for an invalid organization name without calling GitHub', async () => {
    const { send, calls } = client(routes());
    const response = await send('GET', '/api/organizations/bad.org');

    assert.equal(response.status, 404);
    assert.deepEqual(calls, []);
  });
});

describe('PUT /api/organizations/:organization/config', () => {
  const serialized = '{"review":true,"severities":"critical,low"}';

  test('patches the user-named variable with the user token without changing its visibility', async () => {
    const { send, calls } = client(routes());
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/config',
      { severities: 'low,critical', review: true },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      config: { review: true, severities: 'critical,low' },
    });
    const writes = calls.filter((call) => call.method !== 'GET');
    assert.deepEqual(keys(writes), [
      'PATCH /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE',
    ]);
    assert.deepEqual(writes[0].body, {
      name: 'UREVIEW_ABNEGATE',
      value: serialized,
    });
    assertUserTokenOnly(calls);
  });

  test('creates the variable with visibility all when it does not exist yet', async () => {
    const missing = {
      ...routes(),
      'PATCH /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE': NOT_FOUND,
    };
    const { send, calls } = client(missing);
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/config',
      { review: true, severities: 'critical,low' },
    );

    assert.equal(response.status, 200);
    const created = calls.find(
      (call) => call.key === 'POST /orgs/appwrite-labs/actions/variables',
    );
    assert.ok(created);
    assert.equal(bearer(created), `Bearer ${USER_TOKEN}`);
    assert.deepEqual(created.body, {
      name: 'UREVIEW_ABNEGATE',
      value: serialized,
      visibility: 'all',
    });
  });

  test('names the variable after the signed-in user', async () => {
    const { send, calls } = client(routes({ key: 'SOME_USER' }), {
      login: 'some-user',
    });
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/config',
      { comments: true },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(keys(calls.filter((call) => call.method !== 'GET')), [
      'PATCH /orgs/appwrite-labs/actions/variables/UREVIEW_SOME_USER',
    ]);
  });

  test('maps a GitHub 403 on write to forbidden', async () => {
    const { send } = client({
      ...routes(),
      'PATCH /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE': {
        status: 403,
        data: { message: 'Resource not accessible by integration' },
      },
    });
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/config',
      { review: true },
    );

    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'forbidden');
  });

  test('rejects a body that names a variable without writing', async () => {
    const { send, calls } = client(routes());
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/config',
      { name: 'UREVIEW_SOMEONE', review: true },
    );

    assert.equal(response.status, 400);
    assert.equal(response.data.error, 'invalid');
    assert.deepEqual(
      calls.filter((call) => call.method !== 'GET'),
      [],
    );
  });
});

describe('PUT /api/organizations/:organization/tokens', () => {
  test('encrypts the tokens with the org public key and writes new and all-repository secrets with visibility all', async () => {
    const { send, calls } = client(routes());
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/tokens',
      { oauth: 'sk-ant-oat01-org', push: 'github_pat_org' },
    );

    assert.equal(response.status, 204);
    assert.deepEqual(
      keys(calls).filter((key) => key.endsWith('/secrets/public-key')),
      ['GET /orgs/appwrite-labs/actions/secrets/public-key'],
    );
    const writes = calls.filter((call) => call.method === 'PUT');
    assert.deepEqual(keys(writes).sort(), [
      'PUT /orgs/appwrite-labs/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
      'PUT /orgs/appwrite-labs/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
    ]);
    const expected = {
      UREVIEW_OAUTH_TOKEN_ABNEGATE: 'sk-ant-oat01-org',
      UREVIEW_PUSH_TOKEN_ABNEGATE: 'github_pat_org',
    };
    for (const write of writes) {
      const name = write.key.split('/').pop();
      assert.deepEqual(Object.keys(write.body).sort(), [
        'encrypted_value',
        'key_id',
        'visibility',
      ]);
      assert.equal(write.body.key_id, 'org-key-1');
      assert.equal(write.body.visibility, 'all');
      assert.equal(decrypt(write.body.encrypted_value), expected[name]);
    }
    assertUserTokenOnly(calls);
  });

  test('keeps the visibility and repositories of existing narrower secrets', async () => {
    const base = '/orgs/appwrite-labs/actions/secrets';
    const { send, calls } = client({
      ...routes(),
      [`GET ${base}/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE', visibility: 'selected' },
      },
      [`GET ${base}/UREVIEW_OAUTH_TOKEN_ABNEGATE/repositories`]: {
        data: { total_count: 2, repositories: [{ id: 7 }, { id: 9 }] },
      },
      [`GET ${base}/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_PUSH_TOKEN_ABNEGATE', visibility: 'private' },
      },
    });
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/tokens',
      { oauth: 'sk-ant-oat01-org', push: 'github_pat_org' },
    );

    assert.equal(response.status, 204);
    const writes = Object.fromEntries(
      calls
        .filter((call) => call.method === 'PUT')
        .map((call) => [call.key.split('/').pop(), call.body]),
    );
    assert.equal(writes.UREVIEW_OAUTH_TOKEN_ABNEGATE.visibility, 'selected');
    assert.deepEqual(
      writes.UREVIEW_OAUTH_TOKEN_ABNEGATE.selected_repository_ids,
      [7, 9],
    );
    assert.equal(writes.UREVIEW_PUSH_TOKEN_ABNEGATE.visibility, 'private');
    assert.equal(
      'selected_repository_ids' in writes.UREVIEW_PUSH_TOKEN_ABNEGATE,
      false,
    );
    assertUserTokenOnly(calls);
  });

  test('refuses to rewrite a selected secret when the installation only covers selected repositories', async () => {
    const base = '/orgs/appwrite-labs/actions/secrets';
    const { send, calls } = client({
      ...routes({ repositorySelection: 'selected' }),
      [`GET ${base}/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE', visibility: 'selected' },
      },
      [`GET ${base}/UREVIEW_OAUTH_TOKEN_ABNEGATE/repositories`]: {
        data: { total_count: 1, repositories: [{ id: 7 }] },
      },
    });
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/tokens',
      { oauth: 'sk-ant-oat01-org', push: 'github_pat_org' },
    );

    assert.equal(response.status, 400);
    assert.deepEqual(response.data, {
      error: 'invalid',
      message:
        'This organization secret is shared with selected repositories that ureview cannot see. Rotate it with `gh secret set --org` instead.',
    });
    assert.deepEqual(
      calls.filter((call) => call.method === 'PUT'),
      [],
    );
    assert.equal(
      calls.some((call) => call.key.endsWith('/repositories')),
      false,
    );
    assertUserTokenOnly(calls);
  });

  test('keeps an all-repository secret when the installation only covers selected repositories', async () => {
    const { send, calls } = client(routes({ repositorySelection: 'selected' }));
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/tokens',
      { oauth: 'sk-ant-oat01-org' },
    );

    assert.equal(response.status, 204);
    const write = calls.find((call) => call.method === 'PUT');
    assert.equal(write.body.visibility, 'all');
    assert.equal('selected_repository_ids' in write.body, false);
  });

  test('returns not_found without writing when the user cannot see the organization installation', async () => {
    const { send, calls } = client(routes());
    const response = await send(
      'PUT',
      '/api/organizations/missing-org/tokens',
      { oauth: 'sk-ant-oat01-org' },
    );

    assert.equal(response.status, 404);
    assert.equal(response.data.error, 'not_found');
    assert.deepEqual(keys(calls), ['GET /user/installations']);
  });

  test('maps a GitHub 403 on the public key to forbidden without writing', async () => {
    const { send, calls } = client({
      ...routes(),
      'GET /orgs/appwrite-labs/actions/secrets/public-key': {
        status: 403,
        data: { message: 'Must have admin rights to Repository.' },
      },
    });
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/tokens',
      { oauth: 'sk-ant-oat01-org' },
    );

    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'forbidden');
    assert.deepEqual(
      calls.filter((call) => call.method === 'PUT'),
      [],
    );
  });

  test('maps a GitHub 403 on a secret write to forbidden', async () => {
    const { send } = client({
      ...routes(),
      'PUT /orgs/appwrite-labs/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE': {
        status: 403,
        data: { message: 'Resource not accessible by integration' },
      },
    });
    const response = await send(
      'PUT',
      '/api/organizations/appwrite-labs/tokens',
      { oauth: 'sk-ant-oat01-org' },
    );

    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'forbidden');
  });

  const rejected = [
    ['a secret name', { name: 'UREVIEW_OAUTH_TOKEN_SOMEONE', oauth: 'token' }],
    ['a secret name as the key', { UREVIEW_PUSH_TOKEN_SOMEONE: 'token' }],
    ['an empty body', {}],
    ['a token with whitespace inside', { push: 'github pat' }],
  ];

  for (const [label, invalid] of rejected) {
    test(`rejects ${label} without writing secrets`, async () => {
      const { send, calls } = client(routes());
      const response = await send(
        'PUT',
        '/api/organizations/appwrite-labs/tokens',
        invalid,
      );

      assert.equal(response.status, 400);
      assert.equal(response.data.error, 'invalid');
      assert.deepEqual(
        calls.filter((call) => call.method === 'PUT'),
        [],
      );
    });
  }
});

describe('DELETE /api/organizations/:organization', () => {
  test('removes the variable and all three secrets with the user token', async () => {
    const { send, calls } = client(routes());
    const response = await send('DELETE', '/api/organizations/appwrite-labs');

    assert.equal(response.status, 204);
    const deletes = calls.filter((call) => call.method === 'DELETE');
    assert.deepEqual(keys(deletes).sort(), [
      'DELETE /orgs/appwrite-labs/actions/secrets/UREVIEW_API_KEY_ABNEGATE',
      'DELETE /orgs/appwrite-labs/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
      'DELETE /orgs/appwrite-labs/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
      'DELETE /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE',
    ]);
    assertUserTokenOnly(calls);
  });

  test('maps a GitHub 403 on delete to forbidden', async () => {
    const { send } = client({
      ...routes(),
      'DELETE /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE': {
        status: 403,
        data: { message: 'Must have admin rights to Repository.' },
      },
    });
    const response = await send('DELETE', '/api/organizations/appwrite-labs');

    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'forbidden');
  });
});
