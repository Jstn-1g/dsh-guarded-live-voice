import z from "@deepseek-ai/schemastery";
import { WebSocket } from "ws";
import { Context } from "@deepseek-ai/cordis";
import { IncomingHttpHeaders } from "node:http";
import { IndexInjection } from "@deepseek-ai/dsh-host-webserver";
//#region src/shared/wire.d.ts
declare const WIRE_VERSION: 1;
declare const MAX_CONTROL_BYTES: number;
type VoiceProviderId = 'qwen' | 'synthetic-demo';
declare const QWEN_DISCLOSURE: Readonly<{
  readonly audioDestination: "Alibaba Cloud Qwen realtime API";
  readonly exportedContext: "none";
  readonly executionAuthority: "none";
  readonly providerRetention: "not specified for Qwen realtime audio";
  readonly currentMilestone: "one bounded manual audio turn after acceptance";
}>;
declare const SYNTHETIC_DEMO_DISCLOSURE: Readonly<{
  readonly audioDestination: "Local deterministic synthetic demo";
  readonly exportedContext: "none";
  readonly executionAuthority: "none";
  readonly providerRetention: "none; no external provider connection";
  readonly currentMilestone: "one bounded synthetic demo turn after acceptance";
}>;
type VoiceProviderDisclosure = {
  readonly provider: 'qwen';
  readonly disclosure: typeof QWEN_DISCLOSURE;
} | {
  readonly provider: 'synthetic-demo';
  readonly disclosure: typeof SYNTHETIC_DEMO_DISCLOSURE;
};
interface BindControl {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'bind';
  readonly sessionId: string;
}
interface ConsentAcceptControl {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'consent.accept';
  readonly challenge: string;
}
interface StopControl {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'stop';
}
interface TurnCommitControl {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'turn.commit';
}
type ClientControl = BindControl | ConsentAcceptControl | TurnCommitControl | StopControl;
interface ConsentRequiredEventBase {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'consent.required';
  readonly challenge: string;
  readonly expiresAt: number;
  readonly sessionId: string;
  readonly workspaceId: string;
}
type ConsentRequiredEvent = ConsentRequiredEventBase & VoiceProviderDisclosure;
interface ReadyEvent {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'ready';
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly provider: VoiceProviderId;
  readonly model: string;
  readonly authority: 'proposal-only';
}
interface ErrorEvent {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
}
interface StoppedEvent {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'stopped';
}
interface TranscriptEvent {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'transcript';
  readonly role: 'user' | 'assistant';
  /** Complete transcript observed so far. */
  readonly text: string;
  readonly final: boolean;
}
interface TurnDoneEvent {
  readonly v: typeof WIRE_VERSION;
  readonly type: 'turn.done';
  readonly status: 'completed' | 'cancelled';
}
type ServerControl = ConsentRequiredEvent | ReadyEvent | ErrorEvent | StoppedEvent | TranscriptEvent | TurnDoneEvent;
/** Parse one text control frame with an exact, versioned, fail-closed schema. */
declare function parseClientControl(raw: string): ClientControl;
declare function encodeServerControl(event: ServerControl): string;
/** Parse one Host control event in the browser with an exact, fail-closed schema. */
declare function parseServerControl(raw: string): ServerControl;
//#endregion
//#region src/host/authority.d.ts
interface LiveSessionSource {
  get(sessionId: string): unknown | undefined;
}
interface WorkspaceView {
  readonly id: string;
  readonly sessionIds: readonly string[];
}
interface WorkspaceSource {
  list(): readonly WorkspaceView[];
}
interface PublicAuthorityBinding {
  readonly sessionId: string;
  readonly workspaceId: string;
}
/** Opaque lease. The live object identity prevents an id-reuse race. */
interface AuthorityLease {
  readonly binding: PublicAuthorityBinding;
  readonly sessionIdentity: unknown;
}
/** Exact session/workspace authority boundary for one voice connection. */
declare class AuthorityGuard {
  private readonly sessions;
  private readonly workspaces;
  constructor(sessions: LiveSessionSource, workspaces: WorkspaceSource);
  bind(sessionId: string): AuthorityLease;
  revalidate(lease: AuthorityLease): PublicAuthorityBinding;
}
//#endregion
//#region src/host/carrier.d.ts
type UpgradeAssessment = {
  readonly ok: true;
} | {
  readonly ok: false;
  readonly status: 400 | 403 | 426 | 429;
  readonly reason: string;
};
interface UpgradeRequestView {
  readonly method: string | undefined;
  readonly headers: IncomingHttpHeaders;
  readonly remoteAddress: string | undefined;
}
/** Loopback-only, same-origin, explicit-host fence for the privileged WebSocket. */
declare function assessUpgradeRequest(request: UpgradeRequestView, trustedHosts: readonly string[]): UpgradeAssessment;
declare function assertTrustedHosts(trustedHosts: readonly string[]): void;
//#endregion
//#region src/host/boot.d.ts
/** Publish only the non-secret browser route through DSH's structured boot table. */
declare function guardedVoiceClientBootInjection(route: string): IndexInjection;
//#endregion
//#region src/host/provider.d.ts
interface ProviderAuthorization {
  readonly provider: VoiceProviderId;
  readonly model: string;
}
type ManualTurnTranscriptRole = 'user' | 'assistant';
/** Value-bounded provider output. Raw provider errors never cross this face. */
type ManualTurnProviderEvent = {
  readonly type: 'transcript';
  readonly role: ManualTurnTranscriptRole;
  /** Complete transcript observed so far, not an unbounded delta. */
  readonly text: string;
  readonly final: boolean;
} | {
  readonly type: 'audio';
  readonly pcm24: Uint8Array;
} | {
  readonly type: 'done';
  readonly status: 'completed' | 'cancelled';
};
interface ManualTurnProviderSession {
  readonly authorization: ProviderAuthorization;
  /** Resolves without provider-supplied detail when the connection ends. */
  readonly closed: Promise<'local' | 'provider-closed' | 'protocol-error' | 'transport-error'>;
  appendPcm16(chunk: Uint8Array): void;
  commit(): void;
  close(): void;
  subscribe(listener: (event: ManualTurnProviderEvent) => void): () => void;
}
/**
 * Called only after disclosure acceptance has been consumed and authority
 * revalidated.
 * Implementations may resolve credentials here, but must not return or retain
 * credential material in this value.
 */
