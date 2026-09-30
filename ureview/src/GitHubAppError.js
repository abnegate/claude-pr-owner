import { GitHubError } from './GitHubError.js';

export class GitHubAppError extends GitHubError {
  constructor(status, method, path, headers) {
    super(status, method, path, headers);
    this.name = 'GitHubAppError';
  }
}
