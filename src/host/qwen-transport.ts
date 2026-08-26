import { Buffer } from 'node:buffer'
import {
  WebSocket,
  type RawData,
} from 'ws'
import { GuardedVoiceError } from '../shared/errors.js'
import {
  MAX_QWEN_PROVIDER_CONTROL_BYTES,
  QwenHandshake,
  buildQwenRealtimeEndpoint,
  type QwenRealtimeModel,
} from './qwen.js'

export const DEFAULT_QWEN_READY_TIMEOUT_MS = 10_000
export const MAX_QWEN_READY_TIMEOUT_MS = 60_000
export const MAX_QWEN_CREDENTIAL_BYTES = 4_096

export type QwenSessionCloseReason =
  | 'aborted'
  | 'local'
  | 'protocol-error'
  | 'provider-closed'
  | 'transport-error'

export interface QwenSessionLease {
  /** Resolves with a value-free reason when the provider connection ends. */
  readonly closed: Promise<QwenSessionCloseReason>
  /** Idempotently ends this provider session. */
  close(): void
}

export interface OpenQwenSessionOptions {
  readonly workspaceId: string
  readonly model: QwenRealtimeModel
  /**
   * Resolve once for this operation. The signal is canceled on caller abort,
   * timeout, or transport closure, and the returned value is never exposed.
   */
  readonly resolveCredential: (signal: AbortSignal) => Promise<string | undefined>
  readonly signal: AbortSignal
  readonly readyTimeoutMs?: number
}

interface QwenSocketFactoryOptions {
  readonly authorization: string
  readonly handshakeTimeoutMs: number
  readonly maxPayload: number
}

export interface QwenTransportDependencies {
  /** Test seam. Production callers should use the fixed default dialer. */
  readonly createSocket?: (
    endpoint: URL,
    options: QwenSocketFactoryOptions,
  ) => WebSocket
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void
}

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

function buildAuthorization(value: string | undefined): string {
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

function rawBytes(raw: RawData): Uint8Array {
  if (Array.isArray(raw)) return Buffer.concat(raw)
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw)
  return raw
}

function safeOpenFailure(kind: 'aborted' | 'failed' | 'timed-out'): GuardedVoiceError {
  if (kind === 'aborted') {
    return new GuardedVoiceError('invalid-state', 'Qwen realtime session was cancelled')
  }
  if (kind === 'timed-out') {
    return new GuardedVoiceError('invalid-state', 'Qwen realtime session timed out')
  }
  return new GuardedVoiceError('invalid-state', 'Qwen realtime session failed')
}

/**
 * Establish an authenticated, configuration-only Qwen session.
 *
 * This transport sends exactly one fixed session.update requesting text-only,
 * push-to-talk configuration. It exposes no socket or send method, and cannot
 * transmit audio, transcript text, instructions, tools, or DSH context.
 */
