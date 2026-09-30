import { NOT_FOUND } from './fetch.js';

const PREFIXES = Object.freeze({
  oauth: 'UREVIEW_OAUTH_TOKEN_',
  push: 'UREVIEW_PUSH_TOKEN_',
  apiKey: 'UREVIEW_API_KEY_',
});

export function actions(
  base,
  { key = 'ABNEGATE', publicKey, variable = null, secrets = [] } = {},
) {
  const name = `UREVIEW_${key}`;
  const state = { variable, secrets: new Set(secrets) };
  const routes = {
    [`GET ${base}/secrets/public-key`]: {
      data: { key_id: 'key-1', key: publicKey },
    },
    [`GET ${base}/variables/${name}`]: () =>
      state.variable === null
        ? NOT_FOUND
        : { data: { name, value: state.variable, visibility: 'all' } },
    [`PATCH ${base}/variables/${name}`]: ({ body }) => {
      if (state.variable === null) {
        return NOT_FOUND;
      }
      state.variable = body.value;
      return { status: 204 };
    },
    [`POST ${base}/variables`]: ({ body }) => {
      state.variable = body.value;
      return { status: 201 };
    },
  };
  for (const [kind, prefix] of Object.entries(PREFIXES)) {
    const path = `${base}/secrets/${prefix}${key}`;
    routes[`GET ${path}`] = () =>
      state.secrets.has(kind)
        ? { data: { name: `${prefix}${key}`, visibility: 'all' } }
        : NOT_FOUND;
    routes[`PUT ${path}`] = () => {
      const existed = state.secrets.has(kind);
      state.secrets.add(kind);
      return { status: existed ? 204 : 201 };
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
