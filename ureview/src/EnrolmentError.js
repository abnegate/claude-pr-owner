export class EnrolmentError extends Error {
  constructor(cause, { removed, failed }) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'EnrolmentError';
    this.rolledBack = removed;
    this.rollbackFailed = failed;
  }
}
