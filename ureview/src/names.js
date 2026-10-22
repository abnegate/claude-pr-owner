import { ValidationError } from './ValidationError.js';

export const LOGIN = /^[A-Za-z0-9-]{1,39}$/;

export function loginKey(login) {
  if (typeof login !== 'string' || !LOGIN.test(login)) {
    throw new ValidationError('Invalid GitHub login.');
  }
  return login.toUpperCase().replaceAll('-', '_');
}

export function names(login) {
  const key = loginKey(login);
  return Object.freeze({
    variable: `UREVIEW_${key}`,
    oauth: `UREVIEW_OAUTH_TOKEN_${key}`,
    apiKey: `UREVIEW_API_KEY_${key}`,
    push: `UREVIEW_PUSH_TOKEN_${key}`,
  });
}