type AuthorizeProvider = (binding: PublicAuthorityBinding, signal: AbortSignal) => Promise<ProviderAuthorization>;
//#endregion
//#region src/host/consent.d.ts
interface ConsentSubject {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly workspaceId: string;
  readonly provider: VoiceProviderId;
}
interface ConsentChallenge {
  readonly challenge: string;
  readonly expiresAt: number;
}
interface ConsentChallengeOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly token?: () => string;
}
/** Short-lived, one-shot proof that the exact bound connection accepted disclosure. */
declare class ConsentChallenges {
  private readonly records;
  private readonly ttlMs;
  private readonly now;
  private readonly token;
  constructor(options?: ConsentChallengeOptions);
  issue(subject: ConsentSubject): ConsentChallenge;
  consume(challenge: string, subject: ConsentSubject): void;
  revoke(challenge: string): void;
  sweep(): number;
  get size(): number;
}
//#endregion
//#region src/host/qwen.d.ts
declare const QWEN_REALTIME_MODELS: readonly ["qwen-audio-3.0-realtime-plus", "qwen-audio-3.0-realtime-flash"];
type QwenRealtimeModel = typeof QWEN_REALTIME_MODELS[number];
declare const DEFAULT_QWEN_REALTIME_MODEL: QwenRealtimeModel;
declare function isQwenRealtimeModel(value: string): value is QwenRealtimeModel;
/** Construct the documented China/Beijing endpoint without accepting arbitrary hosts. */
declare function buildQwenRealtimeEndpoint(dashscopeWorkspaceId: string, model: QwenRealtimeModel): URL;
declare const MAX_QWEN_PROVIDER_CONTROL_BYTES: number;
type QwenHandshakeAction = {
  readonly kind: 'send';
  readonly payload: Readonly<Record<string, unknown>>;
} | {
  readonly kind: 'ready';
};
interface QwenUpdatedSessionExpectation {
  readonly modalities: readonly string[];
  readonly turnDetection: null;
  readonly inputAudioFormat?: 'pcm';
  readonly outputAudioFormat?: 'pcm';
}
/**
 * Enforces the documented session.created -> session.update ->
 * session.updated ordering. Callers supply the update body and may require the
 * provider to confirm an exact model and effective session configuration.
 */
