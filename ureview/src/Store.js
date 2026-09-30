import { parse, serialize } from './config.js';
import { GitHubAppError } from './GitHubAppError.js';
import { paginate, request } from './github.js';
import { GitHubError } from './GitHubError.js';
import { encrypt } from './secret.js';
import { ValidationError } from './ValidationError.js';

export const VISIBILITY = 'all';

const SELECTED = 'selected';
const VISIBILITIES = new Set([VISIBILITY, 'private', SELECTED]);
const UNRESTRICTED = 'all';
const HIDDEN_REPOSITORIES =
  'This organization secret is shared with selected repositories that ureview cannot see. Rotate it with `gh secret set --org` instead.';

export class Store {
  #fetch;
  #token;
  #base;
  #visibility;
  #repositorySelection;
  #Failure;

  constructor({
    fetch,
    token,
    base,
    visibility = null,
    repositorySelection = null,
    Failure = GitHubError,
  }) {
    this.#fetch = fetch;
    this.#token = token;
    this.#base = base;
    this.#visibility = visibility;
    this.#repositorySelection = repositorySelection;
    this.#Failure = Failure;
  }

  static repository({ fetch, token, owner, name }) {
    return new Store({
      fetch,
      token,
      base: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions`,
      Failure: GitHubAppError,
    });
  }

  static organization({
    fetch,
    token,
    organization,
    repositorySelection = null,
  }) {
    return new Store({
      fetch,
      token,
      base: `/orgs/${encodeURIComponent(organization)}/actions`,
      visibility: VISIBILITY,
      repositorySelection,
    });
  }

  async status(names) {
    const [config, oauth, push, apiKey] = await Promise.all([
      this.#variable(names.variable),
      this.#secretExists(names.oauth),
      this.#secretExists(names.push),
      this.#secretExists(names.apiKey),
    ]);
    return { config, secrets: { oauth, push, apiKey } };
  }

  async inherited(names) {
    const [variables, secrets] = await Promise.all([
      this.#paginate('/organization-variables?per_page=30', 'variables'),
      this.#paginate('/organization-secrets?per_page=100', 'secrets'),
    ]);
    const variable = variables.find((entry) => matches(entry, names.variable));
    return {
      config: variable === undefined ? null : parse(variable.value),
      secrets: {
        oauth: secrets.some((entry) => matches(entry, names.oauth)),
        push: secrets.some((entry) => matches(entry, names.push)),
        apiKey: secrets.some((entry) => matches(entry, names.apiKey)),
      },
    };
  }

  async saveConfig(names, config) {
    const body = { name: names.variable, value: serialize(config) };
    const updated = await this.#send(
      'PATCH',
      `/variables/${encodeURIComponent(names.variable)}`,
      [204, 404],
      body,
    );
    if (updated.status === 404) {
      await this.#send('POST', '/variables', [201], {
        ...body,
        ...this.#created(),
      });
    }
  }

  async saveSecrets(names, { oauth, push }) {
    const values = [
      [names.oauth, oauth],
      [names.push, push],
    ].filter(([, value]) => typeof value === 'string');
    if (values.length === 0) {
      return;
    }
    const { data } = await this.#send('GET', '/secrets/public-key', [200]);
    const scopes = await Promise.all(
      values.map(([name]) => this.#secretScope(name)),
    );
    const writes = await Promise.allSettled(
      values.map(async ([name, value], index) => {
        const encrypted = await encrypt(data.key, value);
        await this.#send(
          'PUT',
          `/secrets/${encodeURIComponent(name)}`,
          [201, 204],
          { encrypted_value: encrypted, key_id: data.key_id, ...scopes[index] },
        );
      }),
    );
    const failure = writes.find((write) => write.status === 'rejected');
    if (failure !== undefined) {
      throw failure.reason;
    }
  }

  async remove(names) {
    await Promise.all([
      this.#send(
        'DELETE',
        `/variables/${encodeURIComponent(names.variable)}`,
        [204, 404],
      ),
      ...[names.oauth, names.apiKey, names.push].map((name) =>
        this.#send(
          'DELETE',
          `/secrets/${encodeURIComponent(name)}`,
          [204, 404],
        ),
      ),
    ]);
  }

  async presence(names) {
    const [variable, oauth, push, apiKey] = await Promise.all([
      this.#exists(`/variables/${encodeURIComponent(names.variable)}`),
      this.#secretExists(names.oauth),
      this.#secretExists(names.push),
      this.#secretExists(names.apiKey),
    ]);
    return { variable, oauth, push, apiKey };
  }

  async removeSecrets(names, kinds) {
    const deletes = await Promise.allSettled(
      kinds.map((kind) =>
        this.#send(
          'DELETE',
          `/secrets/${encodeURIComponent(names[kind])}`,
          [204, 404],
        ),
      ),
    );
    const settled = (status) =>
      kinds.filter((_, index) => deletes[index].status === status);
    return { removed: settled('fulfilled'), failed: settled('rejected') };
  }

  async #variable(name) {
    const { status, data } = await this.#send(
      'GET',
      `/variables/${encodeURIComponent(name)}`,
      [200, 404],
    );
    return status === 200 ? parse(data?.value) : null;
  }

  #secretExists(name) {
    return this.#exists(`/secrets/${encodeURIComponent(name)}`);
  }

  async #exists(suffix) {
    const { status } = await this.#send('GET', suffix, [200, 404]);
    return status === 200;
  }

  async #secretScope(name) {
    if (this.#visibility === null) {
      return {};
    }
    const suffix = `/secrets/${encodeURIComponent(name)}`;
    const { status, data } = await this.#send('GET', suffix, [200, 404]);
    if (status === 404) {
      return this.#created();
    }
    const visibility = data?.visibility;
    if (!VISIBILITIES.has(visibility)) {
      throw new this.#Failure(502, 'GET', `${this.#base}${suffix}`);
    }
    if (visibility !== SELECTED) {
      return { visibility };
    }
    if (this.#repositorySelection !== UNRESTRICTED) {
      throw new ValidationError(HIDDEN_REPOSITORIES);
    }
    const repositories = await this.#paginate(
      `${suffix}/repositories?per_page=100`,
      'repositories',
    );
    return {
      visibility,
      selected_repository_ids: repositories.map((repository) => repository.id),
    };
  }

  #created() {
    return this.#visibility === null ? {} : { visibility: this.#visibility };
  }

  #paginate(suffix, key) {
    return paginate(this.#fetch, {
      path: `${this.#base}${suffix}`,
      token: this.#token,
      key,
      Failure: this.#Failure,
    });
  }

  async #send(method, suffix, accepted, body) {
    const path = `${this.#base}${suffix}`;
    const response = await request(this.#fetch, {
      method,
      path,
      token: this.#token,
      body,
    });
    if (!accepted.includes(response.status)) {
      throw new this.#Failure(response.status, method, path, response.headers);
    }
    return response;
  }
}

function matches(entry, name) {
  return typeof entry?.name === 'string' && entry.name.toUpperCase() === name;
}
