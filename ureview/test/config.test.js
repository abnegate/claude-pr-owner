import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ValidationError } from '../src/ValidationError.js';
import {
  EFFORTS,
  FLAGS,
  MODEL,
  SEVERITIES,
  parse,
  serialize,
  validate,
} from '../src/config.js';

describe('config constants', () => {
  it('lists the flags in contract order', () => {
    assert.deepEqual(FLAGS, [
      'review',
      'comments',
      'improvement',
      'healing',
      'bots',
    ]);
  });

  it('lists the severities in canonical order', () => {
    assert.deepEqual(SEVERITIES, ['critical', 'high', 'medium', 'low']);
  });

  it('lists the effort levels Claude Code accepts, lowest first', () => {
    assert.deepEqual(EFFORTS, ['low', 'medium', 'high', 'xhigh', 'max']);
  });

  it('matches model ids that start with an alphanumeric', () => {
    for (const model of [
      'claude-opus-5-5',
      'claude-sonnet-4.6',
      'Model_1',
      'x',
      'claude-opus-4-6[1m]',
      'claude-sonnet-4.6[1M]',
    ]) {
      assert.ok(MODEL.test(model), model);
    }
    for (const model of [
      '',
      '-claude',
      '.claude',
      'claude opus',
      'a/b',
      'claude[]',
      'claude[1m',
      'claude[1m][2m]',
      'claude[1-m]',
      '[1m]',
      'claude[1m]x',
    ]) {
      assert.ok(!MODEL.test(model), model);
    }
  });
});

describe('validate', () => {
  it('accepts a complete config', () => {
    assert.deepEqual(
      validate({
        review: true,
        comments: false,
        improvement: true,
        healing: false,
        bots: true,
        severities: 'critical,high',
        model: 'claude-opus-5-5',
        effort: 'xhigh',
      }),
      {
        review: true,
        comments: false,
        improvement: true,
        healing: false,
        bots: true,
        severities: 'critical,high',
        model: 'claude-opus-5-5',
        effort: 'xhigh',
      },
    );
  });

  it('accepts an empty object', () => {
    assert.deepEqual(validate({}), {});
  });

  it('keeps only the keys that were given', () => {
    assert.deepEqual(validate({ healing: true }), { healing: true });
  });

  it('orders severities canonically', () => {
    assert.deepEqual(validate({ severities: 'low,critical,medium' }), {
      severities: 'critical,medium,low',
    });
  });

  it('deduplicates severities', () => {
    assert.deepEqual(validate({ severities: 'high,critical,high' }), {
      severities: 'critical,high',
    });
  });

  it('accepts every severity', () => {
    assert.deepEqual(validate({ severities: 'medium,low,high,critical' }), {
      severities: 'critical,high,medium,low',
    });
  });

  it('keeps a model with a context window suffix', () => {
    assert.deepEqual(validate({ model: 'claude-opus-4-6[1m]' }), {
      model: 'claude-opus-4-6[1m]',
    });
    assert.deepEqual(parse('{"model":"claude-opus-4-6[1m]"}'), {
      model: 'claude-opus-4-6[1m]',
    });
  });

  it('omits an empty model', () => {
    assert.deepEqual(validate({ review: true, model: '' }), { review: true });
  });

  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
    it(`accepts the effort ${effort}`, () => {
      assert.deepEqual(validate({ effort }), { effort });
    });
  }

  it('omits an empty effort, which means the default', () => {
    assert.deepEqual(validate({ review: true, effort: '' }), { review: true });
  });

  for (const body of [null, undefined, 'review', 5, true, [], [{}]]) {
    it(`rejects a non-object body ${JSON.stringify(body)}`, () => {
      assert.throws(() => validate(body), ValidationError);
    });
  }

  for (const key of ['name', 'token', 'oauth', 'Review', 'severity']) {
    it(`rejects the unknown key ${key}`, () => {
      assert.throws(
        () => validate({ review: true, [key]: true }),
        ValidationError,
      );
    });
  }

  for (const flag of ['review', 'comments', 'improvement', 'healing', 'bots']) {
    for (const value of ['true', 1, 0, null, {}]) {
      it(`rejects ${flag} set to ${JSON.stringify(value)}`, () => {
        assert.throws(() => validate({ [flag]: value }), ValidationError);
      });
    }
  }

  for (const severities of [
    '',
    'urgent',
    'critical,urgent',
    ['critical'],
    1,
    null,
  ]) {
    it(`rejects severities ${JSON.stringify(severities)}`, () => {
      assert.throws(() => validate({ severities }), ValidationError);
    });
  }

  for (const model of [
    'claude opus',
    '-claude',
    '.claude',
    'a/b',
    'a;b',
    'claude[1m',
    'claude[1m]x',
    5,
    null,
    true,
  ]) {
    it(`rejects the model ${JSON.stringify(model)}`, () => {
      assert.throws(() => validate({ model }), ValidationError);
    });
  }

  for (const effort of [
    'High',
    ' high',
    'high ',
    'minimal',
    'ultracode',
    'low,high',
    ['high'],
    3,
    true,
    null,
    {},
  ]) {
    it(`rejects the effort ${JSON.stringify(effort)}`, () => {
      assert.throws(
        () => validate({ effort }),
        (error) =>
          error instanceof ValidationError &&
          error.message ===
            'effort must be one of low, medium, high, xhigh, max.',
      );
    });
  }
});

