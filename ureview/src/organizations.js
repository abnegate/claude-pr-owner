import { validate } from './config.js';
import * as enrolment from './enrolment.js';
import { GitHubError } from './GitHubError.js';
import { installations, paginate, request } from './github.js';
import { names } from './names.js';
import { empty, json } from './response.js';
import { validateTokens } from './secret.js';
import { Store, UNSCOPED } from './Store.js';
import { ValidationError } from './ValidationError.js';

const DENIED = new Set([403, 404]);
const INTEGRATION = 'Resource not accessible by integration';
const ORGANIZATION = 'Organization';
const PERMISSION = 'permission';
const NOT_ADMIN = 'not_admin';
const UNKNOWN = Object.freeze({
  config: null,
  secrets: Object.freeze({ oauth: false, push: false, apiKey: false }),
  repositories: null,
  exposed: Object.freeze([]),
});

export async function list(context) {
  const { fetch, user } = context;
  const identifiers = names(user.login);
  const logins = await installedOrganizations(fetch, user.token);
  const organizations = await Promise.all(
    logins.map((login) => describe(fetch, user.token, login, identifiers)),
  );
  return json(200, { organizations });
}

export async function get(context) {
  const { fetch, params, user } = context;
  const identifiers = names(user.login);
  const { account } = await installation(
    fetch,
    user.token,
    params.organization,
  );
  return json(
    200,
    await describe(fetch, user.token, account.login, identifiers),
  );
}

export async function listRepositories(context) {
  const { fetch, params, user } = context;
  const found = await installation(fetch, user.token, params.organization);
  const repositories = await paginate(fetch, {
    path: `/user/installations/${encodeURIComponent(found.id)}/repositories?per_page=100`,
    token: user.token,
    key: 'repositories',
  });
  return json(200, {
    repositories: repositories
      .filter(
        (repository) =>
          repository?.owner?.login?.toLowerCase() ===
          found.account.login.toLowerCase(),
      )
      .map(({ id, name, private: hidden }) => ({
        id,
        name,
        private: hidden === true,
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  });
}

export async function saveConfig(context) {
  const identifiers = names(context.user.login);
  const { repositories, rest } = await scoped(context, identifiers);
  const config = validate(rest);
  const scopedStore = store(context, repositories);
  await scopedStore.saveConfig(identifiers, config);
  await scopedStore.restrict(identifiers);
  return json(200, { config, repositories });
}

export async function saveTokens(context) {
  const identifiers = names(context.user.login);
  const { repositories, rest } = await scoped(context, identifiers);
  const tokens = validateTokens(rest);
  const scopedStore = store(context, repositories);
  await scopedStore.saveSecrets(identifiers, tokens);
  await scopedStore.restrict(identifiers);
  return empty(204);
}

export async function enrol(context) {
  const identifiers = names(context.user.login);
  const { repositories, rest } = await scoped(context, identifiers);
  const submitted = enrolment.validate(rest);
  const scopedStore = store(context, repositories);
  await enrolment.enrol(scopedStore, identifiers, submitted);
  await scopedStore.restrict(identifiers);
  return json(200, await scopedStore.status(identifiers));
}

export async function remove(context) {
  await store(context).remove(names(context.user.login));
  return empty(204);
}

function store({ fetch, params, user }, repositories = null) {
  return Store.organization({
    fetch,
    token: user.token,
    organization: params.organization,
    repositories,
  });
}

async function scoped(context, identifiers) {
  await installation(
    context.fetch,
    context.user.token,
    context.params.organization,
  );
  const body = context.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { repositories: null, rest: body };
  }
  const { repositories, ...rest } = body;
  if (repositories !== undefined) {
    return { repositories: validateRepositories(repositories), rest };
  }
  const current = await store(context).repositories(identifiers);
  if (current === null || current.length === 0) {
    throw new ValidationError(UNSCOPED);
  }
  return { repositories: current, rest };
}

function validateRepositories(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((id) => Number.isSafeInteger(id) && id > 0)
  ) {
    throw new ValidationError(
      'repositories must be a non-empty list of repository ids.',
    );
  }
  return [...new Set(value)];
}

async function organizationInstallations(fetch, token) {
  const installed = await installations(fetch, token);
  return installed.filter(
    (entry) =>
      entry?.account?.type === ORGANIZATION &&
      typeof entry.account.login === 'string',
  );
}

async function installedOrganizations(fetch, token) {
  const installed = await organizationInstallations(fetch, token);
  const logins = installed.map((entry) => entry.account.login);
  return [...new Set(logins)].sort();
}

async function installation(fetch, token, organization) {
  const requested = organization.toLowerCase();
  const installed = await organizationInstallations(fetch, token);
  const found = installed.find(
    (entry) => entry.account.login.toLowerCase() === requested,
  );
  if (found === undefined) {
    throw new GitHubError(
      404,
      'GET',
      `/orgs/${encodeURIComponent(organization)}`,
    );
  }
  return found;
}

function reason(status, data) {
  return status === 403 &&
    typeof data?.message === 'string' &&
    data.message.startsWith(INTEGRATION)
    ? PERMISSION
    : NOT_ADMIN;
}

async function describe(fetch, token, login, identifiers) {
  const path = `/orgs/${encodeURIComponent(login)}/actions/secrets/public-key`;
  const { status, data, headers } = await request(fetch, { path, token });
  if (status !== 200) {
    const failure = new GitHubError(status, 'GET', path, headers);
    if (failure.rateLimited || !DENIED.has(status)) {
      throw failure;
    }
    return {
      login,
      admin: false,
      reason: reason(status, data),
      ...UNKNOWN,
    };
  }
  const current = await Store.organization({
    fetch,
    token,
    organization: login,
  }).status(identifiers);
  return { login, admin: true, ...current };
}
