import { readFileSync } from 'node:fs';
import { createApp } from './app.js';
import { Environment } from './Environment.js';

function read(name) {
  return readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
}

export function adapt(app) {
  return async ({ req: request, res: response, log, error }) => {
    const result = await app(
      {
        method: request.method,
        path: request.path,
        query: request.query ?? {},
        headers: request.headers ?? {},
        bodyText: request.bodyText ?? '',
      },
      { log, error },
    );
    return response.text(result.body, result.status, result.headers);
  };
}

const pages = Object.freeze({
  ui: read('ui.html'),
  manifest: read('manifest.html'),
  created: read('created.html'),
});

export default adapt(
  createApp({
    environment: Environment.from(process.env),
    fetch: globalThis.fetch,
    pages,
  }),
);
