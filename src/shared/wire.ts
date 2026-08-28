import { GuardedVoiceError } from './errors.js'
import { MAX_VOICE_TRANSCRIPT_LENGTH } from './audio.js'

export const WIRE_VERSION = 1 as const
export const MAX_CONTROL_BYTES = 8 * 1024
export const MAX_SESSION_ID_LENGTH = 256
export const MAX_MODEL_LENGTH = 128
export const MAX_ERROR_CODE_LENGTH = 64
export const MAX_ERROR_MESSAGE_LENGTH = 2_048
export const MAX_TRANSCRIPT_LENGTH = MAX_VOICE_TRANSCRIPT_LENGTH
export const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{32,128}$/

export interface BindControl {
  readonly v: typeof WIRE_VERSION
  readonly type: 'bind'
  readonly sessionId: string
}

export interface ConsentAcceptControl {
  readonly v: typeof WIRE_VERSION
  readonly type: 'consent.accept'
  readonly challenge: string
}

export interface StopControl {
  readonly v: typeof WIRE_VERSION
  readonly type: 'stop'
}

export interface TurnCommitControl {
  readonly v: typeof WIRE_VERSION
  readonly type: 'turn.commit'
}

export type ClientControl = BindControl | ConsentAcceptControl | TurnCommitControl | StopControl

export interface ConsentRequiredEvent {
  readonly v: typeof WIRE_VERSION
  readonly type: 'consent.required'
  readonly challenge: string
  readonly expiresAt: number
  readonly sessionId: string
  readonly workspaceId: string
  readonly provider: 'qwen'
  readonly disclosure: {
    readonly audioDestination: 'Alibaba Cloud Qwen realtime API'
    readonly exportedContext: 'none'
    readonly executionAuthority: 'none'
    readonly providerRetention: 'not specified for Qwen realtime audio'
    readonly currentMilestone: 'one bounded manual audio turn after acceptance'
  }
}

export interface ReadyEvent {
  readonly v: typeof WIRE_VERSION
  readonly type: 'ready'
  readonly sessionId: string
  readonly workspaceId: string
  readonly provider: 'qwen'
  readonly model: string
  readonly authority: 'proposal-only'
}

export interface ErrorEvent {
  readonly v: typeof WIRE_VERSION
  readonly type: 'error'
  readonly code: string
  readonly message: string
}

export interface StoppedEvent {
  readonly v: typeof WIRE_VERSION
  readonly type: 'stopped'
}

export interface TranscriptEvent {
  readonly v: typeof WIRE_VERSION
  readonly type: 'transcript'
  readonly role: 'user' | 'assistant'
  /** Complete transcript observed so far. */
  readonly text: string
  readonly final: boolean
}

export interface TurnDoneEvent {
  readonly v: typeof WIRE_VERSION
  readonly type: 'turn.done'
  readonly status: 'completed' | 'cancelled'
}

export type ServerControl =
  | ConsentRequiredEvent
  | ReadyEvent
  | ErrorEvent
  | StoppedEvent
  | TranscriptEvent
  | TurnDoneEvent

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allow = new Set(allowed)
  return Object.keys(record).every(key => allow.has(key))
}

function controlBytes(raw: string): number {
  return new TextEncoder().encode(raw).byteLength
}

/** Whether an identifier can cross the bounded browser control protocol unchanged. */
export function isValidWireId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_SESSION_ID_LENGTH
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Parse one text control frame with an exact, versioned, fail-closed schema. */
export function parseClientControl(raw: string): ClientControl {
  if (controlBytes(raw) > MAX_CONTROL_BYTES) {
    throw new GuardedVoiceError('invalid-message', 'control frame exceeds the byte limit')
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GuardedVoiceError('invalid-message', 'control frame is not valid JSON')
  }
  if (!isRecord(parsed) || parsed.v !== WIRE_VERSION || typeof parsed.type !== 'string') {
    throw new GuardedVoiceError('invalid-message', 'control frame has an unsupported shape or version')
  }

  if (parsed.type === 'bind') {
    if (!hasOnlyKeys(parsed, ['v', 'type', 'sessionId']) || !isValidWireId(parsed.sessionId)) {
      throw new GuardedVoiceError('invalid-message', 'bind frame is invalid')
    }
    return { v: WIRE_VERSION, type: 'bind', sessionId: parsed.sessionId }
  }

  if (parsed.type === 'consent.accept') {
    if (!hasOnlyKeys(parsed, ['v', 'type', 'challenge'])
      || typeof parsed.challenge !== 'string'
      || !CHALLENGE_PATTERN.test(parsed.challenge)) {
      throw new GuardedVoiceError('invalid-message', 'consent frame is invalid')
    }
    return { v: WIRE_VERSION, type: 'consent.accept', challenge: parsed.challenge }
  }

  if (parsed.type === 'stop') {
    if (!hasOnlyKeys(parsed, ['v', 'type'])) {
      throw new GuardedVoiceError('invalid-message', 'stop frame is invalid')
    }
    return { v: WIRE_VERSION, type: 'stop' }
  }

  if (parsed.type === 'turn.commit') {
    if (!hasOnlyKeys(parsed, ['v', 'type'])) {
      throw new GuardedVoiceError('invalid-message', 'turn commit frame is invalid')
    }
    return { v: WIRE_VERSION, type: 'turn.commit' }
  }

  throw new GuardedVoiceError('invalid-message', 'control frame type is not supported')
}

