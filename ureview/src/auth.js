import { randomBytes, timingSafeEqual } from 'node:crypto';
import { exchangeCode, revoke, user } from './github.js';
import { empty, json, redirect } from './response.js';
import {
  SESSION_AGE,
  STATE_AGE,
  clearCookie,
  open,
  readCookie,
  seal,
  setCookie,
} from './session.js';
import { ValidationError } from './ValidationError.js';

const AUTHORIZE = 'https://github.com/login/oauth/authorize';
const CANCELLED = '/?signin=cancelled';

function callbackUrl(environment) {
  return `${environment.url}/auth/callback`;
}

function readSession(context, maxAge) {
  const value = readCookie(context.request.headers);
  if (value === null) {
    return null;
  }
  const payload = open(
    value,
    context.environment.sessionKey,
    maxAge,
    context.now(),
  );
  return payload !== null && typeof payload === 'object' ? payload : null;
}

function sameState(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string') {
    return false;
  }
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(actual, 'utf8');
  return (
    left.length > 0 &&
    left.length === right.length &&
    timingSafeEqual(left, right)
  );
}

function nonEmpty(value) {
  return typeof value === 'string' && value !== '';
}

export async function login(context) {
  const { environment, now } = context;
  const state = randomBytes(16).toString('hex');
  const cookie = setCookie(
    seal({ state, issued: now() }, environment.sessionKey),
    STATE_AGE,
  );
  const parameters = new URLSearchParams({
    client_id: environment.clientId,
    redirect_uri: callbackUrl(environment),
    state,
  });
  return redirect(`${AUTHORIZE}?${parameters}`, { 'set-cookie': cookie });
}

export async function callback(context) {
  const { environment, fetch, now, query } = context;
  const payload = readSession(context, STATE_AGE);
  if (nonEmpty(query.error) || !nonEmpty(query.code)) {
    const pending = typeof payload?.state === 'string';
    return redirect(CANCELLED, pending ? { 'set-cookie': clearCookie() } : {});
  }
  if (!sameState(payload?.state, query.state)) {
    throw new ValidationError('state');
  }
  const token = await exchangeCode(fetch, {
    clientId: environment.clientId,
    clientSecret: environment.clientSecret,
    code: query.code,
    redirectUri: callbackUrl(environment),
  });
  const profile = await user(fetch, token);
  const session = seal(
    { login: profile.login, token, avatar: profile.avatar, issued: now() },
    environment.sessionKey,
  );
  return redirect('/', { 'set-cookie': setCookie(session, SESSION_AGE) });
}

export async function logout(context) {
  const signedIn = currentUser(context);
  if (signedIn !== null) {
    const { environment, fetch } = context;
    await revoke(fetch, {
      clientId: environment.clientId,
      clientSecret: environment.clientSecret,
      token: signedIn.token,
    }).catch(() => {});
  }
  return empty(204, { 'set-cookie': clearCookie() });
}

export async function me(context) {
  const { login, avatar } = context.user;
  return json(200, { login, avatar });
}

export function currentUser(context) {
  const payload = readSession(context, SESSION_AGE);
  if (
    payload === null ||
    !nonEmpty(payload.login) ||
    !nonEmpty(payload.token)
  ) {
    return null;
  }
  const avatar = typeof payload.avatar === 'string' ? payload.avatar : null;
  return { login: payload.login, token: payload.token, avatar };
}
