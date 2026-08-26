import { GuardedVoiceError } from '../shared/errors.js'

export const QWEN_REALTIME_MODELS = [
  'qwen-audio-3.0-realtime-plus',
  'qwen-audio-3.0-realtime-flash',
] as const

export type QwenRealtimeModel = typeof QWEN_REALTIME_MODELS[number]

export const DEFAULT_QWEN_REALTIME_MODEL: QwenRealtimeModel = 'qwen-audio-3.0-realtime-plus'

const WORKSPACE_LABEL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/

export function isQwenRealtimeModel(value: string): value is QwenRealtimeModel {
  return (QWEN_REALTIME_MODELS as readonly string[]).includes(value)
}

/** Construct the documented China/Beijing endpoint without accepting arbitrary hosts. */
export function buildQwenRealtimeEndpoint(
  dashscopeWorkspaceId: string,
  model: QwenRealtimeModel,
): URL {
  if (!WORKSPACE_LABEL.test(dashscopeWorkspaceId)) {
    throw new GuardedVoiceError('provider-unconfigured', 'DashScope workspace id is missing or invalid')
  }
  if (!isQwenRealtimeModel(model)) {
    throw new GuardedVoiceError('provider-unconfigured', 'Qwen realtime model is not supported')
  }
  const endpoint = new URL(`wss://${dashscopeWorkspaceId}.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime`)
  endpoint.searchParams.set('model', model)
  return endpoint
}

type HandshakePhase = 'awaiting-created' | 'awaiting-updated' | 'ready' | 'closed'

export const MAX_QWEN_PROVIDER_CONTROL_BYTES = 64 * 1024

export type QwenHandshakeAction =
  | { readonly kind: 'send'; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly kind: 'ready' }

function parseProviderEvent(raw: string): Record<string, unknown> {
  if (new TextEncoder().encode(raw).byteLength > MAX_QWEN_PROVIDER_CONTROL_BYTES) {
    throw new GuardedVoiceError('invalid-message', 'provider control event exceeds the byte limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new GuardedVoiceError('invalid-message', 'provider control event is not valid JSON')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new GuardedVoiceError('invalid-message', 'provider control event has an invalid shape')
  }
  const event = parsed as Record<string, unknown>
  if (typeof event.type !== 'string') {
    throw new GuardedVoiceError('invalid-message', 'provider control event has no type')
  }
  return event
}

interface QwenSessionIdentity {
  readonly id: string
  readonly model: string
  readonly session: Readonly<Record<string, unknown>>
}

export interface QwenUpdatedSessionExpectation {
  readonly modalities: readonly string[]
  readonly turnDetection: null
}

function parseSessionIdentity(
  event: Readonly<Record<string, unknown>>,
  expectedModel?: QwenRealtimeModel,
): QwenSessionIdentity {
  const session = event.session
  if (session === null || typeof session !== 'object' || Array.isArray(session)) {
    throw new GuardedVoiceError('invalid-message', 'Qwen session event has no session object')
  }
  const record = session as Record<string, unknown>
  if (record.object !== 'realtime.session') {
    throw new GuardedVoiceError('invalid-message', 'Qwen session event has an invalid object type')
  }
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 256) {
    throw new GuardedVoiceError('invalid-message', 'Qwen session event has an invalid id')
  }
  if (typeof record.model !== 'string' || !isQwenRealtimeModel(record.model)) {
    throw new GuardedVoiceError('invalid-message', 'Qwen session event has an invalid model')
  }
  if (expectedModel !== undefined && record.model !== expectedModel) {
    throw new GuardedVoiceError('invalid-state', 'Qwen session model does not match the request')
  }
  return { id: record.id, model: record.model, session: record }
}

function hasExpectedUpdatedSession(
  actual: Readonly<Record<string, unknown>>,
  expected: QwenUpdatedSessionExpectation,
): boolean {
  return Array.isArray(actual.modalities)
    && actual.modalities.length === expected.modalities.length
    && actual.modalities.every((value, index) => value === expected.modalities[index])
    && actual.turn_detection === expected.turnDetection
}

/**
 * Enforces the documented session.created -> session.update ->
 * session.updated ordering. Callers supply the update body and may require the
 * provider to confirm an exact model and effective session configuration.
 */
export class QwenHandshake {
  private phase: HandshakePhase = 'awaiting-created'
  private readonly sessionUpdate: Readonly<Record<string, unknown>>
  private readonly expectedModel: QwenRealtimeModel | undefined
  private readonly expectedUpdatedSession: QwenUpdatedSessionExpectation | undefined
  private sessionIdentity: QwenSessionIdentity | undefined

  constructor(
    sessionUpdate: Readonly<Record<string, unknown>>,
    expectedModel?: QwenRealtimeModel,
    expectedUpdatedSession?: QwenUpdatedSessionExpectation,
  ) {
    if ('type' in sessionUpdate) {
      throw new TypeError('session update body must not override the event type')
    }
    this.sessionUpdate = structuredClone(sessionUpdate)
    this.expectedModel = expectedModel
    this.expectedUpdatedSession = expectedUpdatedSession === undefined
      ? undefined
      : {
          modalities: [...expectedUpdatedSession.modalities],
          turnDetection: expectedUpdatedSession.turnDetection,
        }
  }

  receive(raw: string): QwenHandshakeAction {
    if (this.phase === 'closed') {
      throw new GuardedVoiceError('invalid-state', 'provider handshake is closed')
    }
    const event = parseProviderEvent(raw)
    if (event.type === 'error') {
      this.phase = 'closed'
      throw new GuardedVoiceError('invalid-state', 'Qwen rejected the realtime session')
    }
    if (this.phase === 'awaiting-created' && event.type === 'session.created') {
      this.sessionIdentity = parseSessionIdentity(event, this.expectedModel)
      this.phase = 'awaiting-updated'
      return { kind: 'send', payload: { ...this.sessionUpdate, type: 'session.update' } }
    }
    if (this.phase === 'awaiting-updated' && event.type === 'session.updated') {
      const updatedIdentity = parseSessionIdentity(event, this.expectedModel)
      if (
        this.sessionIdentity === undefined
        || updatedIdentity.id !== this.sessionIdentity.id
        || updatedIdentity.model !== this.sessionIdentity.model
      ) {
        this.phase = 'closed'
        throw new GuardedVoiceError('invalid-state', 'Qwen session identity changed during the handshake')
      }
      if (
        this.expectedUpdatedSession !== undefined
        && !hasExpectedUpdatedSession(updatedIdentity.session, this.expectedUpdatedSession)
      ) {
        this.phase = 'closed'
        throw new GuardedVoiceError('invalid-state', 'Qwen session configuration does not match the request')
      }
      this.phase = 'ready'
      return { kind: 'ready' }
    }
    throw new GuardedVoiceError('invalid-state', 'Qwen realtime handshake event arrived out of order')
  }

  assertReady(): void {
    if (this.phase !== 'ready') {
      throw new GuardedVoiceError('invalid-state', 'Qwen realtime session is not ready')
    }
  }

  close(): void {
    this.phase = 'closed'
  }
}
