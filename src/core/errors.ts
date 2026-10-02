export type ErrorCode =
  | 'conflict'
  | 'leader_only'
  | 'deps_unmet'
  | 'not_found'
  | 'bad_state'
  | 'forbidden'
  | 'invalid';

/** A domain error with machine-readable details and a hint for what the agent should do instead. */
export class HiveError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details: Record<string, unknown> = {},
    public hint?: string,
  ) {
    super(message);
  }
}