declare class QwenHandshake {
  private phase;
  private readonly sessionUpdate;
  private readonly expectedModel;
  private readonly expectedUpdatedSession;
  private sessionIdentity;
  constructor(sessionUpdate: Readonly<Record<string, unknown>>, expectedModel?: QwenRealtimeModel, expectedUpdatedSession?: QwenUpdatedSessionExpectation);
  receive(raw: string): QwenHandshakeAction;
  assertReady(): void;
  close(): void;
}
//#endregion
//#region src/host/proposal.d.ts
declare const PROPOSAL_TOOL_NAME = "prepare_work_instruction";
declare const MAX_PROPOSAL_TITLE_LENGTH = 120;
declare const MAX_PROPOSAL_INSTRUCTION_LENGTH = 4000;
interface GuardedProposal {
  readonly kind: 'work-instruction';
  readonly title?: string;
  readonly instruction: string;
  readonly target: PublicAuthorityBinding;
  readonly authority: 'none';
}
/** Normalize one provider tool-call payload into a non-executable proposal. */
declare function parseGuardedProposal(rawArguments: string, target: PublicAuthorityBinding): GuardedProposal;
//#endregion
//#region src/host/session-manager.d.ts
interface BeginResult {
  readonly binding: PublicAuthorityBinding;
  readonly challenge: string;
  readonly expiresAt: number;
  readonly provider: VoiceProviderId;
}
interface ReadyResult {
  readonly binding: PublicAuthorityBinding;
  readonly provider: ProviderAuthorization;
}
/** Pure lifecycle coordinator: authority -> disclosure acceptance -> provider authorization. */
declare class VoiceSessionManager {
  private readonly authority;
  private readonly consents;
  private readonly authorizeProvider;
  private readonly provider;
  private readonly connections;
  constructor(authority: AuthorityGuard, consents: ConsentChallenges, authorizeProvider: AuthorizeProvider, provider?: VoiceProviderId);
  begin(connectionId: string, sessionId: string): BeginResult;
  acceptConsent(connectionId: string, challenge: string): Promise<ReadyResult>;
  revalidate(connectionId: string): ReadyResult;
  stop(connectionId: string): boolean;
  stopSession(sessionId: string): string[];
  get size(): number;
  private subject;
}
//#endregion
//#region src/shared/errors.d.ts
/** Stable, value-free failures safe to expose to the browser. */
type GuardedVoiceErrorCode = 'authority-ambiguous' | 'authority-changed' | 'consent-expired' | 'consent-invalid' | 'consent-required' | 'invalid-message' | 'invalid-state' | 'provider-unconfigured' | 'session-not-live' | 'upgrade-forbidden' | 'workspace-not-found';
/** Error whose message contains no credential, provider payload, or user audio. */
declare class GuardedVoiceError extends Error {
  readonly code: GuardedVoiceErrorCode;
  constructor(code: GuardedVoiceErrorCode, message: string);
}
//#endregion
//#region src/host/manual-turn.d.ts
type OpenManualTurnProvider = (binding: PublicAuthorityBinding, authorization: ProviderAuthorization, signal: AbortSignal) => Promise<ManualTurnProviderSession>;
interface ManualTurnSink {
  event(event: ManualTurnProviderEvent): void;
  failed(error: GuardedVoiceError): void;
}
/**
 * Binds one provider turn to an already accepted manager connection.
 * Revalidation occurs before open, after open, before every audio/commit
 * operation, and before every provider event crosses back to the browser, so a
 * Session id-reuse or Workspace move cannot inherit either side of the turn.
 */
