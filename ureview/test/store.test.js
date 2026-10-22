import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import sodium from 'libsodium-wrappers';
import { GitHubAppError } from '../src/GitHubAppError.js';
import { GitHubError } from '../src/GitHubError.js';
import { Store, UNSCOPED, VISIBILITY } from '../src/Store.js';
import { ValidationError } from '../src/ValidationError.js';
import { mockFetch, NOT_FOUND } from './support/fetch.js';

const names = Object.freeze({
  variable: 'UREVIEW_ABNEGATE',
  oauth: 'UREVIEW_OAUTH_TOKEN_ABNEGATE',
  apiKey: 'UREVIEW_API_KEY_ABNEGATE',
  push: 'UREVIEW_PUSH_TOKEN_ABNEGATE',
});

const repositoryBase = '/repos/abnegate/edge/actions';
const organizationBase = '/orgs/appwrite-labs/actions';

function absent(base) {
  return {
    [`GET ${base}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
    [`GET ${base}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: NOT_FOUND,
    [`GET ${base}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: NOT_FOUND,
    [`GET ${base}/secrets/UREVIEW_API_KEY_ABNEGATE`]: NOT_FOUND,
  };
}

function repository(fetch) {
  return Store.repository({
    fetch,
    token: 'ghs_install',
    owner: 'abnegate',
    name: 'edge',
  });
}

function organization(fetch, repositories = [7, 9]) {
  return Store.organization({
    fetch,
    token: 'gho_user',
    organization: 'appwrite-labs',
    repositories,
  });
}

function unscoped(error) {
  return error instanceof ValidationError && error.message === UNSCOPED;
}

function keys(calls) {
  return calls.map((call) => call.key);
}

async function keypair() {
  await sodium.ready;
  const pair = sodium.crypto_box_keypair();
  return {
    ...pair,
    encoded: sodium.to_base64(pair.publicKey, sodium.base64_variants.ORIGINAL),
  };
}

function decrypt(encrypted, pair) {
  return sodium.to_string(
    sodium.crypto_box_seal_open(
      sodium.from_base64(encrypted, sodium.base64_variants.ORIGINAL),
      pair.publicKey,
      pair.privateKey,
    ),
  );
}

describe('Store.status', () => {
  test('reads the variable and every secret when present', async () => {
    const { fetch, calls } = mockFetch({
      [`GET ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: {
        data: {
          name: 'UREVIEW_ABNEGATE',
          value: '{"review":true,"severities":"critical,high"}',
        },
      },
      [`GET ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE' },
      },
      [`GET ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_PUSH_TOKEN_ABNEGATE' },
      },
      [`GET ${repositoryBase}/secrets/UREVIEW_API_KEY_ABNEGATE`]: {
        data: { name: 'UREVIEW_API_KEY_ABNEGATE' },
      },
    });
    const status = await repository(fetch).status(names);
    assert.deepEqual(status, {
      config: { review: true, severities: 'critical,high' },
      secrets: { oauth: true, push: true, apiKey: true },
    });
    assert.deepEqual(keys(calls).sort(), [
      `GET ${repositoryBase}/secrets/UREVIEW_API_KEY_ABNEGATE`,
      `GET ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`,
      `GET ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`,
      `GET ${repositoryBase}/variables/UREVIEW_ABNEGATE`,
    ]);
    for (const call of calls) {
      assert.equal(call.headers.get('authorization'), 'Bearer ghs_install');
    }
  });

  test('reports absence as null and false on 404', async () => {
    const { fetch } = mockFetch(absent(repositoryBase));
    const status = await repository(fetch).status(names);
    assert.deepEqual(status, {
      config: null,
      secrets: { oauth: false, push: false, apiKey: false },
    });
  });

  test('reports a hand-set API key on its own', async () => {
    const { fetch } = mockFetch({
      ...absent(repositoryBase),
      [`GET ${repositoryBase}/secrets/UREVIEW_API_KEY_ABNEGATE`]: {
        data: { name: 'UREVIEW_API_KEY_ABNEGATE' },
      },
    });
    const status = await repository(fetch).status(names);
    assert.deepEqual(status, {
      config: null,
      secrets: { oauth: false, push: false, apiKey: true },
    });
  });

  test('mixes present and absent secrets', async () => {
    const { fetch } = mockFetch({
      ...absent(repositoryBase),
      [`GET ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_PUSH_TOKEN_ABNEGATE' },
      },
    });
    const status = await repository(fetch).status(names);
    assert.deepEqual(status, {
      config: null,
      secrets: { oauth: false, push: true, apiKey: false },
    });
  });

  test('parses an unparseable variable value to null', async () => {
    const { fetch } = mockFetch({
      ...absent(repositoryBase),
      [`GET ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: {
        data: { name: 'UREVIEW_ABNEGATE', value: 'not json' },
      },
    });
    const status = await repository(fetch).status(names);
    assert.equal(status.config, null);
  });

  test('uses the organization base', async () => {
    const { fetch, calls } = mockFetch({
      ...absent(organizationBase),
      [`GET ${organizationBase}/variables/UREVIEW_ABNEGATE`]: {
        data: { name: 'UREVIEW_ABNEGATE', value: '{"bots":false}' },
      },
      [`GET ${organizationBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE', visibility: 'selected' },
      },
    });
    const status = await organization(fetch).status(names);
    assert.deepEqual(status, {
      config: { bots: false },
      secrets: { oauth: true, push: false, apiKey: false },
      repositories: null,
      exposed: [],
    });
    assert.ok(calls.every((call) => call.key.includes(organizationBase)));
    assert.ok(
      calls.every(
        (call) => call.headers.get('authorization') === 'Bearer gho_user',
      ),
    );
  });

  test('reports the selected repositories and every secret not limited to them', async () => {
    const listing = `GET ${organizationBase}/variables/UREVIEW_ABNEGATE/repositories`;
    const next = `https://api.github.com${organizationBase}/variables/UREVIEW_ABNEGATE/repositories?per_page=100&page=2`;
    const { fetch, calls } = mockFetch({
      [`GET ${organizationBase}/variables/UREVIEW_ABNEGATE`]: {
        data: {
          name: 'UREVIEW_ABNEGATE',
          value: '{"review":true}',
          visibility: 'selected',
        },
      },
      [listing]: ({ url }) =>
        url.searchParams.get('page') === '2'
          ? { data: { total_count: 3, repositories: [{ id: 30 }] } }
          : {
              data: { total_count: 3, repositories: [{ id: 10 }, { id: 20 }] },
              headers: { link: `<${next}>; rel="next"` },
            },
      [`GET ${organizationBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE', visibility: 'all' },
      },
      [`GET ${organizationBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_PUSH_TOKEN_ABNEGATE', visibility: 'selected' },
      },
      [`GET ${organizationBase}/secrets/UREVIEW_API_KEY_ABNEGATE`]: {
        data: { name: 'UREVIEW_API_KEY_ABNEGATE', visibility: 'private' },
      },
    });
    const status = await organization(fetch).status(names);
    assert.deepEqual(status, {
      config: { review: true },
      secrets: { oauth: true, push: true, apiKey: true },
      repositories: [10, 20, 30],
      exposed: ['oauth', 'apiKey'],
    });
    const listed = calls.find((call) => call.key === listing);
    assert.equal(new URL(listed.url).searchParams.get('per_page'), '100');
    assert.equal(
      calls.some((call) => call.method !== 'GET'),
      false,
    );
    for (const call of calls) {
      assert.equal(call.headers.get('authorization'), 'Bearer gho_user');
    }
  });

  for (const [visibility, exposed] of [
    ['all', ['oauth']],
    ['private', ['oauth']],
    ['selected', []],
  ]) {
    test(`reports an organization secret with visibility ${visibility} as ${exposed.length === 0 ? 'not exposed' : 'exposed'}`, async () => {
      const { fetch } = mockFetch({
        ...absent(organizationBase),
        [`GET ${organizationBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
          data: { name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE', visibility },
        },
      });
      const status = await organization(fetch).status(names);
      assert.deepEqual(status.exposed, exposed);
    });
  }

  test('never reports an absent organization secret as exposed', async () => {
    const { fetch } = mockFetch(absent(organizationBase));
    const status = await organization(fetch).status(names);
    assert.deepEqual(status, {
      config: null,
      secrets: { oauth: false, push: false, apiKey: false },
      repositories: null,
      exposed: [],
    });
  });

  test('throws GitHubError on any other status', async () => {
    for (const status of [401, 403, 500]) {
      const { fetch } = mockFetch({
        ...absent(repositoryBase),
        [`GET ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: {
          status,
          data: { message: 'nope' },
        },
      });
      await assert.rejects(repository(fetch).status(names), (error) => {
        assert.ok(error instanceof GitHubError);
        assert.equal(error.status, status);
        return true;
      });
    }
  });

  test('throws GitHubError when a secret lookup fails', async () => {
    const { fetch } = mockFetch({
      ...absent(repositoryBase),
      [`GET ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        status: 403,
        data: { message: 'Resource not accessible by integration' },
      },
    });
    await assert.rejects(
      repository(fetch).status(names),
      (error) => error instanceof GitHubError && error.status === 403,
    );
  });

  test('URI-encodes path segments', async () => {
    const { fetch, calls } = mockFetch(
      absent('/repos/abnegate/we%20ird%23repo/actions'),
    );
    await Store.repository({
      fetch,
      token: 't',
      owner: 'abnegate',
      name: 'we ird#repo',
    }).status(names);
    assert.ok(
      calls.every((call) =>
        call.key.includes('/repos/abnegate/we%20ird%23repo/actions/'),
      ),
    );
  });

  test('throws GitHubAppError from a repository store, which uses an installation token', async () => {
    const { fetch } = mockFetch({
      ...absent(repositoryBase),
      [`GET ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: {
        status: 401,
        data: { message: 'Bad credentials' },
      },
    });
    await assert.rejects(
      repository(fetch).status(names),
      (error) => error instanceof GitHubAppError && error.status === 401,
    );
  });

  test('throws a plain GitHubError from an organization store, which uses the user token', async () => {
    const { fetch } = mockFetch({
      ...absent(organizationBase),
      [`GET ${organizationBase}/variables/UREVIEW_ABNEGATE`]: {
        status: 401,
        data: { message: 'Bad credentials' },
      },
    });
    await assert.rejects(
      organization(fetch).status(names),
      (error) =>
        error instanceof GitHubError &&
        !(error instanceof GitHubAppError) &&
        error.status === 401,
    );
  });

  test('carries the rate limit headers on the thrown error', async () => {
    const { fetch } = mockFetch({
      ...absent(repositoryBase),
      [`GET ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: {
        status: 403,
        data: { message: 'API rate limit exceeded' },
        headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1700' },
      },
    });
    await assert.rejects(repository(fetch).status(names), (error) => {
      assert.equal(error.rateLimited, true);
      assert.equal(error.reset, 1700);
      assert.equal(error.retryAfter, null);
      return true;
    });
  });
});

describe('Store.variable', () => {
  const path = `GET ${repositoryBase}/variables/UREVIEW_ABNEGATE`;

  test('returns the stored value verbatim, or null when it is absent', async () => {
    for (const [route, expected] of [
      [{ data: { value: '{"review":true}' } }, '{"review":true}'],
      [{ data: { value: 'not json' } }, 'not json'],
      [{ data: {} }, ''],
      [NOT_FOUND, null],
    ]) {
      const { fetch } = mockFetch({ [path]: route });
      assert.equal(await repository(fetch).variable(names), expected);
    }
  });

  test('throws on any other status', async () => {
    const { fetch } = mockFetch({
      [path]: { status: 502, data: {} },
    });
    await assert.rejects(
      repository(fetch).variable(names),
      (error) => error instanceof GitHubAppError && error.status === 502,
    );
  });
});

describe('Store.repositories', () => {
  const variable = `GET ${organizationBase}/variables/UREVIEW_ABNEGATE`;
  const listing = `${variable}/repositories`;

  test('returns null when the variable does not exist', async () => {
    const { fetch, calls } = mockFetch({ [variable]: NOT_FOUND });
    assert.equal(await organization(fetch).repositories(names), null);
    assert.deepEqual(keys(calls), [variable]);
  });

  for (const visibility of ['all', 'private', undefined]) {
    test(`returns null without listing when the variable visibility is ${visibility}`, async () => {
      const { fetch, calls } = mockFetch({
        [variable]: {
          data: { name: 'UREVIEW_ABNEGATE', value: '{}', visibility },
        },
      });
      assert.equal(await organization(fetch).repositories(names), null);
      assert.deepEqual(keys(calls), [variable]);
    });
  }

  test('lists every repository of a selected variable with the user token', async () => {
    const next = `https://api.github.com${organizationBase}/variables/UREVIEW_ABNEGATE/repositories?per_page=100&page=2`;
    const { fetch, calls } = mockFetch({
      [variable]: {
        data: { name: 'UREVIEW_ABNEGATE', value: '{}', visibility: 'selected' },
      },
      [listing]: ({ url }) =>
        url.searchParams.get('page') === '2'
          ? { data: { total_count: 3, repositories: [{ id: 3 }] } }
          : {
              data: { total_count: 3, repositories: [{ id: 1 }, { id: 2 }] },
              headers: { link: `<${next}>; rel="next"` },
            },
    });
    assert.deepEqual(await organization(fetch).repositories(names), [1, 2, 3]);
    assert.deepEqual(keys(calls), [variable, listing, listing]);
    assert.equal(new URL(calls[1].url).searchParams.get('per_page'), '100');
    for (const call of calls) {
      assert.equal(call.headers.get('authorization'), 'Bearer gho_user');
    }
  });

  test('returns an empty list for a selected variable with no repositories', async () => {
    const { fetch } = mockFetch({
      [variable]: {
        data: { name: 'UREVIEW_ABNEGATE', value: '{}', visibility: 'selected' },
      },
      [listing]: { data: { total_count: 0, repositories: [] } },
    });
    assert.deepEqual(await organization(fetch).repositories(names), []);
  });

  test('throws GitHubError when the listing fails', async () => {
    const { fetch } = mockFetch({
      [variable]: {
        data: { name: 'UREVIEW_ABNEGATE', value: '{}', visibility: 'selected' },
      },
      [listing]: { status: 403, data: { message: 'Forbidden' } },
    });
    await assert.rejects(
      organization(fetch).repositories(names),
      (error) => error instanceof GitHubError && error.status === 403,
    );
  });
});

describe('Store.restrict', () => {
  const variable = `PATCH ${organizationBase}/variables/UREVIEW_ABNEGATE`;

  function secrets(visibilities = {}) {
    return Object.fromEntries(
      Object.entries({
        oauth: 'UREVIEW_OAUTH_TOKEN_ABNEGATE',
        push: 'UREVIEW_PUSH_TOKEN_ABNEGATE',
        apiKey: 'UREVIEW_API_KEY_ABNEGATE',
      }).flatMap(([kind, name]) => [
        [
          `GET ${organizationBase}/secrets/${name}`,
          visibilities[kind] === undefined
            ? NOT_FOUND
            : { data: { name, visibility: visibilities[kind] } },
        ],
        [
          `PUT ${organizationBase}/secrets/${name}/repositories`,
          { status: 204 },
        ],
      ]),
    );
  }

  test('limits the variable and every selected secret to the repositories', async () => {
    const { fetch, calls } = mockFetch({
      ...secrets({ oauth: 'selected', push: 'selected', apiKey: 'selected' }),
      [variable]: { status: 204 },
    });
    await organization(fetch).restrict(names);
    const writes = calls.filter((call) => call.method !== 'GET');
    assert.deepEqual(keys(writes).sort(), [
      variable,
      `PUT ${organizationBase}/secrets/UREVIEW_API_KEY_ABNEGATE/repositories`,
      `PUT ${organizationBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE/repositories`,
      `PUT ${organizationBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE/repositories`,
    ]);
    for (const write of writes) {
      assert.deepEqual(
        write.body,
        write.key === variable
          ? { visibility: 'selected', selected_repository_ids: [7, 9] }
          : { selected_repository_ids: [7, 9] },
      );
    }
    for (const call of calls) {
      assert.equal(call.headers.get('authorization'), 'Bearer gho_user');
    }
  });

  test('never touches a secret shared with all or private repositories', async () => {
    const { fetch, calls } = mockFetch({
      ...secrets({ oauth: 'all', push: 'private', apiKey: 'selected' }),
      [variable]: { status: 204 },
    });
    await organization(fetch).restrict(names);
    assert.deepEqual(
      keys(calls.filter((call) => call.method !== 'GET')).sort(),
      [
        variable,
        `PUT ${organizationBase}/secrets/UREVIEW_API_KEY_ABNEGATE/repositories`,
      ],
    );
  });

  test('tolerates a missing variable and missing secrets', async () => {
    const { fetch, calls } = mockFetch({
      ...secrets(),
      [variable]: NOT_FOUND,
    });
    await organization(fetch).restrict(names);
    assert.deepEqual(keys(calls.filter((call) => call.method !== 'GET')), [
      variable,
    ]);
  });

  for (const repositories of [null, []]) {
    test(`refuses to restrict to ${JSON.stringify(repositories)} repositories before calling GitHub`, async () => {
      const { fetch, calls } = mockFetch({
        ...secrets({ oauth: 'selected' }),
        [variable]: { status: 204 },
      });
      await assert.rejects(
        organization(fetch, repositories).restrict(names),
        unscoped,
      );
      assert.deepEqual(calls, []);
    });
  }

  test('throws GitHubError when the variable cannot be restricted', async () => {
    const { fetch } = mockFetch({
      ...secrets(),
      [variable]: { status: 403, data: { message: 'Forbidden' } },
    });
    await assert.rejects(
      organization(fetch).restrict(names),
      (error) => error instanceof GitHubError && error.status === 403,
    );
  });

  test('throws GitHubError when a secret cannot be restricted', async () => {
    const { fetch } = mockFetch({
      ...secrets({ push: 'selected' }),
      [variable]: { status: 204 },
      [`PUT ${organizationBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE/repositories`]:
        { status: 409, data: { message: 'Conflict' } },
    });
    await assert.rejects(
      organization(fetch).restrict(names),
      (error) => error instanceof GitHubError && error.status === 409,
    );
  });
});

describe('Store.saveConfig', () => {
  const config = {
    effort: 'xhigh',
    model: 'claude-opus-5-5',
    severities: 'critical,high',
    comments: false,
    review: true,
  };
  const value =
    '{"review":true,"comments":false,"severities":"critical,high","model":"claude-opus-5-5","effort":"xhigh"}';

  test('updates the repository variable with PATCH', async () => {
    const { fetch, calls } = mockFetch({
      [`PATCH ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: { status: 204 },
    });
    await repository(fetch).saveConfig(names, config);
    assert.deepEqual(keys(calls), [
      `PATCH ${repositoryBase}/variables/UREVIEW_ABNEGATE`,
    ]);
    assert.deepEqual(calls[0].body, { name: 'UREVIEW_ABNEGATE', value });
    assert.equal(calls[0].headers.get('authorization'), 'Bearer ghs_install');
  });

  test('creates the repository variable with POST when PATCH is 404', async () => {
    const { fetch, calls } = mockFetch({
      [`PATCH ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
      [`POST ${repositoryBase}/variables`]: { status: 201 },
    });
    await repository(fetch).saveConfig(names, config);
    assert.deepEqual(keys(calls), [
      `PATCH ${repositoryBase}/variables/UREVIEW_ABNEGATE`,
      `POST ${repositoryBase}/variables`,
    ]);
    assert.deepEqual(calls[1].body, { name: 'UREVIEW_ABNEGATE', value });
  });

  test('omits visibility on an organization PATCH so GitHub keeps the existing one', async () => {
    const { fetch, calls } = mockFetch({
      [`PATCH ${organizationBase}/variables/UREVIEW_ABNEGATE`]: {
        status: 204,
      },
    });
    await organization(fetch).saveConfig(names, config);
    assert.deepEqual(keys(calls), [
      `PATCH ${organizationBase}/variables/UREVIEW_ABNEGATE`,
    ]);
    assert.deepEqual(calls[0].body, { name: 'UREVIEW_ABNEGATE', value });
    assert.equal(calls[0].headers.get('authorization'), 'Bearer gho_user');
  });

  test('creates an organization variable visible only to the given repositories on POST', async () => {
    const { fetch, calls } = mockFetch({
      [`PATCH ${organizationBase}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
      [`POST ${organizationBase}/variables`]: { status: 201 },
    });
    await organization(fetch).saveConfig(names, config);
    assert.deepEqual(keys(calls), [
      `PATCH ${organizationBase}/variables/UREVIEW_ABNEGATE`,
      `POST ${organizationBase}/variables`,
    ]);
    assert.deepEqual(calls[1].body, {
      name: 'UREVIEW_ABNEGATE',
      value,
      visibility: 'selected',
      selected_repository_ids: [7, 9],
    });
    assert.equal(calls[1].headers.get('authorization'), 'Bearer gho_user');
  });

  for (const repositories of [null, []]) {
    test(`refuses to create an organization variable with ${JSON.stringify(repositories)} repositories`, async () => {
      const { fetch, calls } = mockFetch({
        [`PATCH ${organizationBase}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
        [`POST ${organizationBase}/variables`]: { status: 201 },
      });
      await assert.rejects(
        organization(fetch, repositories).saveConfig(names, config),
        unscoped,
      );
      assert.deepEqual(keys(calls), [
        `PATCH ${organizationBase}/variables/UREVIEW_ABNEGATE`,
      ]);
    });
  }

  test('omits absent keys from the serialized value', async () => {
    const { fetch, calls } = mockFetch({
      [`PATCH ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: { status: 204 },
    });
    await repository(fetch).saveConfig(names, { healing: true });
    assert.equal(calls[0].body.value, '{"healing":true}');
  });

  test('throws GitHubError when PATCH is refused', async () => {
    const { fetch, calls } = mockFetch({
      [`PATCH ${organizationBase}/variables/UREVIEW_ABNEGATE`]: {
        status: 403,
        data: { message: 'Must have admin rights' },
      },
    });
    await assert.rejects(
      organization(fetch).saveConfig(names, config),
      (error) => error instanceof GitHubError && error.status === 403,
    );
    assert.equal(calls.length, 1);
  });

  test('throws GitHubError when POST does not return 201', async () => {
    const { fetch } = mockFetch({
      [`PATCH ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: NOT_FOUND,
      [`POST ${repositoryBase}/variables`]: {
        status: 422,
        data: { message: 'Already exists' },
      },
    });
    await assert.rejects(
      repository(fetch).saveConfig(names, config),
      (error) => error instanceof GitHubError && error.status === 422,
    );
  });
});

describe('Store.saveSecrets', () => {
  test('fetches the public key once and seals each secret', async () => {
    const pair = await keypair();
    const { fetch, calls } = mockFetch({
      [`GET ${repositoryBase}/secrets/public-key`]: {
        data: { key_id: 'key-1', key: pair.encoded },
      },
      [`PUT ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        status: 201,
      },
      [`PUT ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        status: 204,
      },
    });
    await repository(fetch).saveSecrets(names, {
      oauth: 'sk-ant-oat01-token',
      push: 'github_pat_push',
    });
    const publicKeyCalls = calls.filter(
      (call) => call.key === `GET ${repositoryBase}/secrets/public-key`,
    );
    assert.equal(publicKeyCalls.length, 1);
    const puts = calls.filter((call) => call.method === 'PUT');
    assert.deepEqual(puts.map((call) => call.key).sort(), [
      `PUT ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`,
      `PUT ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`,
    ]);
    const byName = Object.fromEntries(
      puts.map((call) => [call.key.split('/').pop(), call]),
    );
    const oauth = byName.UREVIEW_OAUTH_TOKEN_ABNEGATE;
    const push = byName.UREVIEW_PUSH_TOKEN_ABNEGATE;
    assert.deepEqual(Object.keys(oauth.body).sort(), [
      'encrypted_value',
      'key_id',
    ]);
    assert.equal(oauth.body.key_id, 'key-1');
    assert.equal(push.body.key_id, 'key-1');
    assert.equal(
      decrypt(oauth.body.encrypted_value, pair),
      'sk-ant-oat01-token',
    );
    assert.equal(decrypt(push.body.encrypted_value, pair), 'github_pat_push');
    for (const call of calls) {
      assert.equal(call.headers.get('authorization'), 'Bearer ghs_install');
    }
  });

  test('writes only the secrets provided', async () => {
    const pair = await keypair();
    const { fetch, calls } = mockFetch({
      [`GET ${repositoryBase}/secrets/public-key`]: {
        data: { key_id: 'key-1', key: pair.encoded },
      },
      [`PUT ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        status: 201,
      },
    });
    await repository(fetch).saveSecrets(names, { push: 'github_pat_push' });
    assert.deepEqual(keys(calls), [
      `GET ${repositoryBase}/secrets/public-key`,
      `PUT ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`,
    ]);
    assert.equal(
      decrypt(calls[1].body.encrypted_value, pair),
      'github_pat_push',
    );
  });

  test('never reads an existing repository secret before writing it', async () => {
    const pair = await keypair();
    const { fetch, calls } = mockFetch({
      [`GET ${repositoryBase}/secrets/public-key`]: {
        data: { key_id: 'key-1', key: pair.encoded },
      },
      [`PUT ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        status: 201,
      },
    });
    await repository(fetch).saveSecrets(names, { oauth: 'sk-ant-oat01-token' });
    assert.deepEqual(keys(calls), [
      `GET ${repositoryBase}/secrets/public-key`,
      `PUT ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`,
    ]);
  });

  function organizationSecret(pair, extra = {}) {
    return {
      [`GET ${organizationBase}/secrets/public-key`]: {
        data: { key_id: 'org-key', key: pair.encoded },
      },
      [`PUT ${organizationBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        status: 204,
      },
      ...extra,
    };
  }

  test('writes an organization secret with visibility selected and the given repositories without reading it first', async () => {
    const pair = await keypair();
    const { fetch, calls } = mockFetch(organizationSecret(pair));
    await organization(fetch).saveSecrets(names, { oauth: 'sk-ant-oat01-org' });
    assert.equal(VISIBILITY, 'selected');
    assert.deepEqual(keys(calls), [
      `GET ${organizationBase}/secrets/public-key`,
      `PUT ${organizationBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`,
    ]);
    const put = calls[1];
    assert.deepEqual(Object.keys(put.body).sort(), [
      'encrypted_value',
      'key_id',
      'selected_repository_ids',
      'visibility',
    ]);
    assert.equal(put.body.key_id, 'org-key');
    assert.equal(put.body.visibility, VISIBILITY);
    assert.deepEqual(put.body.selected_repository_ids, [7, 9]);
    assert.equal(decrypt(put.body.encrypted_value, pair), 'sk-ant-oat01-org');
    for (const call of calls) {
      assert.equal(call.headers.get('authorization'), 'Bearer gho_user');
    }
  });

  test('scopes every organization secret it writes to the same repositories', async () => {
    const pair = await keypair();
    const { fetch, calls } = mockFetch(
      organizationSecret(pair, {
        [`PUT ${organizationBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
          status: 201,
        },
      }),
    );
    await organization(fetch, [42]).saveSecrets(names, {
      oauth: 'sk-ant-oat01-org',
      push: 'github_pat_org',
    });
    const puts = calls.filter((call) => call.method === 'PUT');
    assert.equal(puts.length, 2);
    for (const put of puts) {
      assert.equal(put.body.visibility, 'selected');
      assert.deepEqual(put.body.selected_repository_ids, [42]);
    }
  });

  for (const repositories of [null, []]) {
    test(`refuses to write an organization secret with ${JSON.stringify(repositories)} repositories`, async () => {
      const pair = await keypair();
      const { fetch, calls } = mockFetch(organizationSecret(pair));
      await assert.rejects(
        organization(fetch, repositories).saveSecrets(names, {
          oauth: 'sk-ant-oat01-org',
        }),
        unscoped,
      );
      assert.equal(
        calls.some((call) => call.method === 'PUT'),
        false,
      );
    });
  }

  test('throws GitHubError when a PUT fails', async () => {
    const pair = await keypair();
    const { fetch } = mockFetch({
      [`GET ${repositoryBase}/secrets/public-key`]: {
        data: { key_id: 'key-1', key: pair.encoded },
      },
      [`PUT ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        status: 422,
        data: { message: 'Bad key' },
      },
    });
    await assert.rejects(
      repository(fetch).saveSecrets(names, { oauth: 'sk-ant-oat01-token' }),
      (error) => error instanceof GitHubError && error.status === 422,
    );
  });

  test('lets every PUT settle before rejecting with the failed one', async () => {
    const pair = await keypair();
    let pushed = false;
    const { fetch } = mockFetch({
      [`GET ${repositoryBase}/secrets/public-key`]: {
        data: { key_id: 'key-1', key: pair.encoded },
      },
      [`PUT ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        status: 422,
        data: { message: 'Bad key' },
      },
      [`PUT ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]:
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          pushed = true;
          return { status: 201 };
        },
    });
    await assert.rejects(
      repository(fetch).saveSecrets(names, {
        oauth: 'sk-ant-oat01-token',
        push: 'github_pat_push',
      }),
      (error) => error instanceof GitHubAppError && error.status === 422,
    );
    assert.equal(pushed, true, 'the push PUT settled before the rejection');
  });

  test('rejects with the first failure when every PUT fails', async () => {
    const pair = await keypair();
    const { fetch, calls } = mockFetch({
      [`GET ${repositoryBase}/secrets/public-key`]: {
        data: { key_id: 'key-1', key: pair.encoded },
      },
      [`PUT ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]:
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return { status: 422, data: { message: 'Bad key' } };
        },
      [`PUT ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        status: 403,
        data: { message: 'Resource not accessible by integration' },
      },
    });
    await assert.rejects(
      repository(fetch).saveSecrets(names, {
        oauth: 'sk-ant-oat01-token',
        push: 'github_pat_push',
      }),
      (error) => error instanceof GitHubAppError && error.status === 422,
    );
    assert.equal(calls.filter((call) => call.method === 'PUT').length, 2);
  });

  test('throws GitHubError when the public key is refused', async () => {
    const { fetch, calls } = mockFetch({
      [`GET ${organizationBase}/secrets/public-key`]: {
        status: 403,
        data: { message: 'Must have admin rights' },
      },
    });
    await assert.rejects(
      organization(fetch).saveSecrets(names, { oauth: 'sk-ant-oat01-org' }),
      (error) => error instanceof GitHubError && error.status === 403,
    );
    assert.equal(
      calls.some((call) => call.method === 'PUT'),
      false,
    );
  });
});

describe('Store.remove', () => {
  const deletes = [
    `DELETE ${repositoryBase}/variables/UREVIEW_ABNEGATE`,
    `DELETE ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`,
    `DELETE ${repositoryBase}/secrets/UREVIEW_API_KEY_ABNEGATE`,
    `DELETE ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`,
  ];

  test('deletes the variable and the three secrets', async () => {
    const { fetch, calls } = mockFetch(
      Object.fromEntries(deletes.map((key) => [key, { status: 204 }])),
    );
    await repository(fetch).remove(names);
    assert.deepEqual(keys(calls).sort(), [...deletes].sort());
  });

  test('tolerates 404 for names that do not exist', async () => {
    const { fetch, calls } = mockFetch({
      ...Object.fromEntries(deletes.map((key) => [key, NOT_FOUND])),
      [deletes[0]]: { status: 204 },
    });
    await repository(fetch).remove(names);
    assert.deepEqual(keys(calls).sort(), [...deletes].sort());
  });

  test('uses the organization base', async () => {
    const { fetch, calls } = mockFetch(
      Object.fromEntries(
        deletes.map((key) => [
          key.replace(repositoryBase, organizationBase),
          { status: 204 },
        ]),
      ),
    );
    await organization(fetch).remove(names);
    assert.equal(calls.length, 4);
    assert.ok(
      calls.every(
        (call) =>
          call.method === 'DELETE' && call.key.includes(organizationBase),
      ),
    );
  });

  test('throws GitHubError on any other status', async () => {
    const { fetch } = mockFetch({
      ...Object.fromEntries(deletes.map((key) => [key, { status: 204 }])),
      [deletes[1]]: { status: 403, data: { message: 'Forbidden' } },
    });
    await assert.rejects(
      repository(fetch).remove(names),
      (error) => error instanceof GitHubError && error.status === 403,
    );
  });
});

describe('Store.presence', () => {
  test('reports whether the variable and each secret exist', async () => {
    const { fetch, calls } = mockFetch({
      ...absent(repositoryBase),
      [`GET ${repositoryBase}/variables/UREVIEW_ABNEGATE`]: {
        data: { name: 'UREVIEW_ABNEGATE', value: 'not json' },
      },
      [`GET ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`]: {
        data: { name: 'UREVIEW_PUSH_TOKEN_ABNEGATE' },
      },
    });
    assert.deepEqual(await repository(fetch).presence(names), {
      variable: true,
      oauth: false,
      push: true,
      apiKey: false,
    });
    assert.deepEqual(
      keys(calls).sort(),
      Object.keys(absent(repositoryBase)).sort(),
    );
  });

  test('throws on any status other than 200 or 404', async () => {
    const { fetch } = mockFetch({
      ...absent(organizationBase),
      [`GET ${organizationBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`]: {
        status: 403,
        data: { message: 'Must have admin rights to Repository.' },
      },
    });
    await assert.rejects(
      organization(fetch).presence(names),
      (error) => error instanceof GitHubError && error.status === 403,
    );
  });
});

describe('Store.removeSecrets', () => {
  const oauth = `DELETE ${repositoryBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`;
  const push = `DELETE ${repositoryBase}/secrets/UREVIEW_PUSH_TOKEN_ABNEGATE`;

  test('deletes only the named kinds and reports each as removed', async () => {
    const { fetch, calls } = mockFetch({ [push]: { status: 204 } });
    assert.deepEqual(await repository(fetch).removeSecrets(names, ['push']), {
      removed: ['push'],
      failed: [],
    });
    assert.deepEqual(keys(calls), [push]);
    assert.equal(calls[0].headers.get('authorization'), 'Bearer ghs_install');
  });

  test('tolerates 404 for a secret that was never written', async () => {
    const { fetch } = mockFetch({
      [oauth]: NOT_FOUND,
      [push]: { status: 204 },
    });
    assert.deepEqual(
      await repository(fetch).removeSecrets(names, ['oauth', 'push']),
      { removed: ['oauth', 'push'], failed: [] },
    );
  });

  test('waits for every delete and reports the ones that failed', async () => {
    let settled = false;
    const { fetch } = mockFetch({
      [oauth]: { status: 502, data: { message: 'boom' } },
      [push]: async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        settled = true;
        return { status: 204 };
      },
    });
    assert.deepEqual(
      await repository(fetch).removeSecrets(names, ['oauth', 'push']),
      { removed: ['push'], failed: ['oauth'] },
    );
    assert.equal(settled, true);
  });

  test('uses the organization base', async () => {
    const { fetch, calls } = mockFetch({
      [oauth.replace(repositoryBase, organizationBase)]: { status: 204 },
    });
    await organization(fetch).removeSecrets(names, ['oauth']);
    assert.deepEqual(keys(calls), [
      `DELETE ${organizationBase}/secrets/UREVIEW_OAUTH_TOKEN_ABNEGATE`,
    ]);
    assert.equal(calls[0].headers.get('authorization'), 'Bearer gho_user');
  });
});

describe('Store.inherited', () => {
  const variablesKey = `GET ${repositoryBase}/organization-variables`;
  const secretsKey = `GET ${repositoryBase}/organization-secrets`;

  test('matches organization variables and secrets by name', async () => {
    const { fetch, calls } = mockFetch({
      [variablesKey]: {
        data: {
          total_count: 3,
          variables: [
            { name: 'UREVIEW_ABNEGATE_EXTRA', value: '{"bots":true}' },
            { name: 'OTHER', value: 'x' },
            { name: 'UREVIEW_ABNEGATE', value: '{"review":true}' },
          ],
        },
      },
      [secretsKey]: {
        data: {
          total_count: 2,
          secrets: [
            { name: 'UREVIEW_OAUTH_TOKEN_SOMEONE' },
            { name: 'UREVIEW_PUSH_TOKEN_ABNEGATE' },
          ],
        },
      },
    });
    const inherited = await repository(fetch).inherited(names);
    assert.deepEqual(inherited, {
      config: { review: true },
      secrets: { oauth: false, push: true, apiKey: false },
    });
    const variablesCall = calls.find((call) => call.key === variablesKey);
    const secretsCall = calls.find((call) => call.key === secretsKey);
    assert.equal(new URL(variablesCall.url).searchParams.get('per_page'), '30');
    assert.equal(new URL(secretsCall.url).searchParams.get('per_page'), '100');
    assert.equal(
      variablesCall.headers.get('authorization'),
      'Bearer ghs_install',
    );
  });

  test('finds matches on later pages', async () => {
    const variablesNext = `https://api.github.com${repositoryBase}/organization-variables?per_page=30&page=2`;
    const secretsNext = `https://api.github.com${repositoryBase}/organization-secrets?per_page=100&page=2`;
    const { fetch, calls } = mockFetch({
      [variablesKey]: ({ url }) =>
        url.searchParams.get('page') === '2'
          ? {
              data: {
                variables: [
                  { name: 'UREVIEW_ABNEGATE', value: '{"bots":true}' },
                ],
              },
            }
          : {
              data: { variables: [{ name: 'OTHER', value: 'x' }] },
              headers: { link: `<${variablesNext}>; rel="next"` },
            },
      [secretsKey]: ({ url }) =>
        url.searchParams.get('page') === '2'
          ? { data: { secrets: [{ name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE' }] } }
          : {
              data: { secrets: [{ name: 'UNRELATED' }] },
              headers: { link: `<${secretsNext}>; rel="next"` },
            },
    });
    const inherited = await repository(fetch).inherited(names);
    assert.deepEqual(inherited, {
      config: { bots: true },
      secrets: { oauth: true, push: false, apiKey: false },
    });
    assert.equal(calls.length, 4);
  });

  test('reports nothing inherited when no name matches', async () => {
    const { fetch } = mockFetch({
      [variablesKey]: { data: { variables: [] } },
      [secretsKey]: {
        data: {
          secrets: [
            { name: 'UREVIEW_API_KEY_SOMEONE' },
            { name: 'UREVIEW_OAUTH_TOKEN_ABNEGATE_EXTRA' },
          ],
        },
      },
    });
    const inherited = await repository(fetch).inherited(names);
    assert.deepEqual(inherited, {
      config: null,
      secrets: { oauth: false, push: false, apiKey: false },
    });
  });

  test('reports an inherited organization API key', async () => {
    const { fetch } = mockFetch({
      [variablesKey]: { data: { variables: [] } },
      [secretsKey]: {
        data: { secrets: [{ name: 'ureview_api_key_abnegate' }] },
      },
    });
    const inherited = await repository(fetch).inherited(names);
    assert.deepEqual(inherited, {
      config: null,
      secrets: { oauth: false, push: false, apiKey: true },
    });
  });

  test('throws GitHubError when a listing fails', async () => {
    const { fetch } = mockFetch({
      [variablesKey]: { status: 403, data: { message: 'Forbidden' } },
      [secretsKey]: { data: { secrets: [] } },
    });
    await assert.rejects(
      repository(fetch).inherited(names),
      (error) => error instanceof GitHubError && error.status === 403,
    );
  });
});
