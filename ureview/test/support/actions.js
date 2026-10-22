import { NOT_FOUND } from './fetch.js';

const PREFIXES = Object.freeze({
  oauth: 'UREVIEW_OAUTH_TOKEN_',
  push: 'UREVIEW_PUSH_TOKEN_',
  apiKey: 'UREVIEW_API_KEY_',
});

const SHARED = 'all';
const SELECTED = 'selected';
const CONFLICT = Object.freeze({
  status: 409,
  data: { message: 'Secret visibility must be set to selected' },
});

export function actions(
  base,
  {
    key = 'ABNEGATE',
    publicKey,
    variable = null,
    secrets = [],
    visibility = {},
    repositories = [],
  } = {},
) {
  const name = `UREVIEW_${key}`;
  const entries = ['variable', ...Object.keys(PREFIXES)];
  const state = {
    variable,
    secrets: new Set(secrets),
    visibility: Object.fromEntries(
      entries.map((entry) => [entry, visibility[entry] ?? SHARED]),
    ),
    repositories: Object.fromEntries(
      entries.map((entry) => [entry, [...repositories]]),
    ),
  };
  const scope = (entry, body) => {
    if (body.visibility !== undefined) {
      state.visibility[entry] = body.visibility;
    }
    if (body.selected_repository_ids !== undefined) {
      state.repositories[entry] = [...body.selected_repository_ids];
    }
  };
  const listing = (entry) => ({
    data: {
      total_count: state.repositories[entry].length,
      repositories: state.repositories[entry].map((id) => ({ id })),
    },
  });
  const variablePath = `${base}/variables/${name}`;
  const routes = {
    [`GET ${base}/secrets/public-key`]: {
      data: { key_id: 'key-1', key: publicKey },
    },
    [`GET ${variablePath}`]: () =>
      state.variable === null
        ? NOT_FOUND
        : {
            data: {
              name,
              value: state.variable,
              visibility: state.visibility.variable,
            },
          },
    [`GET ${variablePath}/repositories`]: () =>
      state.variable === null ? NOT_FOUND : listing('variable'),
    [`PATCH ${variablePath}`]: ({ body }) => {
      if (state.variable === null) {
        return NOT_FOUND;
      }
      if (body.value !== undefined) {
        state.variable = body.value;
      }
      scope('variable', body);
      return { status: 204 };
    },
    [`POST ${base}/variables`]: ({ body }) => {
      state.variable = body.value;
      scope('variable', body);
      return { status: 201 };
    },
  };
  for (const [kind, prefix] of Object.entries(PREFIXES)) {
    const path = `${base}/secrets/${prefix}${key}`;
    routes[`GET ${path}`] = () =>
      state.secrets.has(kind)
        ? {
            data: {
              name: `${prefix}${key}`,
              visibility: state.visibility[kind],
            },
          }
        : NOT_FOUND;
    routes[`PUT ${path}`] = ({ body }) => {
      const existed = state.secrets.has(kind);
      state.secrets.add(kind);
      scope(kind, body);
      return { status: existed ? 204 : 201 };
    };
    routes[`PUT ${path}/repositories`] = ({ body }) => {
      if (!state.secrets.has(kind)) {
        return NOT_FOUND;
      }
      if (state.visibility[kind] !== SELECTED) {
        return CONFLICT;
      }
      scope(kind, body);
      return { status: 204 };
    };
    routes[`DELETE ${path}`] = () =>
      state.secrets.delete(kind) ? { status: 204 } : NOT_FOUND;
  }
  return { routes, state };
}

export function mutations(calls) {
  return calls.filter(
    (call) => call.method !== 'GET' && call.key.includes('/actions/'),
  );
}
