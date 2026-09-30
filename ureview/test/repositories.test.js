import assert from 'node:assert/strict';
import { verify } from 'node:crypto';
import { describe, test } from 'node:test';
import sodium from 'libsodium-wrappers';
import { createApp } from '../src/app.js';
import { mockFetch, NOT_FOUND } from './support/fetch.js';
import {
  environment,
  pages,
  publicKey,
  sessionCookie,
  url,
} from './support/fixtures.js';

await sodium.ready;

const USER_TOKEN = 'gho_user';
const READ = { secrets: 'read', actions_variables: 'read', metadata: 'read' };
const WRITE = {
  secrets: 'write',
  actions_variables: 'write',
  metadata: 'read',
};
const NONE = {
  config: null,
  secrets: { oauth: false, push: false, apiKey: false },
};
const keyPair = sodium.crypto_box_keypair();
const repositoryKey = sodium.to_base64(
  keyPair.publicKey,
  sodium.base64_variants.ORIGINAL,
);

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

function signedByApp(call) {
  const match = /^Bearer (.+)$/.exec(bearer(call) ?? '');
  if (match === null) {
    return false;
  }
  const [header, payload, signature] = match[1].split('.');
  if (signature === undefined) {
    return false;
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
  return (
    claims.iss === '123' &&
    verify(
      'RSA-SHA256',
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, 'base64url'),
    )
  );
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

function listed(owner, name, { type = 'User', push = true } = {}) {
  return {
    name,
    full_name: `${owner}/${name}`,
    owner: { login: owner, type },
    permissions: { admin: false, push, pull: true },
  };
}

function writeRoutes({
  owner = 'abnegate',
  repository = 'edge',
  key = 'ABNEGATE',
  type = 'User',
} = {}) {
  const base = `/repos/${owner}/${repository}/actions`;
  return {
    [`GET /repos/${owner}/${repository}`]: {
      data: {
        name: repository,
        full_name: `${owner}/${repository}`,
        owner: { login: owner, type },
        permissions: { admin: false, push: true, pull: true },
      },
    },
    [`GET /repos/${owner}/${repository}/installation`]: { data: { id: 42 } },
    'POST /app/installations/42/access_tokens': {
      status: 201,
      data: { token: 'ghs_write', expires_at: '2026-09-30T01:00:00Z' },
    },
    [`PATCH ${base}/variables/UREVIEW_${key}`]: { status: 204 },
    [`POST ${base}/variables`]: { status: 201 },
    [`GET ${base}/secrets/public-key`]: {
      data: { key_id: 'key-1', key: repositoryKey },
    },
    [`PUT ${base}/secrets/UREVIEW_OAUTH_TOKEN_${key}`]: { status: 201 },
    [`PUT ${base}/secrets/UREVIEW_PUSH_TOKEN_${key}`]: { status: 204 },
    [`DELETE ${base}/variables/UREVIEW_${key}`]: { status: 204 },
    [`DELETE ${base}/secrets/UREVIEW_OAUTH_TOKEN_${key}`]: { status: 204 },
    [`DELETE ${base}/secrets/UREVIEW_PUSH_TOKEN_${key}`]: { status: 204 },
    [`DELETE ${base}/secrets/UREVIEW_API_KEY_${key}`]: NOT_FOUND,
  };
}

function statusRoutes({
  owner = 'abnegate',
  repository = 'edge',
  key = 'ABNEGATE',
  type = 'User',
} = {}) {
  const base = `/repos/${owner}/${repository}/actions`;
  return {
    ...writeRoutes({ owner, repository, key, type }),
    'POST /app/installations/42/access_tokens': {
      status: 201,
      data: { token: 'ghs_read' },
    },
    [`GET ${base}/variables/UREVIEW_${key}`]: {
      data: {
        name: `UREVIEW_${key}`,
        value: '{"review":true,"severities":"critical,high"}',
      },
    },
    [`GET ${base}/secrets/UREVIEW_OAUTH_TOKEN_${key}`]: {
      data: { name: `UREVIEW_OAUTH_TOKEN_${key}` },
    },
    [`GET ${base}/secrets/UREVIEW_PUSH_TOKEN_${key}`]: NOT_FOUND,
    [`GET ${base}/secrets/UREVIEW_API_KEY_${key}`]: NOT_FOUND,
    [`GET ${base}/organization-variables`]: {
      data: {
        total_count: 2,
        variables: [
          { name: 'UREVIEW_SOMEONE', value: '{"bots":true}' },
          { name: `UREVIEW_${key}`, value: '{"improvement":true}' },
        ],
      },
    },
    [`GET ${base}/organization-secrets`]: {
      data: {
        total_count: 2,
        secrets: [
          { name: 'UREVIEW_OAUTH_TOKEN_SOMEONE' },
          { name: `UREVIEW_PUSH_TOKEN_${key}` },
        ],
      },
    },
  };
}

function gated(overrides = {}) {
  return {
    ...writeRoutes(),
    'GET /repos/abnegate/edge': {
      data: {
        full_name: 'abnegate/edge',
        permissions: { admin: false, push: false, pull: true },
      },
    },
    ...overrides,
  };
}

function actionsCalls(calls) {
  return calls.filter((call) => call.key.includes('/actions/'));
}

describe('GET /api/repositories', () => {
  const routes = () => ({
    'GET /user/installations': {
      data: {
        total_count: 3,
        installations: [
          { id: 1, account: { login: 'abnegate', type: 'User' } },
          { id: 2, account: { login: 'appwrite-labs', type: 'Organization' } },
          { id: 3, account: { login: 'readonly-org', type: 'Organization' } },
        ],
      },
    },
    'GET /user/installations/1/repositories': {
      data: {
        total_count: 4,
        repositories: [
          listed('abnegate', 'zeta'),
          listed('abnegate', 'alpha'),
          listed('abnegate', 'readonly', { push: false }),
          {
            name: 'unknown',
            full_name: 'abnegate/unknown',
            owner: { login: 'abnegate', type: 'User' },
          },
        ],
      },
    },
    'GET /user/installations/2/repositories': {
      data: {
        total_count: 1,
        repositories: [
          listed('appwrite-labs', 'edge', { type: 'Organization' }),
        ],
      },
    },
    'GET /user/installations/3/repositories': {
      data: {
        total_count: 1,
        repositories: [
          listed('readonly-org', 'docs', {
            type: 'Organization',
            push: false,
          }),
        ],
      },
    },
  });

  test('returns only the names of pushable repositories, sorted', async () => {
    const { send } = client(routes());
    const response = await send('GET', '/api/repositories');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      install: 'https://github.com/apps/ureview/installations/new',
      repositories: [
        { owner: 'abnegate', name: 'alpha', fullName: 'abnegate/alpha' },
        { owner: 'abnegate', name: 'zeta', fullName: 'abnegate/zeta' },
        {
          owner: 'appwrite-labs',
          name: 'edge',
          fullName: 'appwrite-labs/edge',
        },
      ],
    });
  });

  test('reads only the installations with the user token and mints nothing', async () => {
    const { send, calls } = client(routes());
    await send('GET', '/api/repositories');

    assert.deepEqual(keys(calls).sort(), [
      'GET /user/installations',
      'GET /user/installations/1/repositories',
      'GET /user/installations/2/repositories',
      'GET /user/installations/3/repositories',
    ]);
    for (const call of calls) {
      assert.equal(bearer(call), `Bearer ${USER_TOKEN}`, call.key);
    }
  });

  test('follows pagination of the installation repositories', async () => {
    const next =
      'https://api.github.com/user/installations/1/repositories?per_page=100&page=2';
    const { send, calls } = client({
      'GET /user/installations': {
        data: {
          total_count: 1,
          installations: [
            { id: 1, account: { login: 'abnegate', type: 'User' } },
          ],
        },
      },
      'GET /user/installations/1/repositories': ({ url }) =>
        url.searchParams.get('page') === '2'
          ? { data: { repositories: [listed('abnegate', 'beta')] } }
          : {
              data: { repositories: [listed('abnegate', 'gamma')] },
              headers: { link: `<${next}>; rel="next"` },
            },
    });
    const response = await send('GET', '/api/repositories');

    assert.deepEqual(
      response.data.repositories.map((repository) => repository.fullName),
      ['abnegate/beta', 'abnegate/gamma'],
    );
    assert.equal(new URL(calls[1].url).searchParams.get('per_page'), '100');
  });

  test('returns an empty list when nothing is installed', async () => {
    const { send, calls } = client({
      'GET /user/installations': {
        data: { total_count: 0, installations: [] },
      },
    });
    const response = await send('GET', '/api/repositories');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      install: 'https://github.com/apps/ureview/installations/new',
      repositories: [],
    });
    assert.deepEqual(keys(calls), ['GET /user/installations']);
  });
});