describe('parse', () => {
  it('parses a valid config', () => {
    assert.deepEqual(
      parse(
        '{"review":true,"bots":false,"severities":"critical,high","model":"claude-opus-5-5","effort":"max"}',
      ),
      {
        review: true,
        bots: false,
        severities: 'critical,high',
        model: 'claude-opus-5-5',
        effort: 'max',
      },
    );
  });

  it('parses an empty object', () => {
    assert.deepEqual(parse('{}'), {});
  });

  it('keeps only the valid fields', () => {
    assert.deepEqual(
      parse(
        JSON.stringify({
          review: true,
          comments: 'yes',
          improvement: 1,
          healing: false,
          bots: null,
          severities: 'urgent',
          model: 'claude opus',
          effort: 'extreme',
          extra: 'ignored',
        }),
      ),
      { review: true, healing: false },
    );
  });

  it('drops an empty model, an empty effort and non-string severities', () => {
    assert.deepEqual(
      parse(
        '{"model":"","effort":"","severities":["critical"],"review":false}',
      ),
      {
        review: false,
      },
    );
  });

  for (const value of [
    'not json',
    '{"review":',
    '',
    '[]',
    '[{"review":true}]',
    'null',
    '5',
    '"review"',
    'true',
    undefined,
    null,
  ]) {
    it(`returns null for ${JSON.stringify(value)}`, () => {
      assert.equal(parse(value), null);
    });
  }

  it('round-trips through serialize', () => {
    const config = {
      review: true,
      comments: true,
      improvement: false,
      healing: true,
      bots: false,
      severities: 'critical,low',
      model: 'claude-sonnet-4.6',
      effort: 'medium',
    };
    assert.deepEqual(parse(serialize(config)), config);
  });

  for (const effort of [3, true, null, ['high'], 'HIGH']) {
    it(`drops the effort ${JSON.stringify(effort)}`, () => {
      assert.deepEqual(parse(JSON.stringify({ review: true, effort })), {
        review: true,
      });
    });
  }
});

describe('serialize', () => {
  it('orders keys as flags, then severities, then model, then effort', () => {
    assert.equal(
      serialize({
        effort: 'low',
        model: 'claude-opus-5-5',
        severities: 'critical',
        bots: false,
        healing: true,
        improvement: true,
        comments: false,
        review: true,
      }),
      '{"review":true,"comments":false,"improvement":true,"healing":true,"bots":false,"severities":"critical","model":"claude-opus-5-5","effort":"low"}',
    );
  });

  it('omits absent keys', () => {
    assert.equal(
      serialize({ effort: 'high', model: 'claude-opus-5-5', review: true }),
      '{"review":true,"model":"claude-opus-5-5","effort":"high"}',
    );
  });

  it('serializes an empty config as an empty object', () => {
    assert.equal(serialize({}), '{}');
  });

  it('serializes the output of validate in contract order', () => {
    assert.equal(
      serialize(
        validate({ severities: 'high,critical', bots: true, review: false }),
      ),
      '{"review":false,"bots":true,"severities":"critical,high"}',
    );
  });
});
