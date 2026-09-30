import { createSign } from 'node:crypto';
import { GitHubAppError } from './GitHubAppError.js';
import { GitHubError } from './GitHubError.js';

export const API = 'https://api.github.com';

const OAUTH = 'https://github.com';
const NEXT = /<([^>]+)>;\s*rel="next"/;

function successful(status) {
  return status >= 200 && status < 300;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function parseBody(response) {
  if (response.status === 204) {
    return null;
  }
  const text = await response.text();
  if (text === '') {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function request(
  fetch,
  { method = 'GET', path, token = null, body, headers = {} },
) {
  const url = path.startsWith('https://') ? path : `${API}${path}`;
  const init = {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'ureview',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(url, init);
  return {
    status: response.status,
    data: await parseBody(response),
    headers: response.headers,
  };
}

function nextPage(headers) {
  const match = NEXT.exec(headers.get('link') ?? '');
  if (match === null) {
    return null;
  }
  const url = new URL(match[1], API);
  return url.origin === API ? url.toString() : null;
}

export async function paginate(
  fetch,
  { path, token, key, Failure = GitHubError },
) {
  const items = [];
  let url = path;
  while (url !== null) {
    const { status, data, headers } = await request(fetch, {
      path: url,
      token,
    });
    if (!successful(status)) {
      throw new Failure(status, 'GET', url, headers);
    }
    items.push(...(data?.[key] ?? []));
    url = nextPage(headers);
  }
  return items;
}

export async function installations(fetch, token) {
  return paginate(fetch, {
    path: '/user/installations?per_page=100',
    token,
    key: 'installations',
  });
}

export function appToken(appId, privateKey, now = Date.now()) {
  const seconds = Math.floor(now / 1000);
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({
    iat: seconds - 60,
    exp: seconds + 540,
    iss: String(appId),
  })}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(privateKey, 'base64url');
  return `${unsigned}.${signature}`;
}

export async function installationToken(
  fetch,
  { jwt, installation, repositories, permissions },
) {
  const path = `/app/installations/${encodeURIComponent(installation)}/access_tokens`;
  const { status, data, headers } = await request(fetch, {
    method: 'POST',
    path,
    token: jwt,
    body: {
      permissions,
      ...(repositories === undefined ? {} : { repositories }),
    },
  });
  if (status !== 201 || typeof data?.token !== 'string') {
    throw new GitHubAppError(status, 'POST', path, headers);
  }
  return data.token;
}

export async function repositoryInstallation(fetch, { jwt, owner, name }) {
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`;
  const { status, data, headers } = await request(fetch, {
    path,
    token: jwt,
  });
  if (status === 404) {
    return null;
  }
  if (status !== 200) {
    throw new GitHubAppError(status, 'GET', path, headers);
  }
  if (!Number.isInteger(data?.id)) {
    throw new GitHubAppError(502, 'GET', path);
  }
  return data.id;
}

export async function exchangeCode(
  fetch,
  { clientId, clientSecret, code, redirectUri },
) {
  const path = '/login/oauth/access_token';
  const { status, data } = await request(fetch, {
    method: 'POST',
    path: `${OAUTH}${path}`,
    headers: { accept: 'application/json' },
    body: {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    },
  });
  if (status >= 500) {
    throw new GitHubError(status, 'POST', path);
  }
  if (
    !successful(status) ||
    data?.error !== undefined ||
    typeof data?.access_token !== 'string'
  ) {
    throw new GitHubError(400, 'POST', path);
  }
  return data.access_token;
}

export async function user(fetch, token) {
  const path = '/user';
  const { status, data, headers } = await request(fetch, { path, token });
  if (status !== 200) {
    throw new GitHubError(status, 'GET', path, headers);
  }
  return { login: data.login, avatar: data.avatar_url };
}

export async function revoke(fetch, { clientId, clientSecret, token }) {
  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString(
    'base64',
  );
  const { status } = await request(fetch, {
    method: 'DELETE',
    path: `/applications/${encodeURIComponent(clientId)}/token`,
    headers: { authorization: `Basic ${credentials}` },
    body: { access_token: token },
  });
  return status;
}