describe('GET /api/repositories/:owner/:repository', () => {
  test('returns the status of a user repository with a repository-scoped read token', async () => {
    const { send, calls } = client(statusRoutes());
    const response = await send('GET', '/api/repositories/abnegate/edge');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, {
      owner: 'abnegate',
      name: 'edge',
      fullName: 'abnegate/edge',
      config: { review: true, severities: 'critical,high' },
      secrets: { oauth: true, push: false, apiKey: false },
      inherited: NONE,
    });
    assert.deepEqual(keys(calls).slice(0, 3), [
      'GET /repos/abnegate/edge',
      'GET /repos/abnegate/edge/installation',
      'POST /app/installations/42/access_tokens',
    ]);
    assert.equal(bearer(calls[0]), `Bearer ${USER_TOKEN}`);
    assert.ok(signedByApp(calls[1]));
    assert.ok(signedByApp(calls[2]));
    assert.deepEqual(calls[2].body, {
      repositories: ['edge'],
      permissions: READ,
    });
    const settings = calls.slice(3);
    assert.deepEqual(keys(settings).sort(), [
      'GET /repos/abnegate/edge/actions/secrets/UREVIEW_API_KEY_ABNEGATE',
      'GET /repos/abnegate/edge/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
      'GET /repos/abnegate/edge/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
      'GET /repos/abnegate/edge/actions/variables/UREVIEW_ABNEGATE',
    ]);
    for (const call of settings) {
      assert.equal(bearer(call), 'Bearer ghs_read', call.key);
    }
  });

  test('adds the inherited organization settings for an organization repository', async () => {
    const { send, calls } = client(
      statusRoutes({ owner: 'appwrite-labs', type: 'Organization' }),
    );
    const response = await send('GET', '/api/repositories/appwrite-labs/edge');

    assert.equal(response.status, 200);
    assert.deepEqual(response.data.inherited, {
      config: { improvement: true },
      secrets: { oauth: false, push: true, apiKey: false },
    });
    const inherited = calls.filter((call) =>
      call.key.includes('/actions/organization-'),
    );
    assert.deepEqual(keys(inherited).sort(), [
      'GET /repos/appwrite-labs/edge/actions/organization-secrets',
      'GET /repos/appwrite-labs/edge/actions/organization-variables',
    ]);
    for (const call of inherited) {
      assert.equal(bearer(call), 'Bearer ghs_read', call.key);
    }
  });

  test('reads the settings of the canonical repository GitHub returns', async () => {
    const routes = statusRoutes({ owner: 'Abnegate', repository: 'Edge' });
    routes['GET /repos/abnegate/edge'] = routes['GET /repos/Abnegate/Edge'];
    delete routes['GET /repos/Abnegate/Edge'];
    const { send, calls } = client(routes);
    const response = await send('GET', '/api/repositories/abnegate/edge');

    assert.equal(response.status, 200);
    assert.equal(response.data.owner, 'Abnegate');
    assert.equal(response.data.name, 'Edge');
    assert.equal(response.data.fullName, 'Abnegate/Edge');
    assert.deepEqual(response.data.config, {
      review: true,
      severities: 'critical,high',
    });
    assert.deepEqual(keys(calls).slice(0, 3), [
      'GET /repos/abnegate/edge',
      'GET /repos/Abnegate/Edge/installation',
      'POST /app/installations/42/access_tokens',
    ]);
    assert.deepEqual(calls[2].body, {
      repositories: ['Edge'],
      permissions: READ,
    });
    assert.deepEqual(keys(actionsCalls(calls)).sort(), [
      'GET /repos/Abnegate/Edge/actions/secrets/UREVIEW_API_KEY_ABNEGATE',
      'GET /repos/Abnegate/Edge/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
      'GET /repos/Abnegate/Edge/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
      'GET /repos/Abnegate/Edge/actions/variables/UREVIEW_ABNEGATE',
    ]);
  });

  test('reads the settings named for the signed-in user', async () => {
    const { send, calls } = client(statusRoutes({ key: 'SOME_USER' }), {
      login: 'some-user',
    });
    const response = await send('GET', '/api/repositories/abnegate/edge');

    assert.equal(response.status, 200);
    assert.deepEqual(keys(actionsCalls(calls)).sort(), [
      'GET /repos/abnegate/edge/actions/secrets/UREVIEW_API_KEY_SOME_USER',
      'GET /repos/abnegate/edge/actions/secrets/UREVIEW_OAUTH_TOKEN_SOME_USER',
      'GET /repos/abnegate/edge/actions/secrets/UREVIEW_PUSH_TOKEN_SOME_USER',
      'GET /repos/abnegate/edge/actions/variables/UREVIEW_SOME_USER',
    ]);
  });

  test('reports a hand-set API key at the repository and in the organization', async () => {
    const base = '/repos/appwrite-labs/edge/actions';
    const { send } = client({
      ...statusRoutes({ owner: 'appwrite-labs', type: 'Organization' }),
      [`GET ${base}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
      [`GET ${base}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: NOT_FOUND,
      [`GET ${base}/secrets/UREVIEW_API_KEY_ABNEGATE`]: {
        data: { name: 'UREVIEW_API_KEY_ABNEGATE' },
      },
      [`GET ${base}/organization-secrets`]: {
        data: {
          total_count: 2,
          secrets: [
            { name: 'UREVIEW_API_KEY_SOMEONE' },
            { name: 'UREVIEW_API_KEY_ABNEGATE' },
          ],
        },
      },
    });
    const response = await send('GET', '/api/repositories/appwrite-labs/edge');

    assert.equal(response.status, 200);
    assert.equal(response.data.config, null);
    assert.deepEqual(response.data.secrets, {
      oauth: false,
      push: false,
      apiKey: true,
    });
    assert.deepEqual(response.data.inherited.secrets, {
      oauth: false,
      push: false,
      apiKey: true,
    });
  });
});

