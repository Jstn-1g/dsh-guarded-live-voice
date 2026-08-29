export type VoiceClientPhase = 'idle' | 'connecting' | 'awaiting-consent' | 'authorizing' | 'ready' | 'preparing-audio' | 'recording' | 'responding' | 'completed' | 'error';
export interface VoiceDisclosureView {
    readonly expiresAt: number;
    readonly workspaceId: string;
    readonly audioDestination: 'Alibaba Cloud Qwen realtime API';
    readonly exportedContext: 'none';
    readonly executionAuthority: 'none';
    readonly providerRetention: 'not specified for Qwen realtime audio';
    readonly currentMilestone: 'one bounded manual audio turn after acceptance';
}
export interface VoiceClientSnapshot {
    readonly phase: VoiceClientPhase;
    readonly sessionId?: string;
    readonly disclosure?: VoiceDisclosureView;
    readonly model?: string;
    readonly error?: string;
    readonly userTranscript?: string;
    readonly assistantTranscript?: string;
    readonly userTranscriptFinal?: boolean;
    readonly assistantTranscriptFinal?: boolean;
    readonly turnStatus?: 'completed' | 'cancelled';
    /** Composer revision captured at the visible acceptance gesture. */
    readonly draftRevision?: number;
}
interface VoiceSocket {
    readonly readyState: number;
    readonly bufferedAmount: number;
    binaryType?: BinaryType;
    send(data: string | BufferSource): void;
    close(code?: number, reason?: string): void;
    addEventListener(type: 'open', listener: (event: Event) => void): void;
    addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    addEventListener(type: 'error', listener: (event: Event) => void): void;
    addEventListener(type: 'close', listener: (event: CloseEvent) => void): void;
    removeEventListener(type: 'open', listener: (event: Event) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void;
    removeEventListener(type: 'error', listener: (event: Event) => void): void;
    removeEventListener(type: 'close', listener: (event: CloseEvent) => void): void;
}
export interface VoiceAudioSink {
    /** Prepare browser playback from the same explicit gesture that starts capture. */
    prepare(): Promise<void>;
    /** Consume one bounded PCM16 mono/24 kHz provider chunk. */
    write(pcm24: Uint8Array): void;
    /** Drop queued playback when the exact voice lifecycle stops or fails. */
    reset(): void;
}
export interface VoiceAudioCapture {
    /** Request permission and begin owned microphone capture. */
    start(): Promise<void>;
    /** Stop every capture resource, optionally flushing the final bounded frame. */
    stop(flush?: boolean): void;
}
export interface VoiceAudioCaptureHandlers {
    readonly onChunk: (pcm16: Uint8Array) => void;
    readonly onLimit: () => void;
    readonly onError: (error: Error) => void;
}
export type VoiceAudioCaptureFactory = (handlers: VoiceAudioCaptureHandlers) => VoiceAudioCapture;
export interface VoiceClientControllerOptions {
    readonly route: string;
    readonly location?: Pick<Location, 'href' | 'protocol'>;
    readonly socketFactory?: (url: string) => VoiceSocket;
    readonly now?: () => number;
    readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
    readonly cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
    readonly audioSink?: VoiceAudioSink;
    readonly captureFactory?: VoiceAudioCaptureFactory;
}
/** Browser-side disclosure, bounded capture, and one-turn playback coordinator. */
export declare class VoiceClientController {
    private readonly options;
    private snapshot;
    private readonly listeners;
    private readonly location;
    private readonly route;
    private readonly socketFactory;
    private readonly now;
    private readonly schedule;
    private readonly cancelScheduled;
    private active;
    private challenge;
    private consentTimer;
    private generation;
    private disposed;
    private readonly audioSink;
    private readonly captureFactory;
    private capture;
    private inputBytes;
    private outputBytes;
    private composerBinding;
    private readonly sessionMounts;
    private readonly pendingSessionStops;
    constructor(options: VoiceClientControllerOptions);
    /** Return the identity-stable view until one lifecycle fact changes. */
    getSnapshot: () => VoiceClientSnapshot;
    /** Subscribe to browser-visible lifecycle changes. */
    subscribe: (listener: () => void) => (() => void);
    /**
     * Retain one rendered seat for an exact Session. The last seat leaving is
     * the SPA-navigation boundary: no hidden socket, capture, playback, or
     * transcript may survive after that Session's controls disappear.
     */
    mountSession: (sessionId: string) => (() => void);
    /** Begin exact-session setup; only the later accept call can authorize the provider. */
    start(sessionId: string): void;
    /** Append one bounded PCM16 mono/16 kHz chunk to this exact ready Session. */
    appendPcm16(sessionId: string, chunk: Uint8Array): void;
    /** Start microphone capture only from the exact ready Session's user gesture. */
    beginCapture(sessionId: string): void;
    /** Finish the explicit microphone turn and ask only the provider for an answer. */
    finishCapture(sessionId: string): void;
    private relayPcm16;
    /** Commit the one manual turn. This operation can never submit the DSH composer. */
    commitTurn(sessionId: string): void;
    private commitActiveTurn;
    /** Consume the hidden one-shot challenge after the visible acceptance gesture. */
    accept(sessionId: string, draftRevision?: number, composerIdentity?: object): void;
    /** Whether this lifecycle still owns the exact per-Session composer action face accepted by the user. */
    isComposerBindingCurrent(sessionId: string, composerIdentity: object): boolean;
    /** Atomically consume the exact composer binding before one explicit draft handoff. */
    claimDraftHandoff(sessionId: string, composerIdentity: object, draftRevision: number): boolean;
    /** Stop only the addressed setup; a different mounted Session cannot cancel it. */
    stop(sessionId?: string): void;
    /** Release all browser resources and ignore every late socket callback. */
    dispose(): void;
    private socketUrl;
    private opened;
    private received;
    private failedSocket;
    private closed;
    private fail;
    private resetTurn;
    private prepareCapture;
    private capturedPcm16;
    private captureLimit;
    private captureError;
    private isCaptureActive;
    private isActive;
    private releaseActive;
    private releaseRecord;
    private clearConsentTimer;
    private publish;
}
export {};
