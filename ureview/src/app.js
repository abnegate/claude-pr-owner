import { callback, currentUser, login, logout, me } from './auth.js';
import { EnrolmentError } from './EnrolmentError.js';
import { GitHubAppError } from './GitHubAppError.js';
import { GitHubError } from './GitHubError.js';
import { LOGIN } from './names.js';
import * as organizations from './organizations.js';
import { page } from './page.js';
import * as repositories from './repositories.js';
import { empty, failure, html, json, NO_REFERRER } from './response.js';
import { clearCookie } from './session.js';
import { ValidationError } from './ValidationError.js';

const REPOSITORY = /^[A-Za-z0-9._-]{1,100}$/;
const RESERVED = new Set(['.', '..']);

const PARAMETERS = Object.freeze({
  owner: (value) => LOGIN.test(value),
  organization: (value) => LOGIN.test(value),
  repository: (value) => REPOSITORY.test(value) && !RESERVED.has(value),
});

const UNCONFIGURED = new Set(['/', '/setup', '/setup/complete']);
const PROTECTED = '/api/';
const HEAD = 'HEAD';
const OPTIONS = 'OPTIONS';
const SAFE = new Set(['GET', HEAD, OPTIONS]);

function compile(method, path, handler) {
  return Object.freeze({
    method,
    path,
    handler,
    segments: path.split('/'),
    authenticated: path.startsWith(PROTECTED),
  });
}

function match(route, segments) {
  if (route.segments.length !== segments.length) {
    return null;
  }
  const params = {};
  for (const [index, segment] of route.segments.entries()) {
    const value = segments[index];
    if (!segment.startsWith(':')) {
      if (segment !== value) {
        return null;
      }
      continue;
    }
    const name = segment.slice(1);
    if (!PARAMETERS[name](value)) {
      return null;
    }
    params[name] = value;
  }
  return params;
}

function find(routes, method, path) {
  const segments = path.split('/');
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const params = match(route, segments);
    if (params !== null) {
      return { route, params };
    }
  }
  return null;
}

function allowed(routes, path) {
  const segments = path.split('/');
  const methods = new Set(
    routes
      .filter((route) => match(route, segments) !== null)
      .map((route) => route.method),
  );
  if (methods.size === 0) {
    return null;
  }
  if (methods.has('GET')) {
    methods.add(HEAD);
  }
  methods.add(OPTIONS);
  return [...methods].join(', ');
}