describe('repository push gate', () => {
  const writes = [
    ['GET', '/api/repositories/abnegate/edge', undefined],
    ['PUT', '/api/repositories/abnegate/edge/config', { review: true }],
    [
      'PUT',
      '/api/repositories/abnegate/edge/tokens',
      { oauth: 'sk-ant-oat01-token', push: 'github_pat_token' },
    ],
    [
      'DELETE',
      '/api/repositories/abnegate/edge/tokens',
      undefined,
      { oauth: 'true', push: 'true' },
    ],
    ['DELETE', '/api/repositories/abnegate/edge', undefined],
  ];

  for (const [method, path, body, query] of writes) {
    test(`${method} ${path} without push access is forbidden and mints nothing`, async () => {
      const { send, calls } = client(gated());
      const response = await send(method, path, body, query);

      assert.equal(response.status, 403);
      assert.equal(response.data.error, 'forbidden');
      assert.deepEqual(keys(calls), ['GET /repos/abnegate/edge']);
      assert.equal(bearer(calls[0]), `Bearer ${USER_TOKEN}`);
    });

    test(`${method} ${path} with missing permissions is forbidden`, async () => {
      const { send, calls } = client(
        gated({
          'GET /repos/abnegate/edge': { data: { full_name: 'abnegate/edge' } },
        }),
      );
      const response = await send(method, path, body, query);

      assert.equal(response.status, 403);
      assert.deepEqual(keys(calls), ['GET /repos/abnegate/edge']);
    });

    test(`${method} ${path} with a non-boolean push permission is forbidden`, async () => {
      const { send, calls } = client(
        gated({
          'GET /repos/abnegate/edge': {
            data: { permissions: { push: 'true' } },
          },
        }),
      );
      const response = await send(method, path, body, query);

      assert.equal(response.status, 403);
      assert.deepEqual(keys(calls), ['GET /repos/abnegate/edge']);
    });

    test(`${method} ${path} under an old name acts on the renamed repository`, async () => {
      const routes = writeRoutes({ repository: 'edge-renamed' });
      const renamed = routes['GET /repos/abnegate/edge-renamed'];
      delete routes['GET /repos/abnegate/edge-renamed'];
      routes['GET /repos/abnegate/edge'] = renamed;
      routes[
        'GET /repos/abnegate/edge-renamed/actions/variables/UREVIEW_ABNEGATE'
      ] = NOT_FOUND;
      routes[
        'GET /repos/abnegate/edge-renamed/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE'
      ] = NOT_FOUND;
      routes[
        'GET /repos/abnegate/edge-renamed/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE'
      ] = NOT_FOUND;
      routes[
        'GET /repos/abnegate/edge-renamed/actions/secrets/UREVIEW_API_KEY_ABNEGATE'
      ] = NOT_FOUND;
      const { send, calls } = client(routes);
      const response = await send(method, path, body, query);

      assert.ok(response.status < 300, `status ${response.status}`);
      assert.deepEqual(keys(calls).slice(0, 3), [
        'GET /repos/abnegate/edge',
        'GET /repos/abnegate/edge-renamed/installation',
        'POST /app/installations/42/access_tokens',
      ]);
      assert.deepEqual(calls[2].body.repositories, ['edge-renamed']);
      const store = actionsCalls(calls);
      assert.ok(store.length > 0);
      for (const call of store) {
        assert.ok(
          call.key.includes(' /repos/abnegate/edge-renamed/actions/'),
          call.key,
        );
      }
    });

    test(`${method} ${path} without a canonical name is a GitHub failure and mints nothing`, async () => {
      const { send, calls } = client(
        gated({
          'GET /repos/abnegate/edge': {
            data: { permissions: { push: true }, owner: { login: 'abnegate' } },
          },
        }),
      );
      const response = await send(method, path, body, query);

      assert.equal(response.status, 502);
      assert.equal(response.data.error, 'github');
      assert.deepEqual(keys(calls), ['GET /repos/abnegate/edge']);
    });

    test(`${method} ${path} on a repository the user cannot see is not found`, async () => {
      const { send, calls } = client({
        ...writeRoutes(),
        'GET /repos/abnegate/edge': NOT_FOUND,
      });
      const response = await send(method, path, body, query);

      assert.equal(response.status, 404);
      assert.equal(response.data.error, 'not_found');
      assert.deepEqual(keys(calls), ['GET /repos/abnegate/edge']);
    });

    test(`${method} ${path} on a repository without the App installed is not found`, async () => {
      const { send, calls } = client({
        ...writeRoutes(),
        'GET /repos/abnegate/edge/installation': NOT_FOUND,
      });
      const response = await send(method, path, body, query);

      assert.equal(response.status, 404);
      assert.equal(response.data.error, 'not_found');
      assert.deepEqual(keys(calls), [
        'GET /repos/abnegate/edge',
        'GET /repos/abnegate/edge/installation',
      ]);
      assert.ok(signedByApp(calls[1]));
    });
  }
});

