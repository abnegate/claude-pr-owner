import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sodium from 'libsodium-wrappers';
import { createApp } from '../src/app.js';
import { UNSCOPED } from '../src/Store.js';
import { actions, mutations } from './support/actions.js';
import { mockFetch, NOT_FOUND } from './support/fetch.js';
import { environment, pages, sessionCookie, url } from './support/fixtures.js';

await sodium.ready;

const USER_TOKEN = 'gho_user';
const keyPair = sodium.crypto_box_keypair();
const organizationKey = sodium.to_base64(
  keyPair.publicKey,
  sodium.base64_variants.ORIGINAL,
);
const ABSENT = { oauth: false, push: false, apiKey: false };
const SELECTION = [7, 9];
const INVALID_REPOSITORIES =
  'repositories must be a non-empty list of repository ids.';
const UNKNOWN = {
  config: null,
  secrets: ABSENT,
  repositories: null,
  exposed: [],
};

function client(routes, { login = 'abnegate' } = {}) {
  const { fetch, calls } = mockFetch(routes);
  const handle = createApp({ environment: environment(), fetch, pages });
  const cookie = sessionCookie({
    login,
    token: USER_TOKEN,
    avatar: 'https://avatars.githubusercontent.com/u/1',
  });
  const send = async (method, path, body, query = {}) => {
    const response = await handle({
      method,
      path,
      query,
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

function writes(calls) {
  return calls.filter((call) => call.method !== 'GET');
}

function unscoped(response) {
  assert.equal(response.status, 400);
  assert.deepEqual(response.data, { error: 'invalid', message: UNSCOPED });
}

function routes({ key = 'ABNEGATE' } = {}) {
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
        value: '{"review":true,"model":"claude-sonnet-4-6","effort":"low"}',
        visibility: 'selected',
      },
    },
    [`GET ${base}/variables/UREVIEW_${key}/repositories`]: {
      data: {
        total_count: SELECTION.length,
        repositories: SELECTION.map((id) => ({ id })),
      },
    },
    [`GET ${base}/secrets/UREVIEW_OAUTH_TOKEN_${key}`]: {
      data: { name: `UREVIEW_OAUTH_TOKEN_${key}`, visibility: 'selected' },
    },
    [`PUT ${base}/secrets/UREVIEW_OAUTH_TOKEN_${key}/repositories`]: {
      status: 204,
    },
    [`GET ${base}/secrets/UREVIEW_PUSH_TOKEN_${key}`]: NOT_FOUND,
    [`GET ${base}/secrets/UREVIEW_API_KEY_${key}`]: NOT_FOUND,
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
  config: { review: true, model: 'claude-sonnet-4-6', effort: 'low' },
  secrets: { oauth: true, push: false, apiKey: false },
  repositories: SELECTION,
  exposed: [],
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
        ...UNKNOWN,
      },
      {
        login: 'narrow-org',
        admin: false,
        reason: 'permission',
        ...UNKNOWN,
      },
      {
        login: 'other-org',
        admin: false,
        reason: 'not_admin',
        ...UNKNOWN,
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
      [
        ...new Set(
          keys(calls).filter((key) =>
            key.startsWith('GET /orgs/appwrite-labs/'),
          ),
        ),
      ].sort(),
      [
        'GET /orgs/appwrite-labs/actions/secrets/UREVIEW_API_KEY_ABNEGATE',
        'GET /orgs/appwrite-labs/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
        'GET /orgs/appwrite-labs/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
        'GET /orgs/appwrite-labs/actions/secrets/public-key',
        'GET /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE',
        'GET /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE/repositories',
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

  test('reports a hand-set organization API key', async () => {
    const { send } = client({
      ...routes(),
      'GET /orgs/appwrite-labs/actions/variables/UREVIEW_ABNEGATE': NOT_FOUND,
      'GET /orgs/appwrite-labs/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE':
        NOT_FOUND,
      'GET /orgs/appwrite-labs/actions/secrets/UREVIEW_API_KEY_ABNEGATE': {
        data: { name: 'UREVIEW_API_KEY_ABNEGATE', visibility: 'all' },
      },
    });
    const single = await send('GET', '/api/organizations/appwrite-labs');
    const listing = await send('GET', '/api/organizations');
    const expected = {
      login: 'appwrite-labs',
      admin: true,
      config: null,
      secrets: { oauth: false, push: false, apiKey: true },
      repositories: null,
      exposed: ['apiKey'],
    };

    assert.equal(single.status, 200);
    assert.deepEqual(single.data, expected);
    assert.deepEqual(
      listing.data.organizations.find(
        (organization) => organization.login === 'appwrite-labs',
      ),
      expected,
    );
  });

  test('returns a non-admin organization without reading its settings', async () => {
    const { send, calls } = client(routes());
    const response = await send('GET', '/api/organizations/other-org');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      login: 'other-org',
      admin: false,
      reason: 'not_admin',
      ...UNKNOWN,
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

describe('GET /api/organizations/:organization/repositories', () => {
  const listing = 'GET /user/installations/2/repositories';
  const next =
    'https://api.github.com/user/installations/2/repositories?per_page=100&page=2';

  function repositories(overrides = {}) {
    return {
      ...routes(),
      [listing]: ({ url: requested }) =>
        requested.searchParams.get('page') === '2'
          ? {
              data: {
                total_count: 4,
                repositories: [
                  { id: 2, name: 'api', owner: { login: 'appwrite-labs' } },
                ],
              },
            }
          : {
              data: {
                total_count: 4,
                repositories: [
                  {
                    id: 3,
                    name: 'web',
                    private: true,
                    owner: { login: 'Appwrite-Labs' },
                  },
                  {
                    id: 1,
                    name: 'edge',
                    private: false,
                    owner: { login: 'appwrite-labs' },
                  },
                  {
                    id: 99,
                    name: 'fork',
                    private: false,
                    owner: { login: 'someone-else' },
                  },
                ],
              },
              headers: { link: `<${next}>; rel="next"` },
            },
      ...overrides,
    };
  }

  test('lists the installation repositories in the organization, sorted by name, with the user token', async () => {
    const { send, calls } = client(repositories());
    const response = await send(
      'GET',
      '/api/organizations/appwrite-labs/repositories',
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      repositories: [
        { id: 2, name: 'api', private: false },
        { id: 1, name: 'edge', private: false },
        { id: 3, name: 'web', private: true },
      ],
    });
    assert.deepEqual(keys(calls), [
      'GET /user/installations',
      listing,
      listing,
    ]);
    assert.equal(new URL(calls[1].url).searchParams.get('per_page'), '100');
    assertUserTokenOnly(calls);
  });

  test('matches the organization name case-insensitively', async () => {
    const { send } = client(repositories());
    const response = await send(
      'GET',
      '/api/organizations/Appwrite-Labs/repositories',
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.data.repositories.map((repository) => repository.id),
      [2, 1, 3],
    );
  });

  test('is not found when the organization is not installed', async () => {
    const { send, calls } = client(repositories());
    const response = await send(
      'GET',
      '/api/organizations/missing-org/repositories',
    );

    assert.equal(response.status, 404);
    assert.equal(response.data.error, 'not_found');
    assert.deepEqual(keys(calls), ['GET /user/installations']);
  });

  test('is not found for a user account installation', async () => {
    const { send, calls } = client(repositories());
    const response = await send(
      'GET',
      '/api/organizations/abnegate/repositories',
    );

    assert.equal(response.status, 404);
    assert.deepEqual(keys(calls), ['GET /user/installations']);
  });

  test('maps a GitHub 403 on the listing to forbidden', async () => {
    const { send } = client(
      repositories({
        [listing]: { status: 403, data: { message: 'Forbidden' } },
      }),
    );
    const response = await send(
      'GET',
      '/api/organizations/appwrite-labs/repositories',
    );

    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'forbidden');
  });
});

describe('PUT /api/organizations/:organization/config', () => {
  const path = '/api/organizations/appwrite-labs/config';
  const base = '/orgs/appwrite-labs/actions';
  const serialized =
    '{"review":true,"severities":"critical,low","effort":"medium"}';

  test('patches the user-named variable, then restricts it and its selected secrets to the current selection', async () => {
    const { send, calls } = client(routes());
    const response = await send('PUT', path, {
      effort: 'medium',
      severities: 'low,critical',
      review: true,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      config: { review: true, severities: 'critical,low', effort: 'medium' },
      repositories: SELECTION,
    });
    const written = writes(calls);
    assert.equal(written[0].key, `PATCH ${base}/variables/UREVIEW_ABNEGATE`);
    assert.deepEqual(written[0].body, {
      name: 'UREVIEW_ABNEGATE',
      value: serialized,
    });
    assert.deepEqual(
      written
        .slice(1)
        .map((call) => [call.key, call.body])
        .sort(),
      [
        [
          `PATCH ${base}/variables/UREVIEW_ABNEGATE`,
          { visibility: 'selected', selected_repository_ids: SELECTION },
        ],
        [
          `PUT ${base}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE/repositories`,
          { selected_repository_ids: SELECTION },
        ],
      ],
    );
    assertUserTokenOnly(calls);
  });

  test('creates the variable visible only to the submitted repositories', async () => {
    const { send, calls } = client({
      ...routes(),
      [`GET ${base}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
      [`PATCH ${base}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
    });
    const response = await send('PUT', path, {
      review: true,
      severities: 'critical,low',
      effort: 'medium',
      repositories: [11, 5],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.data.repositories, [11, 5]);
    const created = calls.find((call) => call.key === `POST ${base}/variables`);
    assert.ok(created);
    assert.equal(bearer(created), `Bearer ${USER_TOKEN}`);
    assert.deepEqual(created.body, {
      name: 'UREVIEW_ABNEGATE',
      value: serialized,
      visibility: 'selected',
      selected_repository_ids: [11, 5],
    });
    assertUserTokenOnly(calls);
  });

  test('uses the submitted repositories, deduplicated, instead of the current selection', async () => {
    const { send, calls } = client(routes());
    const response = await send('PUT', path, {
      review: true,
      repositories: [9, 3, 9],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      config: { review: true },
      repositories: [9, 3],
    });
    assert.equal(
      calls.some(
        (call) =>
          call.key === `GET ${base}/variables/UREVIEW_ABNEGATE/repositories`,
      ),
      false,
    );
    for (const call of writes(calls).slice(1)) {
      assert.deepEqual(call.body.selected_repository_ids, [9, 3]);
    }
  });

  test('names the variable after the signed-in user', async () => {
    const { send, calls } = client(routes({ key: 'SOME_USER' }), {
      login: 'some-user',
    });
    const response = await send('PUT', path, { comments: true });

    assert.equal(response.status, 200);
    assert.deepEqual(keys(writes(calls)).sort(), [
      `PATCH ${base}/variables/UREVIEW_SOME_USER`,
      `PATCH ${base}/variables/UREVIEW_SOME_USER`,
      `PUT ${base}/secrets/UREVIEW_OAUTH_TOKEN_SOME_USER/repositories`,
    ]);
  });

  test('maps a GitHub 403 on write to forbidden', async () => {
    const { send } = client({
      ...routes(),
      [`PATCH ${base}/variables/UREVIEW_ABNEGATE`]: {
        status: 403,
        data: { message: 'Resource not accessible by integration' },
      },
    });
    const response = await send('PUT', path, { review: true });

    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'forbidden');
  });

  test('rejects a body that names a variable without writing', async () => {
    const { send, calls } = client(routes());
    const response = await send('PUT', path, {
      name: 'UREVIEW_SOMEONE',
      review: true,
    });

    assert.equal(response.status, 400);
    assert.equal(response.data.error, 'invalid');
    assert.deepEqual(writes(calls), []);
  });
});

describe('PUT /api/organizations/:organization/tokens', () => {
  const path = '/api/organizations/appwrite-labs/tokens';
  const base = '/orgs/appwrite-labs/actions';

  test('encrypts the tokens with the org public key and writes them visible only to the current selection', async () => {
    const { send, calls } = client(routes());
    const response = await send('PUT', path, {
      oauth: 'sk-ant-oat01-org',
      push: 'github_pat_org',
    });

    assert.equal(response.status, 204);
    assert.deepEqual(
      keys(calls).filter((key) => key.endsWith('/secrets/public-key')),
      [`GET ${base}/secrets/public-key`],
    );
    const secrets = calls.filter(
      (call) => call.method === 'PUT' && !call.key.endsWith('/repositories'),
    );
    assert.deepEqual(keys(secrets).sort(), [
      `PUT ${base}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`,
      `PUT ${base}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`,
    ]);
    const expected = {
      UREVIEW_OAUTH_TOKEN_ABNEGATE: 'sk-ant-oat01-org',
      UREVIEW_PUSH_TOKEN_ABNEGATE: 'github_pat_org',
    };
    for (const write of secrets) {
      const name = write.key.split('/').pop();
      assert.deepEqual(Object.keys(write.body).sort(), [
        'encrypted_value',
        'key_id',
        'selected_repository_ids',
        'visibility',
      ]);
      assert.equal(write.body.key_id, 'org-key-1');
      assert.equal(write.body.visibility, 'selected');
      assert.deepEqual(write.body.selected_repository_ids, SELECTION);
      assert.equal(decrypt(write.body.encrypted_value), expected[name]);
    }
    const restricted = calls.find(
      (call) =>
        call.method === 'PATCH' &&
        call.key === `PATCH ${base}/variables/UREVIEW_ABNEGATE`,
    );
    assert.deepEqual(restricted.body, {
      visibility: 'selected',
      selected_repository_ids: SELECTION,
    });
    assertUserTokenOnly(calls);
  });

  test('rewrites secrets shared with all or private repositories as selected', async () => {
    const { send, calls } = client({
      ...routes(),
      [`GET ${base}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE', visibility: 'all' },
      },
      [`GET ${base}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_PUSH_TOKEN_ABNEGATE', visibility: 'private' },
      },
    });
    const response = await send('PUT', path, {
      oauth: 'sk-ant-oat01-org',
      push: 'github_pat_org',
      repositories: [42],
    });

    assert.equal(response.status, 204);
    const bodies = Object.fromEntries(
      calls
        .filter(
          (call) =>
            call.method === 'PUT' && !call.key.endsWith('/repositories'),
        )
        .map((call) => [call.key.split('/').pop(), call.body]),
    );
    for (const name of [
      'UREVIEW_OAUTH_TOKEN_ABNEGATE',
      'UREVIEW_PUSH_TOKEN_ABNEGATE',
    ]) {
      assert.equal(bodies[name].visibility, 'selected', name);
      assert.deepEqual(bodies[name].selected_repository_ids, [42], name);
    }
    assertUserTokenOnly(calls);
  });

  test('never touches a hand-set API key shared with every repository', async () => {
    const { send, calls } = client({
      ...routes(),
      [`GET ${base}/secrets/UREVIEW_API_KEY_ABNEGATE`]: {
        data: { name: 'UREVIEW_API_KEY_ABNEGATE', visibility: 'all' },
      },
    });
    const response = await send('PUT', path, { oauth: 'sk-ant-oat01-org' });

    assert.equal(response.status, 204);
    assert.deepEqual(
      keys(writes(calls)).filter((key) => key.includes('API_KEY')),
      [],
    );
  });

  test('refuses to write without repositories while the variable is shared with every repository', async () => {
    const { send, calls } = client({
      ...routes(),
      [`GET ${base}/variables/UREVIEW_ABNEGATE`]: {
        data: { name: 'UREVIEW_ABNEGATE', value: '{}', visibility: 'all' },
      },
    });
    const response = await send('PUT', path, { oauth: 'sk-ant-oat01-org' });

    unscoped(response);
    assert.deepEqual(writes(calls), []);
    assert.equal(
      calls.some((call) => call.key.endsWith('/repositories')),
      false,
    );
  });

  test('returns not_found after only the installation lookup when the organization is not installed', async () => {
    const { send, calls } = client(routes());
    for (const body of [
      { oauth: 'sk-ant-oat01-org', repositories: [7] },
      { oauth: 'sk-ant-oat01-org' },
    ]) {
      calls.length = 0;
      const response = await send(
        'PUT',
        '/api/organizations/missing-org/tokens',
        body,
      );

      assert.equal(response.status, 404);
      assert.equal(response.data.error, 'not_found');
      assert.deepEqual(keys(calls), ['GET /user/installations']);
    }
  });

  test('maps a GitHub 403 on the public key to forbidden without writing', async () => {
    const { send, calls } = client({
      ...routes(),
      [`GET ${base}/secrets/public-key`]: {
        status: 403,
        data: { message: 'Must have admin rights to Repository.' },
      },
    });
    const response = await send('PUT', path, { oauth: 'sk-ant-oat01-org' });

    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'forbidden');
    assert.deepEqual(writes(calls), []);
  });

  test('maps a GitHub 403 on a secret write to forbidden without restricting', async () => {
    const { send, calls } = client({
      ...routes(),
      [`PUT ${base}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        status: 403,
        data: { message: 'Resource not accessible by integration' },
      },
    });
    const response = await send('PUT', path, { oauth: 'sk-ant-oat01-org' });

    assert.equal(response.status, 403);
    assert.equal(response.data.error, 'forbidden');
    assert.equal(
      calls.some((call) => call.method === 'PATCH'),
      false,
    );
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
      const response = await send('PUT', path, invalid);

      assert.equal(response.status, 400);
      assert.equal(response.data.error, 'invalid');
      assert.deepEqual(writes(calls), []);
    });
  }
});

describe('organization repository scope', () => {
  const base = '/orgs/appwrite-labs/actions';
  const bodies = {
    config: { review: true },
    tokens: { oauth: 'sk-ant-oat01-org' },
    enrolment: {
      config: { review: true },
      tokens: { oauth: 'sk-ant-oat01-org' },
    },
  };
  const invalid = [
    ['an empty list', []],
    ['a number', 7],
    ['a string', '7'],
    ['null', null],
    ['an object', { 7: true }],
    ['a zero id', [0]],
    ['a negative id', [7, -1]],
    ['a string id', [7, '9']],
    ['a fractional id', [7.5]],
    ['an unsafe id', [Number.MAX_SAFE_INTEGER + 1]],
  ];

  for (const [endpoint, body] of Object.entries(bodies)) {
    const path = `/api/organizations/appwrite-labs/${endpoint}`;

    for (const [label, repositories] of invalid) {
      test(`${endpoint} rejects ${label} as repositories without writing`, async () => {
        const { send, calls } = client(routes());
        const response = await send('PUT', path, { ...body, repositories });

        assert.equal(response.status, 400);
        assert.deepEqual(response.data, {
          error: 'invalid',
          message: INVALID_REPOSITORIES,
        });
        assert.deepEqual(writes(calls), []);
      });
    }

    test(`${endpoint} refuses to write without repositories when no variable exists`, async () => {
      const { send, calls } = client({
        ...routes(),
        [`GET ${base}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
      });
      const response = await send('PUT', path, body);

      unscoped(response);
      assert.deepEqual(writes(calls), []);
    });

    for (const visibility of ['all', 'private']) {
      test(`${endpoint} refuses to write without repositories while the variable visibility is ${visibility}`, async () => {
        const { send, calls } = client({
          ...routes(),
          [`GET ${base}/variables/UREVIEW_ABNEGATE`]: {
            data: { name: 'UREVIEW_ABNEGATE', value: '{}', visibility },
          },
        });
        const response = await send('PUT', path, body);

        unscoped(response);
        assert.deepEqual(writes(calls), []);
        assertUserTokenOnly(calls);
      });
    }

    test(`${endpoint} refuses to write without repositories while the selection is empty`, async () => {
      const { send, calls } = client({
        ...routes(),
        [`GET ${base}/variables/UREVIEW_ABNEGATE/repositories`]: {
          data: { total_count: 0, repositories: [] },
        },
      });
      const response = await send('PUT', path, body);

      unscoped(response);
      assert.deepEqual(writes(calls), []);
    });
  }
});

describe('PUT /api/organizations/:organization/enrolment', () => {
  const path = '/api/organizations/appwrite-labs/enrolment';
  const base = '/orgs/appwrite-labs/actions';
  const oauth = 'sk-ant-oat01-org';
  const push = 'github_pat_org';

  function enrolment({ key, login, ...fake } = {}, overrides = {}) {
    const store = actions(base, { key, publicKey: organizationKey, ...fake });
    const { send, calls } = client(
      {
        ...routes({ key }),
        ...store.routes,
        ...overrides,
      },
      login === undefined ? {} : { login },
    );
    return { send, calls, state: store.state };
  }

  test('writes the tokens and config visible only to the submitted repositories with the user token', async () => {
    const { send, calls, state } = enrolment();
    const response = await send('PUT', path, {
      config: { review: true },
      tokens: { oauth, push },
      repositories: [7, 9],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      config: { review: true },
      secrets: { oauth: true, push: true, apiKey: false },
      repositories: [7, 9],
      exposed: [],
    });
    for (const call of mutations(calls)) {
      if (call.method === 'PUT' && !call.key.endsWith('/repositories')) {
        assert.equal(call.body.visibility, 'selected');
        assert.deepEqual(call.body.selected_repository_ids, [7, 9]);
        const expected = call.key.includes('OAUTH') ? oauth : push;
        assert.equal(decrypt(call.body.encrypted_value), expected);
      }
    }
    const created = calls.find((call) => call.key === `POST ${base}/variables`);
    assert.equal(created.body.visibility, 'selected');
    assert.deepEqual(created.body.selected_repository_ids, [7, 9]);
    assert.equal(state.variable, '{"review":true}');
    assert.deepEqual(state.visibility, {
      variable: 'selected',
      oauth: 'selected',
      push: 'selected',
      apiKey: 'all',
    });
    assert.deepEqual(state.repositories.variable, [7, 9]);
    assertUserTokenOnly(calls);
  });

  test('reuses the selection of an existing enrolment when repositories are omitted', async () => {
    const { send, calls, state } = enrolment({
      variable: '{"review":true}',
      secrets: ['oauth'],
      visibility: { variable: 'selected', oauth: 'selected' },
      repositories: [7, 9],
    });
    const response = await send('PUT', path, {
      config: { review: false },
      tokens: { push },
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      config: { review: false },
      secrets: { oauth: true, push: true, apiKey: false },
      repositories: [7, 9],
      exposed: [],
    });
    const put = calls.find(
      (call) => call.key === `PUT ${base}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`,
    );
    assert.deepEqual(put.body.selected_repository_ids, [7, 9]);
    assert.deepEqual(state.repositories.oauth, [7, 9]);
    assertUserTokenOnly(calls);
  });

  test('moves a legacy all-repository enrolment to the submitted repositories', async () => {
    const { send, calls, state } = enrolment({
      variable: '{"review":true}',
      secrets: ['oauth', 'push'],
      repositories: [1, 2, 3],
    });
    const response = await send('PUT', path, {
      config: { review: true },
      tokens: { oauth, push },
      repositories: [7],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.data.repositories, [7]);
    assert.deepEqual(response.data.exposed, []);
    const restricted = calls.filter(
      (call) =>
        call.key === `PATCH ${base}/variables/UREVIEW_ABNEGATE` &&
        call.body.visibility !== undefined,
    );
    assert.deepEqual(
      restricted.map((call) => call.body),
      [{ visibility: 'selected', selected_repository_ids: [7] }],
    );
    assert.deepEqual(state.visibility, {
      variable: 'selected',
      oauth: 'selected',
      push: 'selected',
      apiKey: 'all',
    });
    for (const entry of ['variable', 'oauth', 'push']) {
      assert.deepEqual(state.repositories[entry], [7], entry);
    }
  });

  test('reports a hand-set API key shared with every repository as exposed without touching it', async () => {
    const { send, calls, state } = enrolment({ secrets: ['apiKey'] });
    const response = await send('PUT', path, {
      config: { review: true },
      tokens: { push },
      repositories: [7],
    });

    assert.equal(response.status, 200);
    assert.deepEqual(response.data.secrets, {
      oauth: false,
      push: true,
      apiKey: true,
    });
    assert.deepEqual(response.data.exposed, ['apiKey']);
    assert.deepEqual(
      keys(mutations(calls)).filter((key) => key.includes('API_KEY')),
      [],
    );
    assert.equal(state.visibility.apiKey, 'all');
  });

  test('names every secret and the variable after the signed-in user', async () => {
    const { send, calls, state } = enrolment({
      key: 'SOME_USER',
      login: 'some-user',
    });
    const response = await send('PUT', path, {
      config: { review: true },
      tokens: { oauth },
      repositories: [7],
    });

    assert.equal(response.status, 200);
    for (const call of mutations(calls)) {
      assert.ok(
        call.key.includes('_SOME_USER') ||
          call.body?.name === 'UREVIEW_SOME_USER',
        call.key,
      );
    }
    assert.deepEqual([...state.secrets], ['oauth']);
  });

  test('refuses to enrol without repositories when no variable exists, and writes nothing', async () => {
    const { send, calls, state } = enrolment();
    const response = await send('PUT', path, {
      config: { review: true },
      tokens: { oauth },
    });

    unscoped(response);
    assert.deepEqual(mutations(calls), []);
    assert.deepEqual([...state.secrets], []);
  });

  test('refuses to re-enrol without repositories while the variable is shared with every repository', async () => {
    const { send, calls, state } = enrolment({
      variable: '{"review":true}',
      secrets: ['oauth'],
    });
    const response = await send('PUT', path, {
      config: { review: false },
      tokens: { push },
    });

    unscoped(response);
    assert.deepEqual(mutations(calls), []);
    assert.equal(state.variable, '{"review":true}');
    assert.equal(state.visibility.variable, 'all');
  });

  test('returns not_found after only the installation lookup when the organization is not installed', async () => {
    const { send, calls } = enrolment();
    const response = await send(
      'PUT',
      '/api/organizations/missing-org/enrolment',
      { config: {}, tokens: { oauth }, repositories: [7] },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(keys(calls), ['GET /user/installations']);
  });

  test('refuses a non-admin before any write', async () => {
    const denied = {
      status: 403,
      data: { message: 'Must have admin rights to Repository.' },
    };
    const { send, calls } = enrolment(
      {},
      {
        [`GET ${base}/variables/UREVIEW_ABNEGATE`]: denied,
        [`GET ${base}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: denied,
        [`GET ${base}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: denied,
        [`GET ${base}/secrets/UREVIEW_API_KEY_ABNEGATE`]: denied,
      },
    );
    for (const body of [
      { config: { review: true }, tokens: { oauth } },
      { config: { review: true }, tokens: { oauth }, repositories: [7] },
    ]) {
      const response = await send('PUT', path, body);

      assert.equal(response.status, 403);
      assert.equal(response.data.error, 'forbidden');
    }
    assert.deepEqual(mutations(calls), []);
  });

  test('rolls back only the new kinds when the config write fails', async () => {
    const { send, calls, state } = enrolment(
      { secrets: ['push'] },
      { [`POST ${base}/variables`]: { status: 500, data: {} } },
    );
    const response = await send('PUT', path, {
      config: { review: true },
      tokens: { oauth, push },
      repositories: [7],
    });

    assert.equal(response.status, 502);
    assert.deepEqual(response.data, {
      error: 'github',
      rolledBack: ['oauth'],
      tokensWritten: ['push'],
    });
    assert.deepEqual([...state.secrets], ['push']);
    assert.equal(
      calls.some((call) => call.key.endsWith('/repositories')),
      false,
    );
  });

  test('never rolls back when the variable already exists', async () => {
    const { send, calls } = enrolment(
      { variable: '{"review":true}' },
      { [`PATCH ${base}/variables/UREVIEW_ABNEGATE`]: { status: 500 } },
    );
    const response = await send('PUT', path, {
      config: { review: false },
      tokens: { oauth },
      repositories: [7],
    });

    assert.equal(response.status, 502);
    assert.deepEqual(response.data, {
      error: 'github',
      tokensWritten: ['oauth'],
    });
    assert.equal(
      calls.some((call) => call.method === 'DELETE'),
      false,
    );
  });

  test('refuses to enrol without a Claude token and writes nothing', async () => {
    const { send, calls } = enrolment();
    const response = await send('PUT', path, {
      config: {},
      tokens: {},
      repositories: [7],
    });

    assert.equal(response.status, 400);
    assert.equal(response.data.message, 'Provide a Claude token to enrol.');
    assert.deepEqual(mutations(calls), []);
  });
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
