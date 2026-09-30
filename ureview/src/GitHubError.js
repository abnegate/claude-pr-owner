const RATE_LIMITED = new Set([403, 429]);
const SECONDS = /^[0-9]+$/;

function seconds(value) {
  return typeof value === 'string' && SECONDS.test(value)
    ? Number(value)
    : null;
}

export class GitHubError extends Error {
  constructor(status, method, path, headers = new Headers()) {
    super(`GitHub responded ${status} to ${method} ${path}`);
    this.name = 'GitHubError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.rateLimited =
      RATE_LIMITED.has(status) &&
      (headers.has('retry-after') ||
        headers.get('x-ratelimit-remaining') === '0');
    this.retryAfter = seconds(headers.get('retry-after'));
    this.reset = seconds(headers.get('x-ratelimit-reset'));
  }
}