declare class ManualTurnCoordinator {
  private readonly manager;
  private readonly openProvider;
  private readonly turns;
  constructor(manager: VoiceSessionManager, openProvider: OpenManualTurnProvider);
  start(connectionId: string, sink: ManualTurnSink): Promise<ProviderAuthorization>;
  appendPcm16(connectionId: string, chunk: Uint8Array): void;
  commit(connectionId: string): void;
  stop(connectionId: string): boolean;
  stopSession(sessionId: string): string[];
  close(): void;
  get size(): number;
  private ready;
  private revalidate;
}
//#endregion
//#region src/host/qwen-manual-turn.d.ts
declare const MAX_QWEN_INPUT_CHUNK_BYTES: number;
declare const MAX_QWEN_INPUT_TURN_BYTES: number;
declare const MAX_QWEN_OUTPUT_CHUNK_BYTES: number;
declare const MAX_QWEN_OUTPUT_TURN_BYTES: number;
declare const MAX_QWEN_TRANSCRIPT_LENGTH = 4096;
declare const MAX_QWEN_REALTIME_EVENT_BYTES: number;
declare const MAX_QWEN_BUFFERED_BYTES: number;
declare const DEFAULT_QWEN_INPUT_TIMEOUT_MS = 60000;
declare const DEFAULT_QWEN_RESPONSE_TIMEOUT_MS = 90000;
declare const MAX_QWEN_PHASE_TIMEOUT_MS: number;
interface QwenSocketFactoryOptions {
  readonly authorization: string;
  readonly handshakeTimeoutMs: number;
  readonly maxPayload: number;
}
interface OpenQwenManualTurnOptions {
  readonly workspaceId: string;
  readonly model: QwenRealtimeModel;
  readonly resolveCredential: (signal: AbortSignal) => Promise<string | undefined>;
  readonly signal: AbortSignal;
  readonly readyTimeoutMs?: number;
  readonly inputTimeoutMs?: number;
  readonly responseTimeoutMs?: number;
}
interface QwenManualTurnDependencies {
  readonly createSocket?: (endpoint: URL, options: QwenSocketFactoryOptions) => WebSocket;
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  readonly cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void;
}
/**
 * Open one audio-enabled, push-to-talk Qwen session.
 *
 * The returned capability accepts one bounded PCM16 mono/16 kHz turn, exposes
 * only bounded transcripts and PCM16 mono/24 kHz output, and has no tool,
 * context-injection, text-input, or second-turn operation.
 */
declare function openQwenManualTurn(options: OpenQwenManualTurnOptions, dependencies?: QwenManualTurnDependencies): Promise<ManualTurnProviderSession>;
//#endregion
//#region src/host/synthetic-demo-turn.d.ts
declare const SYNTHETIC_DEMO_PROVIDER: "synthetic-demo";
declare const SYNTHETIC_DEMO_MODEL: "dsh-live-voice-synthetic-demo-v1";
declare const SYNTHETIC_DEMO_USER_TRANSCRIPT = "Synthetic demo request: place this sample transcript in the DSH draft.";
declare const SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT = "Synthetic demo response: the local consent-bound turn completed without contacting an external provider.";
interface OpenSyntheticDemoTurnOptions {
  readonly signal: AbortSignal;
  /** Test seam for deterministic delivery; production uses a microtask. */
  readonly defer?: (callback: () => void) => void;
}
/**
 * Open one in-process, credential-free demonstration turn.
 *
 * Input bytes are validated and counted only; they are never retained, decoded,
 * transcribed, or echoed. One explicit commit emits fixed, clearly synthetic
 * transcripts, one bounded deterministic chime, and a completed terminal event.
 */