describe('PUT /api/repositories/:owner/:repository/config', () => {
  const body = {
    severities: 'high,critical,high',
    model: 'claude-sonnet-4-6',
    review: true,
    comments: false,
  };
  const canonical = {
    review: true,
    comments: false,
    severities: 'critical,high',
    model: 'claude-sonnet-4-6',
  };
  const serialized =
    '{"review":true,"comments":false,"severities":"critical,high","model":"claude-sonnet-4-6"}';

  test('mints a write token scoped to the repository and patches the variable', async () => {
    const { send, calls } = client(writeRoutes());
    const response = await send(
      'PUT',
      '/api/repositories/abnegate/edge/config',
      body,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.data, { config: canonical });
    assert.deepEqual(keys(calls), [
      'GET /repos/abnegate/edge',
      'GET /repos/abnegate/edge/installation',
      'POST /app/installations/42/access_tokens',
      'PATCH /repos/abnegate/edge/actions/variables/UREVIEW_ABNEGATE',
    ]);
    assert.equal(bearer(calls[0]), `Bearer ${USER_TOKEN}`);
    assert.ok(signedByApp(calls[1]));
    assert.ok(signedByApp(calls[2]));
    assert.deepEqual(calls[2].body, {
      repositories: ['edge'],
      permissions: WRITE,
    });
    assert.equal(bearer(calls[3]), 'Bearer ghs_write');
    assert.deepEqual(calls[3].body, {
      name: 'UREVIEW_ABNEGATE',
      value: serialized,
    });
  });

  test('creates the variable when it does not exist yet', async () => {
    const { send, calls } = client({
      ...writeRoutes(),
      'PATCH /repos/abnegate/edge/actions/variables/UREVIEW_ABNEGATE':
        NOT_FOUND,
    });
    const response = await send(
      'PUT',
      '/api/repositories/abnegate/edge/config',
      body,
    );

    assert.equal(response.status, 200);
    const created = calls.find(
      (call) => call.key === 'POST /repos/abnegate/edge/actions/variables',
    );
    assert.ok(created);
    assert.equal(bearer(created), 'Bearer ghs_write');
    assert.deepEqual(created.body, {
      name: 'UREVIEW_ABNEGATE',
      value: serialized,
    });
  });

  test('names the variable after the signed-in user, not the repository owner', async () => {
    const { send, calls } = client(
      writeRoutes({
        owner: 'appwrite-labs',
        repository: 'edge.js',
        key: 'SOME_USER',
      }),
      { login: 'some-user' },
    );
    const response = await send(
      'PUT',
      '/api/repositories/appwrite-labs/edge.js/config',
      { review: true },
    );

    assert.equal(response.status, 200);
    const mint = calls.find((call) => call.key.endsWith('/access_tokens'));
    assert.deepEqual(mint.body, {
      repositories: ['edge.js'],
      permissions: WRITE,
    });
    assert.deepEqual(keys(actionsCalls(calls)), [
      'PATCH /repos/appwrite-labs/edge.js/actions/variables/UREVIEW_SOME_USER',
    ]);
  });

  test('ignores names supplied in the query', async () => {
    const { send, calls } = client(writeRoutes());
    const response = await send(
      'PUT',
      '/api/repositories/abnegate/edge/config',
      { review: true },
      { name: 'UREVIEW_SOMEONE', variable: 'UREVIEW_SOMEONE' },
    );

    assert.equal(response.status, 200);
    assert.deepEqual(keys(actionsCalls(calls)), [
      'PATCH /repos/abnegate/edge/actions/variables/UREVIEW_ABNEGATE',
    ]);
  });

  const rejected = [
    ['a variable name', { name: 'UREVIEW_SOMEONE', review: true }],
    ['a variable key', { variable: 'UREVIEW_SOMEONE' }],
    ['a non-boolean flag', { review: 'yes' }],
    ['an unknown severity', { severities: 'critical,urgent' }],
    ['an empty severity list', { severities: '' }],
    ['a model with spaces', { model: 'claude opus' }],
    ['an array', [true]],
    ['null', null],
  ];

  for (const [label, invalid] of rejected) {
    test(`rejects ${label} without touching settings`, async () => {
      const { send, calls } = client(writeRoutes());
      const response = await send(
        'PUT',
        '/api/repositories/abnegate/edge/config',
        invalid,
      );

      assert.equal(response.status, 400);
      assert.equal(response.data.error, 'invalid');
      assert.deepEqual(actionsCalls(calls), []);
    });
  }
});

