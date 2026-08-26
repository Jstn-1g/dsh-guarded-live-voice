import { Buffer } from 'node:buffer'
import { WebSocket, type RawData } from 'ws'
import { GuardedVoiceError } from '../shared/errors.js'
import { MAX_CONTROL_BYTES } from '../shared/wire.js'
import {
  MAX_INPUT_PCM16_CHUNK_BYTES,
  MAX_INPUT_PCM16_TURN_BYTES,
  MAX_OUTPUT_PCM16_CHUNK_BYTES,
  MAX_OUTPUT_PCM16_TURN_BYTES,
  MAX_VOICE_SOCKET_BUFFERED_BYTES,
  MAX_VOICE_TRANSCRIPT_LENGTH,
} from '../shared/audio.js'
import type {
  ManualTurnProviderEvent,
  ManualTurnProviderSession,
} from './provider.js'
import {
  QwenHandshake,
  buildQwenRealtimeEndpoint,
  type QwenRealtimeModel,
} from './qwen.js'
import {
  DEFAULT_QWEN_READY_TIMEOUT_MS,
  MAX_QWEN_CREDENTIAL_BYTES,
  MAX_QWEN_READY_TIMEOUT_MS,
} from './qwen-transport.js'

export const MAX_QWEN_INPUT_CHUNK_BYTES = MAX_INPUT_PCM16_CHUNK_BYTES
export const MAX_QWEN_INPUT_TURN_BYTES = MAX_INPUT_PCM16_TURN_BYTES
export const MAX_QWEN_OUTPUT_CHUNK_BYTES = MAX_OUTPUT_PCM16_CHUNK_BYTES
export const MAX_QWEN_OUTPUT_TURN_BYTES = MAX_OUTPUT_PCM16_TURN_BYTES
export const MAX_QWEN_TRANSCRIPT_LENGTH = MAX_VOICE_TRANSCRIPT_LENGTH
export const MAX_QWEN_REALTIME_EVENT_BYTES = 256 * 1024
export const MAX_QWEN_BUFFERED_BYTES = MAX_VOICE_SOCKET_BUFFERED_BYTES
export const DEFAULT_QWEN_INPUT_TIMEOUT_MS = 60_000
export const DEFAULT_QWEN_RESPONSE_TIMEOUT_MS = 90_000
export const MAX_QWEN_PHASE_TIMEOUT_MS = 5 * 60_000

interface QwenSocketFactoryOptions {
  readonly authorization: string
  readonly handshakeTimeoutMs: number
  readonly maxPayload: number
}

export interface OpenQwenManualTurnOptions {
  readonly workspaceId: string
  readonly model: QwenRealtimeModel
  readonly resolveCredential: (signal: AbortSignal) => Promise<string | undefined>
  readonly signal: AbortSignal
  readonly readyTimeoutMs?: number
  readonly inputTimeoutMs?: number
  readonly responseTimeoutMs?: number
}

export interface QwenManualTurnDependencies {
  readonly createSocket?: (endpoint: URL, options: QwenSocketFactoryOptions) => WebSocket
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void
}

type CloseReason = ManualTurnProviderSession['closed'] extends Promise<infer Reason> ? Reason : never
type SessionState = 'opening' | 'input' | 'response' | 'done' | 'closing' | 'closed'

function defaultCreateSocket(endpoint: URL, options: QwenSocketFactoryOptions): WebSocket {
  return new WebSocket(endpoint, {
    followRedirects: false,
    handshakeTimeout: options.handshakeTimeoutMs,
    headers: { Authorization: options.authorization },
    maxPayload: options.maxPayload,
    perMessageDeflate: false,
  })
}

function checkedTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_QWEN_READY_TIMEOUT_MS
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_QWEN_READY_TIMEOUT_MS) {
    throw new TypeError(`Qwen ready timeout must be an integer from 1 to ${MAX_QWEN_READY_TIMEOUT_MS}`)
  }
  return timeout
}

function checkedPhaseTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_QWEN_PHASE_TIMEOUT_MS) {
    throw new TypeError(`${name} must be an integer from 1 to ${MAX_QWEN_PHASE_TIMEOUT_MS}`)
  }
  return timeout
}

