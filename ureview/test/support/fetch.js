export const NOT_FOUND = Object.freeze({
  status: 404,
  data: { message: 'Not Found' },
});

export function mockFetch(routes = {}) {
  const calls = [];
  const fetch = async (input, init = {}) => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const prefix = url.origin === 'https://api.github.com' ? '' : url.origin;
    const key = `${method} ${prefix}${url.pathname}`;
    const headers = new Headers(init.headers);
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    calls.push({ key, method, url: url.toString(), headers, body });
    const handler = routes[key];
    if (handler === undefined) {
      throw new Error(`Unmatched request: ${key}`);
    }
    const result =
      typeof handler === 'function'
        ? await handler({ url, headers, body })
        : handler;
    const { status = 200, data = null, headers: responseHeaders = {} } = result;
    return new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: { 'content-type': 'application/json', ...responseHeaders },
    });
  };
  return { fetch, calls };
}
