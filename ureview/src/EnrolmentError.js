export class EnrolmentError extends Error {
  constructor(
    cause,
    { removed = [], failed = [], written = [], uncertain = false } = {},
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'EnrolmentError';
    this.rolledBack = removed;
    this.rollbackFailed = failed;
    this.tokensWritten = written;
    this.uncertain = uncertain;
  }
}