declare function openSyntheticDemoTurn(options: OpenSyntheticDemoTurnOptions): Promise<ManualTurnProviderSession>;
//#endregion
//#region src/shared/boot.d.ts
declare const CLIENT_BOOT_GLOBAL: "__DSH_GUARDED_LIVE_VOICE__";
declare const CLIENT_BOOT_VERSION: 1;
interface GuardedVoiceClientBoot {
  readonly v: typeof CLIENT_BOOT_VERSION;
  readonly route: string;
}
/** Validate the non-secret Host-to-browser route descriptor. */
declare function parseGuardedVoiceClientBoot(value: unknown): GuardedVoiceClientBoot;
//#endregion
//#region src/index.d.ts
interface Config {
  /** Explicit provider. Synthetic demo never contacts Qwen or reads a microphone. */
  provider?: VoiceProviderId;
  /** DSH credential reference, never a credential value. */
  credentialRef?: string;
  /** Exact WebSocket path. */
  route?: string;
  /** Qwen audio realtime model. */
  model?: string;
  /** Alibaba Cloud Model Studio workspace subdomain; deliberately has no default. */
  dashscopeWorkspaceId?: string;
  /** Comma-separated explicit hosts. Entries without ports permit any port. */
  trustedHosts?: string;
  /** Lifetime of an exact-binding disclosure-acceptance challenge. */
  consentTtlMs?: number;
  /** Maximum simultaneous pre-audio control connections. */
  maxConnections?: number;
}
declare const Config: z<Config>;
declare const inject: string[];
/** Register the exact-session disclosure carrier and one bounded manual provider turn. */
declare function apply(ctx: Context, input?: Config): void;
//#endregion
export { AuthorityGuard, type AuthorityLease, CLIENT_BOOT_GLOBAL, CLIENT_BOOT_VERSION, type ClientControl, Config, ConsentChallenges, type ConsentSubject, DEFAULT_QWEN_INPUT_TIMEOUT_MS, DEFAULT_QWEN_REALTIME_MODEL, DEFAULT_QWEN_RESPONSE_TIMEOUT_MS, type GuardedProposal, type GuardedVoiceClientBoot, GuardedVoiceError, type GuardedVoiceErrorCode, MAX_CONTROL_BYTES, MAX_PROPOSAL_INSTRUCTION_LENGTH, MAX_PROPOSAL_TITLE_LENGTH, MAX_QWEN_BUFFERED_BYTES, MAX_QWEN_INPUT_CHUNK_BYTES, MAX_QWEN_INPUT_TURN_BYTES, MAX_QWEN_OUTPUT_CHUNK_BYTES, MAX_QWEN_OUTPUT_TURN_BYTES, MAX_QWEN_PHASE_TIMEOUT_MS, MAX_QWEN_PROVIDER_CONTROL_BYTES, MAX_QWEN_REALTIME_EVENT_BYTES, MAX_QWEN_TRANSCRIPT_LENGTH, ManualTurnCoordinator, type ManualTurnProviderEvent, type ManualTurnProviderSession, type ManualTurnSink, type ManualTurnTranscriptRole, type OpenManualTurnProvider, type OpenQwenManualTurnOptions, type OpenSyntheticDemoTurnOptions, PROPOSAL_TOOL_NAME, type ProviderAuthorization, type PublicAuthorityBinding, QWEN_REALTIME_MODELS, QwenHandshake, type QwenManualTurnDependencies, type QwenRealtimeModel, type QwenUpdatedSessionExpectation, SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT, SYNTHETIC_DEMO_MODEL, SYNTHETIC_DEMO_PROVIDER, SYNTHETIC_DEMO_USER_TRANSCRIPT, type ServerControl, type VoiceProviderDisclosure, type VoiceProviderId, VoiceSessionManager, WIRE_VERSION, apply, assertTrustedHosts, assessUpgradeRequest, buildQwenRealtimeEndpoint, encodeServerControl, guardedVoiceClientBootInjection, inject, isQwenRealtimeModel, openQwenManualTurn, openSyntheticDemoTurn, parseClientControl, parseGuardedProposal, parseGuardedVoiceClientBoot, parseServerControl };