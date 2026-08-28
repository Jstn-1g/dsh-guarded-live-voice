/** Stable, value-free failures safe to expose to the browser. */
export type GuardedVoiceErrorCode = 'authority-ambiguous' | 'authority-changed' | 'consent-expired' | 'consent-invalid' | 'consent-required' | 'invalid-message' | 'invalid-state' | 'provider-unconfigured' | 'session-not-live' | 'upgrade-forbidden' | 'workspace-not-found';
/** Error whose message contains no credential, provider payload, or user audio. */
export declare class GuardedVoiceError extends Error {
    readonly code: GuardedVoiceErrorCode;
    constructor(code: GuardedVoiceErrorCode, message: string);
}
export declare function asGuardedVoiceError(error: unknown): GuardedVoiceError;