export function openQwenSession(
  options: OpenQwenSessionOptions,
  dependencies: QwenTransportDependencies = {},
): Promise<QwenSessionLease> {
  const timeoutMs = checkedTimeout(options.readyTimeoutMs)
  const endpoint = buildQwenRealtimeEndpoint(options.workspaceId, options.model)
  const createSocket = dependencies.createSocket ?? defaultCreateSocket
  const schedule = dependencies.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancelScheduled = dependencies.cancelScheduled ?? (timer => clearTimeout(timer))
  const operationController = new AbortController()
  const handshake = new QwenHandshake({
    session: {
      modalities: ['text'],
      turn_detection: null,
    },
  }, options.model, {
    modalities: ['text'],
    turnDetection: null,
  })
  const decoder = new TextDecoder('utf-8', { fatal: true })

  let state: 'opening' | 'ready' | 'closing' | 'closed' = 'opening'
  let socket: WebSocket | undefined
  let readyTimer: ReturnType<typeof setTimeout> | undefined
  let forceCloseTimer: ReturnType<typeof setTimeout> | undefined
  let closingReason: QwenSessionCloseReason | undefined
  let resolveClosed: (reason: QwenSessionCloseReason) => void = () => {}
  const closed = new Promise<QwenSessionCloseReason>((resolve) => { resolveClosed = resolve })

  let resolveOpen: (lease: QwenSessionLease) => void = () => {}
  let rejectOpen: (error: GuardedVoiceError) => void = () => {}
  const opened = new Promise<QwenSessionLease>((resolve, reject) => {
    resolveOpen = resolve
    rejectOpen = reject
  })

  const detachOperationalListeners = (): void => {
    if (socket === undefined) return
    socket.off('message', onMessage)
    socket.off('error', onError)
    socket.off('close', onClose)
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
    resolveClosed(closingReason ?? 'transport-error')
  }

  const beginClose = (
    reason: QwenSessionCloseReason,
    failure?: GuardedVoiceError,
    graceful = false,
  ): void => {
    if (state === 'closing' || state === 'closed') return
    const previous = state
    state = 'closing'
    closingReason = reason
    handshake.close()
    if (!operationController.signal.aborted) operationController.abort()
    if (readyTimer !== undefined) {
      cancelScheduled(readyTimer)
      readyTimer = undefined
    }
    options.signal.removeEventListener('abort', onAbort)
    detachOperationalListeners()
    if (previous === 'opening') rejectOpen(failure ?? safeOpenFailure('failed'))
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
    beginClose('protocol-error', safeOpenFailure('failed'))
  }

  function onMessage(raw: RawData, isBinary: boolean): void {
    if (state === 'closing' || state === 'closed') return
    if (isBinary) {
      failProtocol()
      return
    }
    const bytes = rawBytes(raw)
    if (bytes.byteLength > MAX_QWEN_PROVIDER_CONTROL_BYTES) {
      failProtocol()
      return
    }
    try {
      const action = handshake.receive(decoder.decode(bytes))
      if (action.kind === 'send') {
        if (socket?.readyState !== WebSocket.OPEN) {
          failProtocol()
          return
        }
        socket.send(JSON.stringify(action.payload), (error) => {
          if (error != null) beginClose('transport-error', safeOpenFailure('failed'))
        })
        return
      }
      if (state !== 'opening') {
        failProtocol()
        return
      }
      state = 'ready'
      if (readyTimer !== undefined) {
        cancelScheduled(readyTimer)
        readyTimer = undefined
      }
      resolveOpen({
        closed,
        close: () => { beginClose('local', undefined, true) },
      })
    } catch {
      failProtocol()
    }
  }

  function onError(): void {
    beginClose('transport-error', safeOpenFailure('failed'))
  }

  function onClose(): void {
    beginClose('provider-closed', safeOpenFailure('failed'))
  }

  function onAbort(): void {
    beginClose('aborted', safeOpenFailure('aborted'))
  }

  function onCleanupError(): void {
    // Value-free terminal handling; the following close event owns completion.
  }

  function onCleanupClose(): void {
    completeClose()
  }

  if (options.signal.aborted) {
    beginClose('aborted', safeOpenFailure('aborted'))
    return opened
  }
  options.signal.addEventListener('abort', onAbort, { once: true })
  readyTimer = schedule(() => {
    beginClose('transport-error', safeOpenFailure('timed-out'))
  }, timeoutMs)

  void Promise.resolve()
    .then(() => {
      if (state !== 'opening' || options.signal.aborted) return undefined
      return options.resolveCredential(operationController.signal)
    })
    .then((credential) => {
      if (state !== 'opening' || options.signal.aborted) return
      const authorization = buildAuthorization(credential)
      socket = createSocket(endpoint, {
        authorization,
        handshakeTimeoutMs: timeoutMs,
        maxPayload: MAX_QWEN_PROVIDER_CONTROL_BYTES,
      })
      socket.on('message', onMessage)
      socket.once('error', onError)
      socket.once('close', onClose)
    })
    .catch((error: unknown) => {
      if (state !== 'opening') return
      if (error instanceof GuardedVoiceError) beginClose('transport-error', error)
      else beginClose('transport-error', safeOpenFailure('failed'))
    })

  return opened
}
