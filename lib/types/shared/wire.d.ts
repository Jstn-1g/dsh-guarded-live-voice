export declare const WIRE_VERSION: 1;
export declare const MAX_CONTROL_BYTES: number;
export declare const MAX_SESSION_ID_LENGTH = 256;
export declare const MAX_MODEL_LENGTH = 128;
export declare const MAX_ERROR_CODE_LENGTH = 64;
export declare const MAX_ERROR_MESSAGE_LENGTH = 2048;
export declare const MAX_TRANSCRIPT_LENGTH = 4096;
export declare const CHALLENGE_PATTERN: RegExp;
export interface BindControl {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'bind';
    readonly sessionId: string;
}
export interface ConsentAcceptControl {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'consent.accept';
    readonly challenge: string;
}
export interface StopControl {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'stop';
}
export interface TurnCommitControl {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'turn.commit';
}
export type ClientControl = BindControl | ConsentAcceptControl | TurnCommitControl | StopControl;
export interface ConsentRequiredEvent {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'consent.required';
    readonly challenge: string;
    readonly expiresAt: number;
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly provider: 'qwen';
    readonly disclosure: {
        readonly audioDestination: 'Alibaba Cloud Qwen realtime API';
        readonly exportedContext: 'none';
        readonly executionAuthority: 'none';
        readonly providerRetention: 'not specified for Qwen realtime audio';
        readonly currentMilestone: 'one bounded manual audio turn after acceptance';
    };
}
export interface ReadyEvent {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'ready';
    readonly sessionId: string;
    readonly workspaceId: string;
    readonly provider: 'qwen';
    readonly model: string;
    readonly authority: 'proposal-only';
}
export interface ErrorEvent {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'error';
    readonly code: string;
    readonly message: string;
}
export interface StoppedEvent {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'stopped';
}
export interface TranscriptEvent {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'transcript';
    readonly role: 'user' | 'assistant';
    /** Complete transcript observed so far. */
    readonly text: string;
    readonly final: boolean;
}
export interface TurnDoneEvent {
    readonly v: typeof WIRE_VERSION;
    readonly type: 'turn.done';
    readonly status: 'completed' | 'cancelled';
}
export type ServerControl = ConsentRequiredEvent | ReadyEvent | ErrorEvent | StoppedEvent | TranscriptEvent | TurnDoneEvent;
/** Whether an identifier can cross the bounded browser control protocol unchanged. */
export declare function isValidWireId(value: unknown): value is string;
/** Parse one text control frame with an exact, versioned, fail-closed schema. */
export declare function parseClientControl(raw: string): ClientControl;
export declare function encodeServerControl(event: ServerControl): string;
/** Parse one Host control event in the browser with an exact, fail-closed schema. */
export declare function parseServerControl(raw: string): ServerControl;