export function encodeServerControl(event: ServerControl): string {
  return JSON.stringify(event)
}

function validDisplayString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** Parse one Host control event in the browser with an exact, fail-closed schema. */
export function parseServerControl(raw: string): ServerControl {
  if (controlBytes(raw) > MAX_CONTROL_BYTES) {
    throw new GuardedVoiceError('invalid-message', 'server control frame exceeds the byte limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GuardedVoiceError('invalid-message', 'server control frame is not valid JSON')
  }
  if (!isRecord(parsed) || parsed.v !== WIRE_VERSION || typeof parsed.type !== 'string') {
    throw new GuardedVoiceError('invalid-message', 'server control frame has an unsupported shape or version')
  }

  if (parsed.type === 'consent.required') {
    if (!hasOnlyKeys(parsed, [
      'v', 'type', 'challenge', 'expiresAt', 'sessionId', 'workspaceId', 'provider', 'disclosure',
    ])
      || typeof parsed.challenge !== 'string'
      || !CHALLENGE_PATTERN.test(parsed.challenge)
      || typeof parsed.expiresAt !== 'number'
      || !Number.isSafeInteger(parsed.expiresAt)
      || parsed.expiresAt <= 0
      || !isValidWireId(parsed.sessionId)
      || !isValidWireId(parsed.workspaceId)
      || parsed.provider !== 'qwen'
      || !isRecord(parsed.disclosure)
      || !hasOnlyKeys(parsed.disclosure, [
        'audioDestination', 'exportedContext', 'executionAuthority', 'providerRetention', 'currentMilestone',
      ])
      || parsed.disclosure.audioDestination !== 'Alibaba Cloud Qwen realtime API'
      || parsed.disclosure.exportedContext !== 'none'
      || parsed.disclosure.executionAuthority !== 'none'
      || parsed.disclosure.providerRetention !== 'not specified for Qwen realtime audio'
      || parsed.disclosure.currentMilestone !== 'one bounded manual audio turn after acceptance') {
      throw new GuardedVoiceError('invalid-message', 'consent-required event is invalid')
    }
    return {
      v: WIRE_VERSION,
      type: 'consent.required',
      challenge: parsed.challenge,
      expiresAt: parsed.expiresAt,
      sessionId: parsed.sessionId,
      workspaceId: parsed.workspaceId,
      provider: 'qwen',
      disclosure: {
        audioDestination: 'Alibaba Cloud Qwen realtime API',
        exportedContext: 'none',
        executionAuthority: 'none',
        providerRetention: 'not specified for Qwen realtime audio',
        currentMilestone: 'one bounded manual audio turn after acceptance',
      },
    }
  }

  if (parsed.type === 'ready') {
    if (!hasOnlyKeys(parsed, ['v', 'type', 'sessionId', 'workspaceId', 'provider', 'model', 'authority'])
      || !isValidWireId(parsed.sessionId)
      || !isValidWireId(parsed.workspaceId)
      || parsed.provider !== 'qwen'
      || !validDisplayString(parsed.model, MAX_MODEL_LENGTH)
      || parsed.authority !== 'proposal-only') {
      throw new GuardedVoiceError('invalid-message', 'ready event is invalid')
    }
    return {
      v: WIRE_VERSION,
      type: 'ready',
      sessionId: parsed.sessionId,
      workspaceId: parsed.workspaceId,
      provider: 'qwen',
      model: parsed.model,
      authority: 'proposal-only',
    }
  }

  if (parsed.type === 'error') {
    if (!hasOnlyKeys(parsed, ['v', 'type', 'code', 'message'])
      || !validDisplayString(parsed.code, MAX_ERROR_CODE_LENGTH)
      || !validDisplayString(parsed.message, MAX_ERROR_MESSAGE_LENGTH)) {
      throw new GuardedVoiceError('invalid-message', 'error event is invalid')
    }
    return { v: WIRE_VERSION, type: 'error', code: parsed.code, message: parsed.message }
  }

  if (parsed.type === 'stopped') {
    if (!hasOnlyKeys(parsed, ['v', 'type'])) {
      throw new GuardedVoiceError('invalid-message', 'stopped event is invalid')
    }
    return { v: WIRE_VERSION, type: 'stopped' }
  }


  if (parsed.type === 'transcript') {
    if (!hasOnlyKeys(parsed, ['v', 'type', 'role', 'text', 'final'])
      || (parsed.role !== 'user' && parsed.role !== 'assistant')
      || typeof parsed.text !== 'string'
      || parsed.text.length > MAX_TRANSCRIPT_LENGTH
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(parsed.text)
      || typeof parsed.final !== 'boolean') {
      throw new GuardedVoiceError('invalid-message', 'transcript event is invalid')
    }
    return {
      v: WIRE_VERSION,
      type: 'transcript',
      role: parsed.role,
      text: parsed.text,
      final: parsed.final,
    }
  }

  if (parsed.type === 'turn.done') {
    if (!hasOnlyKeys(parsed, ['v', 'type', 'status'])
      || (parsed.status !== 'completed' && parsed.status !== 'cancelled')) {
      throw new GuardedVoiceError('invalid-message', 'turn-done event is invalid')
    }
    return { v: WIRE_VERSION, type: 'turn.done', status: parsed.status }
  }

  throw new GuardedVoiceError('invalid-message', 'server control frame type is not supported')
}