function normalizeHeaders(headers) {
  const normalized = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

function decodeQuery(query) {
  const decoded = {};
  for (const [name, value] of Object.entries(query ?? {})) {
    if (typeof value !== 'string') {
      continue;
    }
    try {
      decoded[name] = decodeURIComponent(value);
    } catch {
      decoded[name] = value;
    }
  }
  return decoded;
}

function parseBody(bodyText) {
  try {
    return { body: JSON.parse(bodyText || '{}') };
  } catch {
    return null;
  }
}

function describe(thrown) {
  if (!(thrown instanceof Error)) {
    return `Unexpected ${typeof thrown} thrown`;
  }
  const frames = (thrown.stack ?? '').split('\n').slice(1).join('\n');
  return `Unexpected ${thrown.name}${frames === '' ? '' : `\n${frames}`}`;
}

function retryAfter(thrown, now) {
  if (thrown.retryAfter !== null) {
    return thrown.retryAfter;
  }
  if (thrown.reset !== null) {
    return Math.max(0, thrown.reset - Math.floor(now() / 1000));
  }
  return undefined;
}

function rateLimited(seconds) {
  if (seconds === undefined) {
    return json(429, { error: 'rate_limited' });
  }
  return json(
    429,
    { error: 'rate_limited', retryAfter: seconds },
    { 'retry-after': String(seconds) },
  );
}

function outcome({ rolledBack, rollbackFailed, tokensWritten, uncertain }) {
  return {
    ...(rolledBack.length === 0 ? {} : { rolledBack }),
    ...(rollbackFailed.length === 0 ? {} : { rollbackFailed }),
    ...(tokensWritten.length === 0 ? {} : { tokensWritten }),
    ...(uncertain ? { uncertain } : {}),
  };
}

function annotate(response, fields) {
  return {
    ...response,
    body: JSON.stringify({ ...JSON.parse(response.body), ...fields }),
  };
}

function mapError(thrown, error, now) {
  if (thrown instanceof EnrolmentError) {
    return annotate(mapError(thrown.cause, error, now), outcome(thrown));
  }
  if (thrown instanceof ValidationError) {
    return failure(400, 'invalid', thrown.message);
  }
  if (thrown instanceof GitHubError && thrown.rateLimited) {
    return rateLimited(retryAfter(thrown, now));
  }
  if (thrown instanceof GitHubAppError && thrown.status === 401) {
    error(thrown.message);
    return failure(502, 'github_app');
  }
  if (thrown instanceof GitHubError) {
    switch (thrown.status) {
      case 401:
        return failure(401, 'unauthenticated', undefined, {
          'set-cookie': clearCookie(),
        });
      case 403:
        return failure(403, 'forbidden');
      case 404:
        return failure(404, 'not_found');
      default:
        error(thrown.message);
        return failure(502, 'github');
    }
  }
  error(describe(thrown));
  return failure(500, 'internal');
}

export function createApp({ environment, fetch, pages, now = Date.now }) {
  const ui = page(pages.ui);
  const manifest = page(pages.manifest);
  const created = page(pages.created);
  const setupPage = (document, options) => async () =>
    environment.configured
      ? failure(404, 'not_found')
      : html(document, options);

  const routes = [
    compile('GET', '/', async () => html(ui)),
    compile(
      'GET',
      '/setup',
      setupPage(manifest, { formAction: 'https://github.com' }),
    ),
    compile(
      'GET',
      '/setup/complete',
      setupPage(created, { referrer: NO_REFERRER }),
    ),
    compile('GET', '/auth/login', login),
    compile('GET', '/auth/callback', callback),
    compile('POST', '/auth/logout', logout),
    compile('GET', '/api/me', me),
    compile('GET', '/api/repositories', repositories.list),
    compile('GET', '/api/repositories/:owner/:repository', repositories.get),
    compile(
      'PUT',
      '/api/repositories/:owner/:repository/config',
      repositories.saveConfig,
    ),
    compile(
      'PUT',
      '/api/repositories/:owner/:repository/tokens',
      repositories.saveTokens,
    ),
    compile(
      'PUT',
      '/api/repositories/:owner/:repository/enrolment',
      repositories.enrol,
    ),
    compile(
      'DELETE',
      '/api/repositories/:owner/:repository',
      repositories.remove,
    ),
    compile('GET', '/api/organizations', organizations.list),
    compile('GET', '/api/organizations/:organization', organizations.get),
    compile(
      'PUT',
      '/api/organizations/:organization/config',
      organizations.saveConfig,
    ),
    compile(
      'PUT',
      '/api/organizations/:organization/tokens',
      organizations.saveTokens,
    ),
    compile(
      'PUT',
      '/api/organizations/:organization/enrolment',
      organizations.enrol,
    ),
    compile('DELETE', '/api/organizations/:organization', organizations.remove),
  ];

  async function dispatch(request, method, log, error) {
    const path =
      typeof request.path === 'string' && request.path !== ''
        ? request.path
        : '/';
    const headers = normalizeHeaders(request.headers);

    if (!environment.configured && !UNCONFIGURED.has(path)) {
      return failure(503, 'unconfigured');
    }
    if (
      !SAFE.has(method) &&
      (!environment.configured || headers.origin !== environment.url)
    ) {
      return failure(403, 'origin');
    }

    if (method === OPTIONS) {
      const allow = allowed(routes, path);
      return allow === null ? failure(404, 'not_found') : empty(204, { allow });
    }

    const found = find(routes, method === HEAD ? 'GET' : method, path);
    if (found === null) {
      return failure(404, 'not_found');
    }

    const context = {
      request: {
        method,
        path,
        headers,
        bodyText: request.bodyText ?? '',
      },
      query: decodeQuery(request.query),
      environment,
      fetch,
      now,
      log,
      error,
      params: found.params,
      body: undefined,
      user: null,
    };

    if (found.route.authenticated) {
      context.user = currentUser(context);
      if (context.user === null) {
        return failure(401, 'unauthenticated');
      }
    }

    if (method === 'PUT') {
      const parsed = parseBody(context.request.bodyText);
      if (parsed === null) {
        return failure(400, 'invalid_json');
      }
      context.body = parsed.body;
    }

    return found.route.handler(context);
  }

  async function handle(request, { log = () => {}, error = () => {} } = {}) {
    const method = String(request?.method ?? 'GET').toUpperCase();
    let response;
    try {
      response = await dispatch(request ?? {}, method, log, error);
    } catch (thrown) {
      response = mapError(thrown, error, now);
    }
    log(`${method} ${request?.path ?? '/'} ${response.status}`);
    return method === HEAD ? { ...response, body: '' } : response;
  }

  return handle;
}
