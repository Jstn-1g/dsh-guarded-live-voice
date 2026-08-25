/** Stable, value-free failures safe to expose to the browser. */
export type GuardedVoiceErrorCode =
  | 'authority-ambiguous'
  | 'authority-changed'
  | 'consent-expired'
  | 'consent-invalid'
  | 'consent-required'
  | 'invalid-message'
  | 'invalid-state'
  | 'provider-unconfigured'
  | 'session-not-live'
  | 'upgrade-forbidden'
  | 'workspace-not-found'

/** Error whose message contains no credential, provider payload, or user audio. */
export class GuardedVoiceError extends Error {
  constructor(
    readonly code: GuardedVoiceErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'GuardedVoiceError'
  }
}

export function asGuardedVoiceError(error: unknown): GuardedVoiceError {
  if (error instanceof GuardedVoiceError) return error
  return new GuardedVoiceError('invalid-state', 'guarded voice operation failed')
}
