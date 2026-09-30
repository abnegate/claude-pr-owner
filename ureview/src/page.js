import { createHash } from 'node:crypto';

const SCRIPT = /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi;

export function scriptHashes(body) {
  const hashes = [...body.matchAll(SCRIPT)].map(
    ([, content]) =>
      `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`,
  );
  return [...new Set(hashes)];
}

export function page(body) {
  return Object.freeze({ body, scripts: Object.freeze(scriptHashes(body)) });
}
