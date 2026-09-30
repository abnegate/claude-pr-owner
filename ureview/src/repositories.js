import { validate } from './config.js';
import { GitHubError } from './GitHubError.js';
import {
  appToken,
  installationToken,
  installations,
  paginate,
  repositoryInstallation,
  request,
} from './github.js';
import { names } from './names.js';
import { empty, json } from './response.js';
import { validateTokens } from './secret.js';
import { Store } from './Store.js';

const READ = Object.freeze({
  secrets: 'read',
  actions_variables: 'read',
  metadata: 'read',
});
const WRITE = Object.freeze({
  secrets: 'write',
  actions_variables: 'write',
  metadata: 'read',
});
const ORGANIZATION = 'Organization';
const UNINHERITED = Object.freeze({
  config: null,
  secrets: Object.freeze({ oauth: false, push: false }),
});

export async function list(context) {
  const { environment, fetch, user } = context;
  const installed = await installations(fetch, user.token);
  const grants = await Promise.all(
    installed.map((installation) =>
      pushable(fetch, user.token, installation.id),
    ),
  );
  const repositories = grants
    .flat()
    .map((repository) => ({
      owner: repository.owner.login,
      name: repository.name,
      fullName: repository.full_name,
    }))
    .sort(byFullName);
  return json(200, {
    install: `https://github.com/apps/${encodeURIComponent(environment.slug)}/installations/new`,
    repositories,
  });
}

export async function get(context) {
  const identifiers = names(context.user.login);
  const { repository, store } = await authorize(context, READ);
  const [status, inherited] = await Promise.all([
    store.status(identifiers),
    repository.owner.type === ORGANIZATION
      ? store.inherited(identifiers)
      : UNINHERITED,
  ]);
  return json(200, {
    owner: repository.owner.login,
    name: repository.name,
    fullName: repository.full_name,
    config: status.config,
    secrets: status.secrets,
    inherited,
  });
}

export async function saveConfig(context) {
  const config = validate(context.body);
  const { store } = await authorize(context, WRITE);
  await store.saveConfig(names(context.user.login), config);
  return json(200, { config });
}

export async function saveTokens(context) {
  const tokens = validateTokens(context.body);
  const { store } = await authorize(context, WRITE);
  await store.saveSecrets(names(context.user.login), tokens);
  return empty(204);
}

export async function remove(context) {
  const { store } = await authorize(context, WRITE);
  await store.remove(names(context.user.login));
  return empty(204);
}

async function pushable(fetch, token, installation) {
  const repositories = await paginate(fetch, {
    path: `/user/installations/${encodeURIComponent(installation)}/repositories?per_page=100`,
    token,
    key: 'repositories',
  });
  return repositories.filter(
    (repository) => repository?.permissions?.push === true,
  );
}

async function authorize(context, permissions) {
  const { environment, fetch, now, params, user } = context;
  const path = `/repos/${encodeURIComponent(params.owner)}/${encodeURIComponent(params.repository)}`;
  const { status, data, headers } = await request(fetch, {
    path,
    token: user.token,
  });
  if (status !== 200) {
    throw new GitHubError(status, 'GET', path, headers);
  }
  if (data?.permissions?.push !== true) {
    throw new GitHubError(403, 'GET', path);
  }
  const owner = data.owner?.login;
  const name = data.name;
  if (!isName(owner) || !isName(name)) {
    throw new GitHubError(502, 'GET', path);
  }
  const jwt = appToken(environment.appId, environment.privateKey, now());
  const installation = await repositoryInstallation(fetch, {
    jwt,
    owner,
    name,
  });
  if (installation === null) {
    throw new GitHubError(404, 'GET', `${path}/installation`);
  }
  const token = await installationToken(fetch, {
    jwt,
    installation,
    repositories: [name],
    permissions,
  });
  return {
    repository: data,
    store: Store.repository({ fetch, token, owner, name }),
  };
}

function isName(value) {
  return typeof value === 'string' && value !== '';
}

function byFullName(left, right) {
  if (left.fullName === right.fullName) {
    return 0;
  }
  return left.fullName < right.fullName ? -1 : 1;
}
