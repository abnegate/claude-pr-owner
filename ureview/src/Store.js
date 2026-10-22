import { parse, serialize } from './config.js';
import { GitHubAppError } from './GitHubAppError.js';
import { paginate, request } from './github.js';
import { GitHubError } from './GitHubError.js';
import { encrypt } from './secret.js';
import { ValidationError } from './ValidationError.js';

export const VISIBILITY = 'selected';

const KINDS = Object.freeze(['oauth', 'push', 'apiKey']);
export const UNSCOPED = 'Choose the repositories ureview runs in.';

export class Store {
  #fetch;
  #token;
  #base;
  #organization;
  #repositories;
  #Failure;

  constructor({
    fetch,
    token,
    base,
    organization = false,
    repositories = null,
    Failure = GitHubError,
  }) {
    this.#fetch = fetch;
    this.#token = token;
    this.#base = base;
    this.#organization = organization;
    this.#repositories = repositories;
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

  static organization({ fetch, token, organization, repositories = null }) {
    return new Store({
      fetch,
      token,
      base: `/orgs/${encodeURIComponent(organization)}/actions`,
      organization: true,
      repositories,
    });
  }

  async status(names) {
    const [variable, found] = await Promise.all([
      this.#variable(names),
      Promise.all(KINDS.map((kind) => this.#secret(names[kind]))),
    ]);
    const config = parse(variable === null ? null : valueOf(variable));
    const secrets = Object.fromEntries(
      KINDS.map((kind, index) => [kind, found[index] !== null]),
    );
    if (!this.#organization) {
      return { config, secrets };
    }
    return {
      config,
      secrets,
      repositories: await this.#selected(names, variable),
      exposed: KINDS.filter(
        (kind, index) =>
          found[index] !== null && found[index].visibility !== VISIBILITY,
      ),
    };
  }

  async repositories(names) {
    return this.#selected(names, await this.#variable(names));
  }

  async restrict(names) {
    const scope = this.#scope();
    const found = await Promise.all(
      KINDS.map((kind) => this.#secret(names[kind])),
    );
    await Promise.all([
      this.#send(
        'PATCH',
        `/variables/${encodeURIComponent(names.variable)}`,
        [204, 404],
        scope,
      ),
      ...KINDS.filter(
        (kind, index) => found[index]?.visibility === VISIBILITY,
      ).map((kind) =>
        this.#send(
          'PUT',
          `/secrets/${encodeURIComponent(names[kind])}/repositories`,
          [204],
          { selected_repository_ids: scope.selected_repository_ids },
        ),
      ),
    ]);
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
        ...this.#scope(),
      });
    }
  }

  async saveSecrets(names, tokens) {
    const values = KINDS.filter((kind) => typeof tokens[kind] === 'string').map(
      (kind) => [names[kind], tokens[kind]],
    );
    if (values.length === 0) {
      return;
    }
    const { data } = await this.#send('GET', '/secrets/public-key', [200]);
    const writes = await Promise.allSettled(
      values.map(async ([name, value]) => {
        const encrypted = await encrypt(data.key, value);
        await this.#send(
          'PUT',
          `/secrets/${encodeURIComponent(name)}`,
          [201, 204],
          { encrypted_value: encrypted, key_id: data.key_id, ...this.#scope() },
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

  async variable(names) {
    const variable = await this.#variable(names);
    return variable === null ? null : valueOf(variable);
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

  #secretExists(name) {
    return this.#exists(`/secrets/${encodeURIComponent(name)}`);
  }

  async #exists(suffix) {
    const { status } = await this.#send('GET', suffix, [200, 404]);
    return status === 200;
  }

  async #variable(names) {
    const { status, data } = await this.#send(
      'GET',
      `/variables/${encodeURIComponent(names.variable)}`,
      [200, 404],
    );
    return status === 404 ? null : (data ?? {});
  }

  async #selected(names, variable) {
    if (variable?.visibility !== VISIBILITY) {
      return null;
    }
    const repositories = await this.#paginate(
      `/variables/${encodeURIComponent(names.variable)}/repositories?per_page=100`,
      'repositories',
    );
    return repositories.map((repository) => repository.id);
  }

  async #secret(name) {
    const { status, data } = await this.#send(
      'GET',
      `/secrets/${encodeURIComponent(name)}`,
      [200, 404],
    );
    return status === 404 ? null : (data ?? {});
  }

  #scope() {
    if (!this.#organization) {
      return {};
    }
    if (!Array.isArray(this.#repositories) || this.#repositories.length === 0) {
      throw new ValidationError(UNSCOPED);
    }
    return {
      visibility: VISIBILITY,
      selected_repository_ids: this.#repositories,
    };
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

function valueOf(variable) {
  return typeof variable.value === 'string' ? variable.value : '';
}