function authorizationOf(value: string | undefined): string {
  if (
    value === undefined
    || value.length === 0
    || /[\r\n]/u.test(value)
    || Buffer.byteLength(value, 'utf8') > MAX_QWEN_CREDENTIAL_BYTES
  ) {
    throw new GuardedVoiceError('provider-unconfigured', 'DashScope credential is missing or invalid')
  }
  return `Bearer ${value}`
}

function bytesOf(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw)
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  return raw
}

function recordOf(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new GuardedVoiceError('invalid-message', message)
  }
  return value as Record<string, unknown>
}

function boundedString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== 'string'
    || (!allowEmpty && value.length === 0)
    || value.length > MAX_QWEN_TRANSCRIPT_LENGTH
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) {
    throw new GuardedVoiceError('invalid-message', `Qwen ${name} is invalid`)
  }
  return value
}

function strictBase64(value: unknown): Uint8Array {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new GuardedVoiceError('invalid-message', 'Qwen audio delta is not canonical base64')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.byteLength === 0
    || decoded.byteLength > MAX_QWEN_OUTPUT_CHUNK_BYTES
    || decoded.byteLength % 2 !== 0
    || decoded.toString('base64') !== value) {
    throw new GuardedVoiceError('invalid-message', 'Qwen audio delta is invalid')
  }
  return new Uint8Array(decoded)
}

function assertTranscriptFitsWire(value: string): void {
  const envelope = JSON.stringify({
    v: 1,
    type: 'transcript',
    role: 'assistant',
    text: value,
    final: false,
  })
  if (Buffer.byteLength(envelope, 'utf8') > MAX_CONTROL_BYTES) {
    throw new GuardedVoiceError('invalid-message', 'Qwen transcript exceeds the browser control byte limit')
  }
}

