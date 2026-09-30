import { parse, serialize, validate as validateConfig } from './config.js';
import { EnrolmentError } from './EnrolmentError.js';
import { validateTokens } from './secret.js';
import { ValidationError } from './ValidationError.js';

const FIELDS = new Set(['config', 'tokens']);
const CLAUDE_TOKEN_REQUIRED = 'Provide a Claude token to enrol.';
const Stored = Object.freeze({
  SUBMITTED: 'submitted',
  ABSENT: 'absent',
  UNKNOWN: 'unknown',
});

export function validate(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new ValidationError('Enrolment must be a JSON object.');
  }
  for (const key of Object.keys(body)) {
    if (!FIELDS.has(key)) {
      throw new ValidationError(`Unknown field: ${key}.`);
    }
  }
  return {
    config: validateConfig(body.config),
    tokens: validateTokens(body.tokens, { required: false }),
  };
}

export async function enrol(
  store,
  names,
  { config, tokens },
  inheritsClaudeToken = async () => false,
) {
  const existing = await store.presence(names);
  const kinds = Object.keys(tokens);
  if (lacksClaudeToken(kinds, existing) && !(await inheritsClaudeToken())) {
    throw new ValidationError(CLAUDE_TOKEN_REQUIRED);
  }
  const created = existing.variable
    ? []
    : kinds.filter((kind) => !existing[kind]);
  try {
    await store.saveSecrets(names, tokens);
  } catch (thrown) {
    if (created.length === 0) {
      throw thrown;
    }
    throw new EnrolmentError(thrown, await store.removeSecrets(names, created));
  }
  try {
    await store.saveConfig(names, config);
  } catch (thrown) {
    if (created.length === 0) {
      throw new EnrolmentError(thrown, { written: kinds });
    }
    switch (await reread(store, names, config)) {
      case Stored.SUBMITTED:
        break;
      case Stored.ABSENT: {
        const { removed, failed } = await store.removeSecrets(names, created);
        throw new EnrolmentError(thrown, {
          removed,
          failed,
          written: kinds.filter((kind) => !removed.includes(kind)),
        });
      }
      default:
        throw new EnrolmentError(thrown, { written: kinds, uncertain: true });
    }
  }
  return store.status(names);
}

async function reread(store, names, config) {
  let value;
  try {
    value = await store.variable(names);
  } catch {
    return Stored.UNKNOWN;
  }
  if (value === null) {
    return Stored.ABSENT;
  }
  const stored = parse(value);
  return stored !== null && serialize(stored) === serialize(config)
    ? Stored.SUBMITTED
    : Stored.UNKNOWN;
}

function lacksClaudeToken(kinds, existing) {
  if (kinds.includes('oauth') || existing.oauth || existing.apiKey) {
    return false;
  }
  return kinds.length === 0 || !existing.variable;
}
