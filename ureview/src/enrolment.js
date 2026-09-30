import { validate as validateConfig } from './config.js';
import { EnrolmentError } from './EnrolmentError.js';
import { validateTokens } from './secret.js';
import { ValidationError } from './ValidationError.js';

const FIELDS = new Set(['config', 'tokens']);
const CLAUDE_TOKEN_REQUIRED = 'Provide a Claude token to enrol.';

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
  try {
    await store.saveSecrets(names, tokens);
    await store.saveConfig(names, config);
  } catch (thrown) {
    const created = existing.variable
      ? []
      : kinds.filter((kind) => !existing[kind]);
    if (created.length === 0) {
      throw thrown;
    }
    throw new EnrolmentError(thrown, await store.removeSecrets(names, created));
  }
  return store.status(names);
}

function lacksClaudeToken(kinds, existing) {
  if (kinds.includes('oauth') || existing.oauth || existing.apiKey) {
    return false;
  }
  return kinds.length === 0 || !existing.variable;
}