function parseEvent(raw: Uint8Array): Record<string, unknown> {
  if (raw.byteLength > MAX_QWEN_REALTIME_EVENT_BYTES) {
    throw new GuardedVoiceError('invalid-message', 'Qwen realtime event exceeds the byte limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    throw new GuardedVoiceError('invalid-message', 'Qwen realtime event is not valid JSON')
  }
  const event = recordOf(parsed, 'Qwen realtime event has an invalid shape')
  if (typeof event.type !== 'string') {
    throw new GuardedVoiceError('invalid-message', 'Qwen realtime event has no type')
  }
  return event
}

/**
 * Open one audio-enabled, push-to-talk Qwen session.
 *
 * The returned capability accepts one bounded PCM16 mono/16 kHz turn, exposes
 * only bounded transcripts and PCM16 mono/24 kHz output, and has no tool,
 * context-injection, text-input, or second-turn operation.
 */
export function openQwenManualTurn(
  options: OpenQwenManualTurnOptions,
  dependencies: QwenManualTurnDependencies = {},
): Promise<ManualTurnProviderSession> {
  const timeoutMs = checkedTimeout(options.readyTimeoutMs)
  const inputTimeoutMs = checkedPhaseTimeout(
    options.inputTimeoutMs,
    DEFAULT_QWEN_INPUT_TIMEOUT_MS,
    'Qwen input timeout',
  )
  const responseTimeoutMs = checkedPhaseTimeout(
    options.responseTimeoutMs,
    DEFAULT_QWEN_RESPONSE_TIMEOUT_MS,
    'Qwen response timeout',
  )
  const endpoint = buildQwenRealtimeEndpoint(options.workspaceId, options.model)
  const createSocket = dependencies.createSocket ?? defaultCreateSocket
  const schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelScheduled = dependencies.cancelScheduled ?? (timer => clearTimeout(timer))
  const operation = new AbortController()
  const handshake = new QwenHandshake({
    session: {
      modalities: ['text', 'audio'],
      input_audio_format: 'pcm',
      output_audio_format: 'pcm',
      turn_detection: null,
    },
  }, options.model, {
    modalities: ['text', 'audio'],
    turnDetection: null,
    inputAudioFormat: 'pcm',
    outputAudioFormat: 'pcm',
  })

  let state: SessionState = 'opening'
  let socket: WebSocket | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let phaseTimer: ReturnType<typeof setTimeout> | undefined
  let forceCloseTimer: ReturnType<typeof setTimeout> | undefined
  let closeReason: CloseReason = 'transport-error'
  let inputBytes = 0
  let outputBytes = 0
  let inputCommitted = false
  let inputItemId: string | undefined
  let inputContentIndex: number | undefined
  let responseId: string | undefined
  let assistantItemId: string | undefined
  let outputIndex: number | undefined
  let contentIndex: number | undefined
  let userStable = ''
  let userTranscript = ''
  let userTranscriptFinal = false
  let assistantTranscript = ''
  let assistantTranscriptFinal = false
  let assistantAudioDone = false
  let responseDone = false
  const listeners = new Set<(event: ManualTurnProviderEvent) => void>()

  let resolveClosed: (reason: CloseReason) => void = () => {}
  const closed = new Promise<CloseReason>((resolve) => { resolveClosed = resolve })
  let resolveOpened: (session: ManualTurnProviderSession) => void = () => {}
  let rejectOpened: (error: GuardedVoiceError) => void = () => {}
  const opened = new Promise<ManualTurnProviderSession>((resolve, reject) => {
    resolveOpened = resolve
    rejectOpened = reject
  })

  const emit = (event: ManualTurnProviderEvent): void => {
    for (const listener of [...listeners]) listener(event)
  }

  const send = (payload: Readonly<Record<string, unknown>>): void => {
    const encoded = JSON.stringify(payload)
    if (socket?.readyState !== WebSocket.OPEN
      || socket.bufferedAmount + Buffer.byteLength(encoded, 'utf8') > MAX_QWEN_BUFFERED_BYTES) {
      throw new GuardedVoiceError('invalid-state', 'Qwen realtime transport is not writable')
    }
    socket.send(encoded, (error) => {
      if (error != null) beginClose('transport-error')
    })
  }

  const detach = (): void => {
    socket?.off('message', onMessage)
    socket?.off('error', onError)
    socket?.off('close', onClose)
  }

  const completeClose = (): void => {
    if (state === 'closed') return
    state = 'closed'
    if (forceCloseTimer !== undefined) {
      cancelScheduled(forceCloseTimer)
      forceCloseTimer = undefined
    }
    socket?.off('error', onCleanupError)
    socket?.off('close', onCleanupClose)
    listeners.clear()
    resolveClosed(closeReason)
  }

  const beginClose = (reason: CloseReason, openingFailure?: GuardedVoiceError, graceful = false): void => {
    if (state === 'closing' || state === 'closed') return
    const previous = state
    state = 'closing'
    closeReason = reason
    handshake.close()
    if (!operation.signal.aborted) operation.abort()
    options.signal.removeEventListener('abort', onAbort)
    if (readyTimer !== undefined) {
      cancelScheduled(readyTimer)
      readyTimer = undefined
    }
    if (phaseTimer !== undefined) {
      cancelScheduled(phaseTimer)
      phaseTimer = undefined
    }
    detach()
    if (previous === 'opening') {
      rejectOpened(openingFailure ?? new GuardedVoiceError('invalid-state', 'Qwen realtime session failed'))
    }
    if (socket === undefined || socket.readyState === WebSocket.CLOSED) {
      completeClose()
      return
    }
    socket.once('error', onCleanupError)
    socket.once('close', onCleanupClose)
    try {
      if (graceful && socket.readyState === WebSocket.OPEN) {
        socket.close(1000)
        forceCloseTimer = schedule(() => {
          forceCloseTimer = undefined
          try {
            if (socket?.readyState !== WebSocket.CLOSED) socket?.terminate()
          } catch {
            completeClose()
          }
        }, 250)
      } else {
        socket.terminate()
      }
    } catch {
      completeClose()
    }
  }

  const failProtocol = (): void => {
    beginClose('protocol-error', new GuardedVoiceError('invalid-state', 'Qwen realtime protocol failed'))
  }

  const assertResponseIdentity = (event: Readonly<Record<string, unknown>>): void => {
    if (state !== 'response' || responseId === undefined) {
      throw new GuardedVoiceError('invalid-state', 'Qwen output arrived before response.created')
    }
    const id = boundedString(event.response_id, 'response id')
    if (responseId !== id) throw new GuardedVoiceError('invalid-state', 'Qwen response identity changed')
  }

  const exactIndex = (value: unknown, name: string): number => {
    if (value !== 0) {
      throw new GuardedVoiceError('invalid-message', `Qwen ${name} is invalid`)
    }
    return 0
  }

  const setExact = <T>(current: T | undefined, next: T, message: string): T => {
    if (current !== undefined && current !== next) {
      throw new GuardedVoiceError('invalid-state', message)
    }
    return next
  }

  const assertOutputIdentity = (event: Readonly<Record<string, unknown>>): void => {
    assertResponseIdentity(event)
    assistantItemId = setExact(
      assistantItemId,
      boundedString(event.item_id, 'assistant item id'),
      'Qwen assistant item identity changed',
    )
    outputIndex = setExact(
      outputIndex,
      exactIndex(event.output_index, 'output index'),
      'Qwen output index changed',
    )
    contentIndex = setExact(
      contentIndex,
      exactIndex(event.content_index, 'content index'),
      'Qwen content index changed',
    )
  }

  const hasAudioModalities = (value: unknown): boolean => Array.isArray(value)
    && value.length === 2
    && value[0] === 'text'
    && value[1] === 'audio'

  const validateOutputItem = (
    value: unknown,
    completed: boolean,
  ): void => {
    const item = recordOf(value, 'Qwen response output item is missing')
    if (item.object !== 'realtime.item' || item.type !== 'message' || item.role !== 'assistant') {
      throw new GuardedVoiceError('invalid-state', 'Qwen attempted a non-message output capability')
    }
    if (completed && item.status !== 'completed') {
      throw new GuardedVoiceError('invalid-state', 'Qwen assistant output did not complete')
    }
    assistantItemId = setExact(
      assistantItemId,
      boundedString(item.id, 'assistant item id'),
      'Qwen assistant item identity changed',
    )
    if (!Array.isArray(item.content) || item.content.length > 1 || (completed && item.content.length !== 1)) {
      throw new GuardedVoiceError('invalid-state', 'Qwen assistant content shape is invalid')
    }
    if (item.content.length === 1) {
      const part = recordOf(item.content[0], 'Qwen assistant audio content is missing')
      if (part.type !== 'audio') {
        throw new GuardedVoiceError('invalid-state', 'Qwen attempted a non-audio content capability')
      }
      if (completed) {
        const transcript = boundedString(part.transcript, 'completed output transcript', true)
        if (!assistantTranscriptFinal || transcript !== assistantTranscript) {
          throw new GuardedVoiceError('invalid-state', 'Qwen completed transcript identity changed')
        }
      }
    }
  }

  const publishUserTranscript = (event: Readonly<Record<string, unknown>>, final: boolean): void => {
    if (state !== 'response') {
      throw new GuardedVoiceError('invalid-state', 'Qwen input transcript arrived before commit')
    }
    const itemId = boundedString(event.item_id, 'input item id')
    if (inputItemId === undefined) inputItemId = itemId
    else if (inputItemId !== itemId) throw new GuardedVoiceError('invalid-state', 'Qwen input item identity changed')
    inputContentIndex = setExact(
      inputContentIndex,
      exactIndex(event.content_index, 'input content index'),
      'Qwen input content index changed',
    )
    if (userTranscriptFinal) {
      throw new GuardedVoiceError('invalid-state', 'Qwen input transcript changed after completion')
    }
    if (final) {
      const transcript = boundedString(event.transcript, 'input transcript', true)
      if (transcript.length > MAX_QWEN_TRANSCRIPT_LENGTH) {
        throw new GuardedVoiceError('invalid-message', 'Qwen input transcript exceeds the limit')
      }
      userStable = transcript
      userTranscript = transcript
      userTranscriptFinal = true
    } else {
      const text = boundedString(event.text, 'input transcript delta', true)
      const stash = boundedString(event.stash, 'input transcript stash', true)
      if (text.length + stash.length > MAX_QWEN_TRANSCRIPT_LENGTH) {
        throw new GuardedVoiceError('invalid-message', 'Qwen input transcript exceeds the limit')
      }
      // Qwen documents `text` as the complete confirmed prefix, while `stash`
      // is the replaceable tentative suffix for this event.
      userStable = text
      userTranscript = userStable + stash
    }
    assertTranscriptFitsWire(userTranscript)
    emit({ type: 'transcript', role: 'user', text: userTranscript, final })
  }

  const publishAssistantTranscript = (event: Readonly<Record<string, unknown>>, final: boolean): void => {
    assertOutputIdentity(event)
    if (assistantTranscriptFinal) {
      throw new GuardedVoiceError('invalid-state', 'Qwen output transcript changed after completion')
    }
    if (final) {
      const transcript = boundedString(event.transcript, 'output transcript', true)
      if (transcript.length > MAX_QWEN_TRANSCRIPT_LENGTH) {
        throw new GuardedVoiceError('invalid-message', 'Qwen output transcript exceeds the limit')
      }
      assistantTranscript = transcript
      assistantTranscriptFinal = true
    } else {
      const delta = boundedString(event.delta, 'output transcript delta', true)
      if (assistantTranscript.length + delta.length > MAX_QWEN_TRANSCRIPT_LENGTH) {
        throw new GuardedVoiceError('invalid-message', 'Qwen output transcript exceeds the limit')
      }
      assistantTranscript += delta
    }
    assertTranscriptFitsWire(assistantTranscript)
    emit({ type: 'transcript', role: 'assistant', text: assistantTranscript, final })
  }

  const handleReadyEvent = (event: Readonly<Record<string, unknown>>): void => {
    if (state === 'done') {
      throw new GuardedVoiceError('invalid-state', 'Qwen emitted data after the terminal response')
    }
    switch (event.type) {
      case 'input_audio_buffer.committed': {
        if (state !== 'response' || inputCommitted) {
          throw new GuardedVoiceError('invalid-state', 'Qwen input commit arrived out of order')
        }
        const itemId = boundedString(event.item_id, 'committed item id')
        if (inputItemId === undefined) inputItemId = itemId
        else if (inputItemId !== itemId) throw new GuardedVoiceError('invalid-state', 'Qwen input item identity changed')
        inputCommitted = true
        return
      }
      case 'conversation.item.input_audio_transcription.delta':
        publishUserTranscript(event, false)
        return
      case 'conversation.item.input_audio_transcription.completed':
        publishUserTranscript(event, true)
        return
      case 'response.created': {
        if (state !== 'response' || responseId !== undefined) {
          throw new GuardedVoiceError('invalid-state', 'Qwen response began out of order')
        }
        const response = recordOf(event.response, 'Qwen response.created has no response')
        if (response.object !== 'realtime.response'
          || response.status !== 'in_progress'
          || !hasAudioModalities(response.modalities)
          || !Array.isArray(response.output)
          || response.output.length !== 0) {
          throw new GuardedVoiceError('invalid-state', 'Qwen response.created is not the requested audio response')
        }
        const id = boundedString(response.id, 'response id')
        if (responseId !== undefined && responseId !== id) {
          throw new GuardedVoiceError('invalid-state', 'Qwen response identity changed')
        }
        responseId = id
        return
      }
      case 'response.output_item.added':
      case 'response.output_item.done': {
        assertResponseIdentity(event)
        outputIndex = setExact(
          outputIndex,
          exactIndex(event.output_index, 'output index'),
          'Qwen output index changed',
        )
        const item = recordOf(event.item, 'Qwen output item is missing')
        if (item.type !== 'message' || item.role !== 'assistant') {
          throw new GuardedVoiceError('invalid-state', 'Qwen attempted a non-message output capability')
        }
        assistantItemId = setExact(
          assistantItemId,
          boundedString(item.id, 'assistant item id'),
          'Qwen assistant item identity changed',
        )
        return
      }
      case 'response.content_part.added':
      case 'response.content_part.done': {
        assertOutputIdentity(event)
        const part = recordOf(event.part, 'Qwen response content part is missing')
        if (part.type !== 'audio') {
          throw new GuardedVoiceError('invalid-state', 'Qwen attempted a non-audio content capability')
        }
        return
      }
      case 'conversation.item.created': {
        const item = recordOf(event.item, 'Qwen conversation item is missing')
        const itemId = boundedString(item.id, 'conversation item id')
        if (item.type !== 'message' || (item.role !== 'user' && item.role !== 'assistant')) {
          throw new GuardedVoiceError('invalid-state', 'Qwen attempted a non-message conversation capability')
        }
        if (item.role === 'user') {
          if (state !== 'response') {
            throw new GuardedVoiceError('invalid-state', 'Qwen user item arrived before commit')
          }
          inputItemId = setExact(inputItemId, itemId, 'Qwen input item identity changed')
        } else {
          if (state !== 'response' || responseId === undefined) {
            throw new GuardedVoiceError('invalid-state', 'Qwen assistant item arrived before response.created')
          }
          assistantItemId = setExact(assistantItemId, itemId, 'Qwen assistant item identity changed')
        }
        return
      }
      case 'response.audio_transcript.delta':
        publishAssistantTranscript(event, false)
        return
      case 'response.audio_transcript.done':
        publishAssistantTranscript(event, true)
        return
      case 'response.audio.delta': {
        assertOutputIdentity(event)
        if (assistantAudioDone) {
          throw new GuardedVoiceError('invalid-state', 'Qwen output audio changed after completion')
        }
        const pcm24 = strictBase64(event.delta)
        outputBytes += pcm24.byteLength
        if (outputBytes > MAX_QWEN_OUTPUT_TURN_BYTES) {
          throw new GuardedVoiceError('invalid-message', 'Qwen output audio exceeds the turn limit')
        }
        emit({ type: 'audio', pcm24 })
        return
      }
      case 'response.done': {
        if (responseDone || state !== 'response') {
          throw new GuardedVoiceError('invalid-state', 'Qwen response completed out of order')
        }
        const response = recordOf(event.response, 'Qwen response.done has no response')
        const id = boundedString(response.id, 'response id')
        if (responseId === undefined || responseId !== id) {
          throw new GuardedVoiceError('invalid-state', 'Qwen response identity changed')
        }
        if (response.status !== 'completed' && response.status !== 'cancelled') {
          throw new GuardedVoiceError('invalid-state', 'Qwen response did not complete safely')
        }
        if (response.status === 'completed') {
          if (response.object !== 'realtime.response'
            || !hasAudioModalities(response.modalities)
            || !Array.isArray(response.output)
            || response.output.length !== 1
            || !assistantTranscriptFinal
            || !assistantAudioDone
            || outputBytes === 0) {
            throw new GuardedVoiceError('invalid-state', 'Qwen response completed before final transcript and audio')
          }
          validateOutputItem(response.output[0], true)
        } else {
          if (response.object !== undefined && response.object !== 'realtime.response') {
            throw new GuardedVoiceError('invalid-state', 'Qwen cancelled response has an invalid object')
          }
          if (response.modalities !== undefined && !hasAudioModalities(response.modalities)) {
            throw new GuardedVoiceError('invalid-state', 'Qwen cancelled response changed modalities')
          }
          if (response.output !== undefined) {
            if (!Array.isArray(response.output) || response.output.length > 1) {
              throw new GuardedVoiceError('invalid-state', 'Qwen cancelled response output is invalid')
            }
            if (response.output.length === 1) validateOutputItem(response.output[0], false)
          }
        }
        responseDone = true
        state = 'done'
        emit({ type: 'done', status: response.status })
        beginClose('local', undefined, true)
        return
      }
      case 'response.audio.done':
        assertOutputIdentity(event)
        if (assistantAudioDone || outputBytes === 0) {
          throw new GuardedVoiceError('invalid-state', 'Qwen output audio completed out of order')
        }
        assistantAudioDone = true
        return
      case 'error':
        throw new GuardedVoiceError('invalid-state', 'Qwen rejected the manual turn')
      default:
        throw new GuardedVoiceError('invalid-message', 'Qwen realtime event type is not allowed')
    }
  }

  function onMessage(raw: RawData, isBinary: boolean): void {
    if (state === 'closing' || state === 'closed') return
    if (isBinary) {
      failProtocol()
      return
    }
    try {
      const bytes = bytesOf(raw)
      if (state === 'opening') {
        const action = handshake.receive(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        if (action.kind === 'send') {
          send(action.payload)
          return
        }
        if (readyTimer !== undefined) {
          cancelScheduled(readyTimer)
          readyTimer = undefined
        }
        state = 'input'
        phaseTimer = schedule(() => {
          phaseTimer = undefined
          beginClose('transport-error')
        }, inputTimeoutMs)
        resolveOpened(session)
        return
      }
      handleReadyEvent(parseEvent(bytes))
    } catch {
      failProtocol()
    }
  }

  function onError(): void { beginClose('transport-error') }
  function onClose(): void { beginClose('provider-closed') }
  function onAbort(): void {
    beginClose('transport-error', new GuardedVoiceError('invalid-state', 'Qwen realtime session was cancelled'))
  }
  function onCleanupError(): void {}
  function onCleanupClose(): void { completeClose() }

  const session: ManualTurnProviderSession = {
    authorization: { provider: 'qwen', model: options.model },
    closed,
    appendPcm16(chunk) {
      if (state !== 'input') throw new GuardedVoiceError('invalid-state', 'Qwen manual turn is not accepting audio')
      if (chunk.byteLength === 0
        || chunk.byteLength > MAX_QWEN_INPUT_CHUNK_BYTES
        || chunk.byteLength % 2 !== 0) {
        throw new GuardedVoiceError('invalid-message', 'PCM16 input chunk is invalid')
      }
      inputBytes += chunk.byteLength
      if (inputBytes > MAX_QWEN_INPUT_TURN_BYTES) {
        throw new GuardedVoiceError('invalid-message', 'PCM16 input exceeds the turn limit')
      }
      try {
        send({ type: 'input_audio_buffer.append', audio: Buffer.from(chunk).toString('base64') })
      } catch (error) {
        beginClose('transport-error')
        throw error
      }
    },
    commit() {
      if (state !== 'input' || inputBytes === 0) {
        throw new GuardedVoiceError('invalid-state', 'Qwen manual turn has no audio to commit')
      }
      state = 'response'
      if (phaseTimer !== undefined) {
        cancelScheduled(phaseTimer)
        phaseTimer = undefined
      }
      phaseTimer = schedule(() => {
        phaseTimer = undefined
        beginClose('transport-error')
      }, responseTimeoutMs)
      try {
        send({ type: 'input_audio_buffer.commit' })
        send({ type: 'response.create', response: { modalities: ['text', 'audio'] } })
      } catch (error) {
        beginClose('transport-error')
        throw error
      }
    },
    close() { beginClose('local', undefined, true) },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  if (options.signal.aborted) {
    beginClose('transport-error', new GuardedVoiceError('invalid-state', 'Qwen realtime session was cancelled'))
    return opened
  }
  options.signal.addEventListener('abort', onAbort, { once: true })
  readyTimer = schedule(() => {
    beginClose('transport-error', new GuardedVoiceError('invalid-state', 'Qwen realtime session timed out'))
  }, timeoutMs)

  void Promise.resolve()
    .then(() => {
      if (state !== 'opening' || options.signal.aborted) return undefined
      return options.resolveCredential(operation.signal)
    })
    .then((credential) => {
      if (state !== 'opening' || options.signal.aborted) return
      socket = createSocket(endpoint, {
        authorization: authorizationOf(credential),
        handshakeTimeoutMs: timeoutMs,
        maxPayload: MAX_QWEN_REALTIME_EVENT_BYTES,
      })
      socket.on('message', onMessage)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
    .catch((error: unknown) => {
      if (state !== 'opening') return
      beginClose(
        'transport-error',
        error instanceof GuardedVoiceError
          ? error
          : new GuardedVoiceError('invalid-state', 'Qwen realtime session failed'),
      )
    })

  return opened
}
