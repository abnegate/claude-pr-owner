const SAME_ORIGIN = 'same-origin';

export const NO_REFERRER = 'no-referrer';

function security(referrer = SAME_ORIGIN) {
  return {
    'referrer-policy': referrer,
    'x-content-type-options': 'nosniff',
  };
}

function policy(formAction, scripts) {
  return [
    "default-src 'none'",
    `script-src ${scripts.length === 0 ? "'none'" : scripts.join(' ')}`,
    "style-src 'unsafe-inline'",
    'img-src https://avatars.githubusercontent.com',
    "connect-src 'self'",
    `form-action ${formAction}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export function json(status, data, headers = {}) {
  return {
    status,
    headers: {
      ...security(),
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
    body: JSON.stringify(data),
  };
}

export function html(
  { body, scripts },
  { formAction = "'self'", referrer = SAME_ORIGIN } = {},
) {
  return {
    status: 200,
    headers: {
      ...security(referrer),
      'content-type': 'text/html; charset=utf-8',
      'x-frame-options': 'DENY',
      'content-security-policy': policy(formAction, scripts),
    },
    body,
  };
}

export function empty(status = 204, headers = {}) {
  return { status, headers: { ...security(), ...headers }, body: '' };
}

export function redirect(location, headers = {}) {
  return {
    status: 302,
    headers: { ...security(), ...headers, location },
    body: '',
  };
}

export function failure(status, error, message, headers = {}) {
  const data = message === undefined ? { error } : { error, message };
  return json(status, data, headers);
}
