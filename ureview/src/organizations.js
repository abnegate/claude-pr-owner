import { validate } from './config.js';
import * as enrolment from './enrolment.js';
import { GitHubError } from './GitHubError.js';
import { installations, request } from './github.js';
import { names } from './names.js';
import { empty, json } from './response.js';
import { validateTokens } from './secret.js';
import { Store } from './Store.js';

const DENIED = new Set([403, 404]);
const INTEGRATION = 'Resource not accessible by integration';
const ORGANIZATION = 'Organization';
const PERMISSION = 'permission';
const NOT_ADMIN = 'not_admin';

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

export async function saveConfig(context) {
  const config = validate(context.body);
  await store(context).saveConfig(names(context.user.login), config);
  return json(200, { config });
}

export async function saveTokens(context) {
  const tokens = validateTokens(context.body);
  const repositorySelection = await selection(context);
  await store(context, repositorySelection).saveSecrets(
    names(context.user.login),
    tokens,
  );
  return empty(204);
}

export async function enrol(context) {
  const submitted = enrolment.validate(context.body);
  const repositorySelection = await selection(context);
  return json(
    200,
    await enrolment.enrol(
      store(context, repositorySelection),
      names(context.user.login),
      submitted,
    ),
  );
}

export async function remove(context) {
  await store(context).remove(names(context.user.login));
  return empty(204);
}

function store({ fetch, params, user }, repositorySelection = null) {
  return Store.organization({
    fetch,
    token: user.token,
    organization: params.organization,
    repositorySelection,
  });
}

async function selection({ fetch, params, user }) {
  const found = await installation(fetch, user.token, params.organization);
  return found.repository_selection;
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
      config: null,
      secrets: { oauth: false, push: false, apiKey: false },
    };
  }
  const { config, secrets } = await Store.organization({
    fetch,
    token,
    organization: login,
  }).status(identifiers);
  return { login, admin: true, config, secrets };
}