describe('PUT /api/repositories/:owner/:repository/tokens', () => {
  test('encrypts both tokens with one public key and writes the user-named secrets', async () => {
    const { send, calls } = client(writeRoutes());
    const response = await send(
      'PUT',
      '/api/repositories/abnegate/edge/tokens',
      { oauth: 'sk-ant-oat01-secret', push: 'github_pat_secret' },
    );

    assert.equal(response.status, 204);
    assert.equal(response.body, '');
    assert.deepEqual(keys(calls).slice(0, 4), [
      'GET /repos/abnegate/edge',
      'GET /repos/abnegate/edge/installation',
      'POST /app/installations/42/access_tokens',
      'GET /repos/abnegate/edge/actions/secrets/public-key',
    ]);
    assert.deepEqual(calls[2].body, {
      repositories: ['edge'],
      permissions: WRITE,
    });
    const writes = calls.slice(4);
    assert.deepEqual(keys(writes).sort(), [
      'PUT /repos/abnegate/edge/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
      'PUT /repos/abnegate/edge/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
    ]);
    const expected = {
      UREVIEW_OAUTH_TOKEN_ABNEGATE: 'sk-ant-oat01-secret',
      UREVIEW_PUSH_TOKEN_ABNEGATE: 'github_pat_secret',
    };
    for (const write of [calls[3], ...writes]) {
      assert.equal(bearer(write), 'Bearer ghs_write', write.key);
    }
    for (const write of writes) {
      const name = write.key.split('/').pop();
      assert.deepEqual(Object.keys(write.body).sort(), [
        'encrypted_value',
        'key_id',
      ]);
      assert.equal(write.body.key_id, 'key-1');
      assert.equal(decrypt(write.body.encrypted_value), expected[name]);
    }
  });

  test('writes only the push token when only push is given', async () => {
    const { send, calls } = client(writeRoutes());
    const response = await send(
      'PUT',
      '/api/repositories/abnegate/edge/tokens',
      { oauth: '', push: 'github_pat_only' },
    );

    assert.equal(response.status, 204);
    const writes = calls.filter((call) => call.method === 'PUT');
    assert.deepEqual(keys(writes), [
      'PUT /repos/abnegate/edge/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
    ]);
    assert.equal(decrypt(writes[0].body.encrypted_value), 'github_pat_only');
  });

  test('stores the trimmed token', async () => {
    const { send, calls } = client(writeRoutes());
    const response = await send(
      'PUT',
      '/api/repositories/abnegate/edge/tokens',
      { oauth: '  sk-ant-oat01-padded\n' },
    );

    assert.equal(response.status, 204);
    const writes = calls.filter((call) => call.method === 'PUT');
    assert.deepEqual(keys(writes), [
      'PUT /repos/abnegate/edge/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
    ]);
    assert.equal(
      decrypt(writes[0].body.encrypted_value),
      'sk-ant-oat01-padded',
    );
  });

  test('accepts a token of exactly 48 KiB', async () => {
    const token = 'a'.repeat(48 * 1024);
    const { send, calls } = client(writeRoutes());
    const response = await send(
      'PUT',
      '/api/repositories/abnegate/edge/tokens',
      { oauth: token },
    );

    assert.equal(response.status, 204);
    const write = calls.find((call) => call.method === 'PUT');
    assert.equal(decrypt(write.body.encrypted_value), token);
  });

  const rejected = [
    ['a secret name', { name: 'UREVIEW_OAUTH_TOKEN_SOMEONE', oauth: 'token' }],
    ['a secret name as the key', { UREVIEW_OAUTH_TOKEN_SOMEONE: 'token' }],
    ['an api key', { oauth: 'token', apiKey: 'sk-ant-api03-key' }],
    ['an empty body', {}],
    ['only blank values', { oauth: '   ', push: '' }],
    ['a token with whitespace inside', { oauth: 'two words' }],
    ['a non-string token', { oauth: 5 }],
    ['a null token', { push: null }],
    ['a token over 48 KiB', { oauth: 'a'.repeat(48 * 1024 + 1) }],
    ['a string body', 'sk-ant-oat01-token'],
    ['a null body', null],
  ];

  for (const [label, invalid] of rejected) {
    test(`rejects ${label} without writing secrets`, async () => {
      const { send, calls } = client(writeRoutes());
      const response = await send(
        'PUT',
        '/api/repositories/abnegate/edge/tokens',
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

describe('DELETE /api/repositories/:owner/:repository/tokens', () => {
  const path = '/api/repositories/abnegate/edge/tokens';

  test('deletes only the selected secrets with a repository-scoped write token', async () => {
    const { send, calls } = client(writeRoutes());
    const response = await send('DELETE', path, undefined, {
      oauth: 'true',
      push: 'true',
    });

    assert.equal(response.status, 204);
    assert.equal(response.body, '');
    assert.deepEqual(keys(calls).slice(0, 3), [
      'GET /repos/abnegate/edge',
      'GET /repos/abnegate/edge/installation',
      'POST /app/installations/42/access_tokens',
    ]);
    assert.deepEqual(calls[2].body, {
      repositories: ['edge'],
      permissions: WRITE,
    });
    const deletes = calls.slice(3);
    assert.deepEqual(keys(deletes).sort(), [
      'DELETE /repos/abnegate/edge/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
      'DELETE /repos/abnegate/edge/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
    ]);
    for (const call of deletes) {
      assert.equal(bearer(call), 'Bearer ghs_write', call.key);
    }
  });

  test('leaves the unselected token, the API key and the variable in place', async () => {
    const { send, calls } = client(writeRoutes());
    const response = await send('DELETE', path, undefined, { oauth: 'true' });

    assert.equal(response.status, 204);
    assert.deepEqual(keys(actionsCalls(calls)), [
      'DELETE /repos/abnegate/edge/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
    ]);
  });

  test('names the secrets after the signed-in user, not the repository owner', async () => {
    const { send, calls } = client(
      writeRoutes({ owner: 'appwrite-labs', key: 'SOME_USER' }),
      { login: 'some-user' },
    );
    const response = await send(
      'DELETE',
      '/api/repositories/appwrite-labs/edge/tokens',
      undefined,
      { push: 'true' },
    );

    assert.equal(response.status, 204);
    assert.deepEqual(keys(actionsCalls(calls)), [
      'DELETE /repos/appwrite-labs/edge/actions/secrets/UREVIEW_PUSH_TOKEN_SOME_USER',
    ]);
  });

  test('tolerates a selected secret that no longer exists', async () => {
    const { send } = client({
      ...writeRoutes(),
      'DELETE /repos/abnegate/edge/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE':
        NOT_FOUND,
    });
    const response = await send('DELETE', path, undefined, {
      oauth: 'true',
      push: 'true',
    });

    assert.equal(response.status, 204);
  });

  const rejected = [
    ['no selection', {}],
    ['the API key', { apiKey: 'true' }],
    ['the API key alongside a token', { oauth: 'true', apiKey: 'true' }],
    ['the variable', { variable: 'true' }],
    ['a secret name', { UREVIEW_API_KEY_ABNEGATE: 'true' }],
    ['a false selection', { oauth: 'false' }],
  ];

  for (const [label, query] of rejected) {
    test(`rejects ${label} without calling GitHub`, async () => {
      const { send, calls } = client(writeRoutes());
      const response = await send('DELETE', path, undefined, query);

      assert.equal(response.status, 400);
      assert.equal(response.data.error, 'invalid');
      assert.deepEqual(calls, []);
    });
  }
});

describe('DELETE /api/repositories/:owner/:repository', () => {
  test('removes the variable and all three secrets, tolerating missing ones', async () => {
    const { send, calls } = client(writeRoutes());
    const response = await send('DELETE', '/api/repositories/abnegate/edge');

    assert.equal(response.status, 204);
    assert.deepEqual(keys(calls).slice(0, 3), [
      'GET /repos/abnegate/edge',
      'GET /repos/abnegate/edge/installation',
      'POST /app/installations/42/access_tokens',
    ]);
    assert.deepEqual(calls[2].body, {
      repositories: ['edge'],
      permissions: WRITE,
    });
    const deletes = calls.slice(3);
    assert.deepEqual(keys(deletes).sort(), [
      'DELETE /repos/abnegate/edge/actions/secrets/UREVIEW_API_KEY_ABNEGATE',
      'DELETE /repos/abnegate/edge/actions/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE',
      'DELETE /repos/abnegate/edge/actions/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE',
      'DELETE /repos/abnegate/edge/actions/variables/UREVIEW_ABNEGATE',
    ]);
    for (const call of deletes) {
      assert.equal(bearer(call), 'Bearer ghs_write', call.key);
    }
  });
});
