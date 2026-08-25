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

export type QwenHandshakeAction =
  | { readonly kind: 'send'; readonly payload: Readonly<Record<string, unknown>> }
  | { readonly kind: 'ready' }

function parseProviderEvent(raw: string): Record<string, unknown> {
  if (new TextEncoder().encode(raw).byteLength > 64 * 1024) {
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

/**
 * Enforces the documented session.created -> session.update ->
 * session.updated ordering. The live-tested session payload is deliberately
 * supplied by the future transport milestone rather than guessed here.
 */
export class QwenHandshake {
  private phase: HandshakePhase = 'awaiting-created'
  private readonly sessionUpdate: Readonly<Record<string, unknown>>

  constructor(sessionUpdate: Readonly<Record<string, unknown>>) {
    if ('type' in sessionUpdate) {
      throw new TypeError('session update body must not override the event type')
    }
    this.sessionUpdate = structuredClone(sessionUpdate)
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
      this.phase = 'awaiting-updated'
      return { kind: 'send', payload: { ...this.sessionUpdate, type: 'session.update' } }
    }
    if (this.phase === 'awaiting-updated' && event.type === 'session.updated') {
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
