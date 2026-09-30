import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { page, scriptHashes } from '../src/page.js';

function hash(content) {
  return `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`;
}

describe('scriptHashes', () => {
  it('hashes the exact text between the script tags', () => {
    const script = "\n  const greeting = 'héllo';\n  console.log(greeting);\n";
    const html = `<!doctype html><title>t</title><script type="module">${script}</script>`;
    assert.deepEqual(scriptHashes(html), [hash(script)]);
    assert.equal(
      scriptHashes(html)[0],
      "'sha256-" +
        createHash('sha256').update(Buffer.from(script)).digest('base64') +
        "'",
    );
  });

  it('hashes every inline script once, in page order', () => {
    const html =
      '<script>first()</script><p><SCRIPT>second()</SCRIPT></p><script>first()</script >';
    assert.deepEqual(scriptHashes(html), [hash('first()'), hash('second()')]);
  });

  it('returns nothing for a page without scripts', () => {
    assert.deepEqual(scriptHashes('<!doctype html><title>t</title>'), []);
  });
});

describe('page', () => {
  it('keeps the body and freezes the hashes', () => {
    const body = '<script>run()</script>';
    const document = page(body);
    assert.equal(document.body, body);
    assert.deepEqual(document.scripts, [hash('run()')]);
    assert.ok(Object.isFrozen(document));
    assert.ok(Object.isFrozen(document.scripts));
  });
});
