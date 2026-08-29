import { MessageChannel, type MessagePort } from 'node:worker_threads'
import { performance } from 'node:perf_hooks'
import { createHash, randomBytes } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import {
  apply as applyHostConnection,
  inject as hostConnectionInject,
} from '@deepseek-ai/dsh-client-connection'
import {
  apply as applyClientConnection,
  type ConnectionHandle,
} from '@deepseek-ai/dsh-client-connection/client'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import {
  apply as applyClientGateway,
  inject as clientGatewayInject,
} from '@deepseek-ai/dsh-api-gateway/client'
import { bindTypertRemote, TypertRemoteFailure } from '@deepseek-ai/dsh-typert-protocol'
import type {
  InvocationDescriptor,
  RemoteResult,
  TypertContribution,
  TypertRemoteContribution,
} from '@deepseek-ai/dsh-typert-protocol'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { WorkspaceTypertGenerator } from '../../../typert/generator/src/workspace.ts'
import { WorkerTunnel } from '../../../experimental/webworker-runtime/src/client/client.ts'
import { TunnelServer } from '../../../experimental/webworker-runtime/src/transport/tunnel.ts'
import type {
  TunnelInboundFrame,
  TunnelOutboundFrame,
  TunnelRequestId,
  TunnelStreamErrorFrame,
} from '../../../experimental/webworker-runtime/src/transport/frames.ts'
import { AuthorityGuard } from '__VOICE_IMPORT_BASE__/host/authority.ts'
import { ConsentChallenges } from '__VOICE_IMPORT_BASE__/host/consent.ts'
import { ManualTurnCoordinator } from '__VOICE_IMPORT_BASE__/host/manual-turn.ts'
import type {
  ManualTurnProviderEvent,
  ManualTurnProviderSession,
  ProviderAuthorization,
} from '__VOICE_IMPORT_BASE__/host/provider.ts'
import { VoiceSessionManager } from '__VOICE_IMPORT_BASE__/host/session-manager.ts'
import { asGuardedVoiceError } from '__VOICE_IMPORT_BASE__/shared/errors.ts'
import {
  MAX_INPUT_PCM16_CHUNK_BYTES,
  MAX_INPUT_PCM16_TURN_BYTES,
  MAX_OUTPUT_PCM16_CHUNK_BYTES,
  MAX_OUTPUT_PCM16_TURN_BYTES,
  MAX_VOICE_TRANSCRIPT_LENGTH,
} from '__VOICE_IMPORT_BASE__/shared/audio.ts'

const FIXTURE_ROOT = process.env.DSH_LIVE_VOICE_IPC_FIXTURE_ROOT
if (FIXTURE_ROOT === undefined) throw new Error('DSH_LIVE_VOICE_IPC_FIXTURE_ROOT is required')

const MAX_EVENT_QUEUE_ITEMS = 8
const MAX_EVENT_QUEUE_BYTES = 256 * 1024
const MAX_PENDING_UNARY = 8
const MAX_PENDING_STREAMS = 4
const MAX_ACTIVE_CONNECTIONS = 8
const MAX_SYNTHETIC_RPC_BODY_BYTES = 96 * 1024
const MAX_STREAM_INBOX_ITEMS = 8
const MAX_STREAM_INBOX_BYTES = 512 * 1024
const MAX_STREAM_OPEN_JSON_DEPTH = 32
const MAX_STREAM_OPEN_JSON_NODES = 1_024
const CAPABILITY_BYTES = 32

interface IpcConsentReceipt {
  readonly connectionId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly challenge: string
  readonly expiresAt: number
}

interface IpcReadyReceipt {
  readonly connectionId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly provider: 'qwen'
  readonly model: string
}

interface IpcPcm16Frame {
  readonly sequence: number
  readonly pcm16Base64: string
}

interface IpcAppendReceipt {
  readonly acceptedBytes: number
  readonly turnBytes: number
  readonly nextSequence: number
}

interface IpcControlReceipt { readonly stopped: boolean }

type IpcVoiceEvent =
  | { readonly sequence: number; readonly type: 'transcript'; readonly role: 'user' | 'assistant'; readonly text: string; readonly final: boolean }
  | { readonly sequence: number; readonly type: 'audio'; readonly pcm24Base64: string }
  | { readonly sequence: number; readonly type: 'done'; readonly status: 'completed' | 'cancelled' }

interface IpcRemote {
  begin(sessionId: string): Promise<RemoteResult<IpcConsentReceipt>>
  accept(connectionId: string, challenge: string): Promise<RemoteResult<IpcReadyReceipt>>
  append(connectionId: string, frame: IpcPcm16Frame): Promise<RemoteResult<IpcAppendReceipt>>
  commit(connectionId: string): Promise<RemoteResult<IpcControlReceipt>>
  stop(connectionId: string): Promise<RemoteResult<IpcControlReceipt>>
  events(connectionId: string, signal?: AbortSignal): AsyncIterable<IpcVoiceEvent>
}

interface GeneratedArtifacts {
  readonly host: TypertContribution
  readonly remote: TypertRemoteContribution
  readonly descriptors: readonly InvocationDescriptor[]
  readonly hostArtifactSha256: string
  readonly remoteArtifactSha256: string
}

interface TransportMetrics {
  unaryRequests: number
  streamOpens: number
  aborts: number
  requestBodyBytes: number
  responseBodyBytes: number
  streamItems: number
  streamOpenBytes: number
  maxPendingUnary: number
  maxPendingStreams: number
}

interface PendingUnary {
  readonly resolve: (response: Response) => void
  readonly reject: (reason: unknown) => void
  release?: () => void
}

type StreamFrame = Extract<TunnelOutboundFrame, { readonly t: 'stream-item' | 'stream-end' | 'stream-error' }>

class StreamInbox {
  private readonly frames: StreamFrame[] = []
  private queuedBytes = 0
  private wake: (() => void) | undefined
  private failure: unknown

  push(frame: StreamFrame): boolean {
    if (this.failure !== undefined) return false
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength
    if (this.frames.length >= MAX_STREAM_INBOX_ITEMS || this.queuedBytes + bytes > MAX_STREAM_INBOX_BYTES) {
      this.fail(new Error('synthetic IPC stream inbox limit reached'))
      return false
    }
    this.frames.push(frame)
    this.queuedBytes += bytes
    this.wake?.()
    this.wake = undefined
    return true
  }

  fail(reason: unknown): void {
    if (this.failure !== undefined) return
    this.failure = reason
    this.frames.length = 0
    this.queuedBytes = 0
    this.wake?.()
    this.wake = undefined
  }

  async next(): Promise<StreamFrame> {
    if (this.failure !== undefined) throw this.failure
    while (this.frames.length === 0) {
      if (this.failure !== undefined) throw this.failure
      await new Promise<void>(resolve => { this.wake = resolve })
    }
    const frame = this.frames.shift() as StreamFrame
    this.queuedBytes -= new TextEncoder().encode(JSON.stringify(frame)).byteLength
    return frame
  }
}

/**
 * Test-only bounded page adapter for the exact alpha TunnelServer frame
 * protocol. It normalizes absolute URLs before touching a real file://
 * Location and deliberately applies proof-only body, queue, error, abort, and
 * lifecycle policies. It is not the alpha WorkerTunnel or a drop-in carrier.
 */
class NullOriginMessagePortTransport {
  private nextId = 1
  private readonly unary = new Map<TunnelRequestId, PendingUnary>()
  private readonly streams = new Map<TunnelRequestId, StreamInbox>()
  private readonly streamEndpoints = new Map<TunnelRequestId, string>()
  readonly metrics: TransportMetrics = {
    unaryRequests: 0,
    streamOpens: 0,
    aborts: 0,
    requestBodyBytes: 0,
    responseBodyBytes: 0,
    streamItems: 0,
    streamOpenBytes: 0,
    maxPendingUnary: 0,
    maxPendingStreams: 0,
  }

  constructor(private readonly port: MessagePort) {
    port.addEventListener('message', event => { this.receive(event.data as TunnelOutboundFrame) })
    port.start()
  }

  readonly fetch = async (input: URL, init: RequestInit): Promise<Response> => {
    init.signal?.throwIfAborted()
    if (this.unary.size >= MAX_PENDING_UNARY) throw new Error('synthetic IPC unary queue limit reached')
    const id = this.nextId++
    const preflightBytes = requestBodyByteLength(init.body)
    if (preflightBytes > MAX_SYNTHETIC_RPC_BODY_BYTES) {
      throw new Error('synthetic IPC unary body limit reached')
    }
    const body = bodyBuffer(init.body)
    if ((body?.byteLength ?? 0) !== preflightBytes || preflightBytes > MAX_SYNTHETIC_RPC_BODY_BYTES) {
      throw new Error('synthetic IPC unary body limit reached')
    }
    const frame: TunnelInboundFrame = {
      t: 'req',
      id,
      method: init.method ?? 'GET',
      // `createWebConnectionRpc` already chose its null-origin internal base.
      // Normalizing that absolute URL here is the proposed shell-owned step.
      url: new URL(input.href).href,
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      ...(body === undefined ? {} : { body }),
    }
    const response = new Promise<Response>((resolve, reject) => {
      this.unary.set(id, { resolve, reject })
    })
    this.metrics.unaryRequests += 1
    this.metrics.requestBodyBytes += body?.byteLength ?? 0
    this.metrics.maxPendingUnary = Math.max(this.metrics.maxPendingUnary, this.unary.size)
    this.port.postMessage(frame, body === undefined ? [] : [body])
    if (init.signal === undefined || init.signal === null) return response
    const onAbort = (): void => {
      const pending = this.unary.get(id)
      if (pending === undefined) return
      this.unary.delete(id)
      this.metrics.aborts += 1
      this.port.postMessage({ t: 'abort', id } satisfies TunnelInboundFrame)
      pending.reject(init.signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError'))
    }
    init.signal.addEventListener('abort', onAbort, { once: true })
    const pending = this.unary.get(id)
    if (pending !== undefined) pending.release = () => { init.signal?.removeEventListener('abort', onAbort) }
    return response
  }

  readonly open = async function *(
    this: NullOriginMessagePortTransport,
    endpoint: string,
    payload: unknown,
    signal: AbortSignal,
  ): AsyncGenerator<unknown> {
    signal.throwIfAborted()
    if (this.streams.size >= MAX_PENDING_STREAMS) throw new Error('synthetic IPC stream queue limit reached')
    const id = this.nextId++
    const inbox = new StreamInbox()
    const streamOpenBytes = boundedJsonBytes({ endpoint, payload }, MAX_SYNTHETIC_RPC_BODY_BYTES)
    this.streams.set(id, inbox)
    this.streamEndpoints.set(id, endpoint)
    this.metrics.streamOpens += 1
    this.metrics.streamOpenBytes += streamOpenBytes
    this.metrics.maxPendingStreams = Math.max(this.metrics.maxPendingStreams, this.streams.size)
    const onAbort = (): void => { inbox.fail(signal.reason) }
    signal.addEventListener('abort', onAbort, { once: true })
    this.port.postMessage({ t: 'stream-open', id, endpoint, payload } satisfies TunnelInboundFrame)
    let terminal = false
    try {
      for (;;) {
        const frame = await inbox.next()
        signal.throwIfAborted()
        if (frame.t === 'stream-item') {
          this.metrics.streamItems += 1
          yield frame.value
          continue
        }
        terminal = true
        if (frame.t === 'stream-error') throw streamFailure(frame)
        return
      }
    } finally {
      signal.removeEventListener('abort', onAbort)
      this.streams.delete(id)
      this.streamEndpoints.delete(id)
      if (!terminal) {
        this.metrics.aborts += 1
        this.port.postMessage({ t: 'abort', id } satisfies TunnelInboundFrame)
      }
    }
  }

  close(): void {
    const reason = new Error('synthetic IPC transport closed')
    for (const pending of this.unary.values()) pending.reject(reason)
    for (const inbox of this.streams.values()) inbox.fail(reason)
    this.unary.clear()
    this.streams.clear()
    this.streamEndpoints.clear()
    this.port.close()
  }

  activeStreamCount(endpoint: string): number {
    let count = 0
    for (const activeEndpoint of this.streamEndpoints.values()) {
      if (activeEndpoint === endpoint) count += 1
    }
    return count
  }

  private receive(frame: TunnelOutboundFrame): void {
    if (frame.t === 'stream-item' || frame.t === 'stream-end' || frame.t === 'stream-error') {
      this.streams.get(frame.id)?.push(frame)
      return
    }
    const pending = this.unary.get(frame.id)
    if (pending === undefined) return
    if (frame.t === 'res-head' || frame.t === 'res-chunk' || frame.t === 'res-end') {
      pending.release?.()
      this.unary.delete(frame.id)
      pending.reject(new Error('synthetic IPC proof does not admit streamed unary responses'))
      return
    }
    pending.release?.()
    this.unary.delete(frame.id)
    if (frame.t === 'res-err') {
      pending.reject(new Error(`synthetic IPC host failure: ${frame.message}`))
      return
    }
    const body = frame.body
    this.metrics.responseBodyBytes += body?.byteLength ?? 0
    pending.resolve(new Response(body, { status: frame.status, headers: frame.headers }))
  }
}

function bodyBuffer(body: RequestInit['body']): ArrayBuffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return new TextEncoder().encode(body).buffer
  if (body instanceof ArrayBuffer) return body.slice(0)
  if (ArrayBuffer.isView(body)) return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
  throw new Error(`synthetic IPC proof refuses body type ${Object.prototype.toString.call(body)}`)
}

function requestBodyByteLength(body: RequestInit['body']): number {
  if (body === undefined || body === null) return 0
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return body.byteLength
  if (typeof body !== 'string') {
    throw new Error(`synthetic IPC proof refuses body type ${Object.prototype.toString.call(body)}`)
  }
  let bytes = 0
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index)
    if (code < 0x80) bytes += 1
    else if (code < 0x800) bytes += 2
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < body.length
      && body.charCodeAt(index + 1) >= 0xdc00 && body.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4
      index += 1
    } else bytes += 3
    if (bytes > MAX_SYNTHETIC_RPC_BODY_BYTES) return bytes
  }
  return bytes
}

function boundedJsonBytes(value: unknown, maxBytes: number): number {
  const seen = new Set<object>()
  let rawBudget = 0
  let nodes = 0
  const visit = (candidate: unknown, depth: number): void => {
    nodes += 1
    if (nodes > MAX_STREAM_OPEN_JSON_NODES || depth > MAX_STREAM_OPEN_JSON_DEPTH) {
      throw new Error('synthetic IPC stream-open payload complexity limit reached')
    }
    if (candidate === null || typeof candidate === 'boolean' || typeof candidate === 'number') {
      rawBudget += 8
    } else if (typeof candidate === 'string') {
      rawBudget += Math.min(requestBodyByteLength(candidate), maxBytes + 1)
    } else if (Array.isArray(candidate)) {
      if (seen.has(candidate)) throw new Error('synthetic IPC stream-open payload must be acyclic JSON')
      seen.add(candidate)
      rawBudget += candidate.length + 2
      for (const item of candidate) visit(item, depth + 1)
      seen.delete(candidate)
    } else if (typeof candidate === 'object' && candidate !== null
      && (Object.getPrototypeOf(candidate) === Object.prototype || Object.getPrototypeOf(candidate) === null)) {
      if (seen.has(candidate)) throw new Error('synthetic IPC stream-open payload must be acyclic JSON')
      seen.add(candidate)
      rawBudget += 2
      for (const [key, item] of Object.entries(candidate)) {
        rawBudget += requestBodyByteLength(key) + 1
        visit(item, depth + 1)
      }
      seen.delete(candidate)
    } else {
      throw new Error('synthetic IPC stream-open payload must be plain JSON')
    }
    if (rawBudget > maxBytes) throw new Error('synthetic IPC stream-open payload limit reached')
  }
  visit(value, 0)
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('synthetic IPC stream-open payload must be JSON')
  const bytes = requestBodyByteLength(encoded)
  if (bytes > maxBytes) throw new Error('synthetic IPC stream-open payload limit reached')
  return bytes
}

function streamFailure(frame: TunnelStreamErrorFrame): Error & { dshRemoteStreamFailure: object } {
  const error = new Error(frame.failure.message) as Error & { dshRemoteStreamFailure: object }
  error.name = 'SyntheticIpcStreamError'
  error.dshRemoteStreamFailure = frame.failure.kind === 'remote'
    ? { kind: 'remote', code: frame.failure.code, details: frame.failure.details }
    : { kind: 'carrier' }
  return error
}

class EventQueue {
  private readonly items: IpcVoiceEvent[] = []
  private queuedBytes = 0
  private wake: (() => void) | undefined
  private ended = false
  private failure: unknown

  push(event: IpcVoiceEvent): boolean {
    if (this.ended || this.failure !== undefined) return false
    const bytes = new TextEncoder().encode(JSON.stringify(event)).byteLength
    if (this.items.length >= MAX_EVENT_QUEUE_ITEMS || this.queuedBytes + bytes > MAX_EVENT_QUEUE_BYTES) {
      this.fail(remoteFailure('voice-output-queue-full', 'synthetic voice output queue limit reached'))
      return false
    }
    this.items.push(event)
    this.queuedBytes += bytes
    this.wake?.()
    this.wake = undefined
    return true
  }

  end(): void {
    this.ended = true
    this.wake?.()
    this.wake = undefined
  }

  fail(reason: unknown): void {
    if (this.ended || this.failure !== undefined) return
    this.failure = reason
    this.items.length = 0
    this.queuedBytes = 0
    this.wake?.()
    this.wake = undefined
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<IpcVoiceEvent> {
    const wake = (): void => { this.wake?.(); this.wake = undefined }
    signal.addEventListener('abort', wake, { once: true })
    try {
      for (;;) {
        signal.throwIfAborted()
        if (this.failure !== undefined) throw this.failure
        const item = this.items.shift()
        if (item !== undefined) {
          this.queuedBytes -= new TextEncoder().encode(JSON.stringify(item)).byteLength
          yield item
          continue
        }
        if (this.ended) return
        await new Promise<void>(resolve => { this.wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', wake)
    }
  }
}

class SyntheticProvider implements ManualTurnProviderSession {
  readonly authorization: ProviderAuthorization = { provider: 'qwen', model: 'qwen-synthetic-no-credential' }
  readonly closed: Promise<'local' | 'provider-closed' | 'protocol-error' | 'transport-error'>
  private readonly settle: (reason: 'local' | 'provider-closed' | 'protocol-error' | 'transport-error') => void
  private readonly listeners = new Set<(event: ManualTurnProviderEvent) => void>()
  private closedNow = false
  inputBytes = 0

  get isClosed(): boolean { return this.closedNow }

  constructor() {
    const state = Promise.withResolvers<'local' | 'provider-closed' | 'protocol-error' | 'transport-error'>()
    this.closed = state.promise
    this.settle = state.resolve
  }

  appendPcm16(chunk: Uint8Array): void { this.inputBytes += chunk.byteLength }

  commit(): void {
    const frames: readonly ManualTurnProviderEvent[] = [
      { type: 'transcript', role: 'user', text: 'synthetic input', final: true },
      { type: 'transcript', role: 'assistant', text: 'synthetic output', final: true },
      { type: 'audio', pcm24: new Uint8Array([1, 0, 2, 0]) },
      { type: 'done', status: 'completed' },
    ]
    for (const frame of frames) for (const listener of [...this.listeners]) listener(frame)
  }

  close(): void {
    if (this.closedNow) return
    this.closedNow = true
    this.listeners.clear()
    this.settle('local')
  }

  subscribe(listener: (event: ManualTurnProviderEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

interface ConnectionRecord {
  readonly sessionId: string
  readonly challenge: string
  readonly queue: EventQueue
  inputSequence: number
  inputBytes: number
  outputSequence: number
  outputBytes: number
  committed: boolean
}

class IpcVoiceProbeService extends Service {
  readonly typertRemote = bindTypertRemote(this, 'ipcVoiceProbe')
  readonly sessions: SessionStore
  readonly parentSession: Session
  readonly childSession: Session
  readonly workspaces = [{ id: 'workspace-synthetic', sessionIds: ['parent', 'child'] }]
  readonly manager: VoiceSessionManager
  readonly coordinator: ManualTurnCoordinator
  readonly records = new Map<string, ConnectionRecord>()
  readonly providers = new Map<string, SyntheticProvider>()
  private detachParent: () => void

  constructor(ctx: Context) {
    super(ctx, 'ipcVoiceProbe')
    this.sessions = ctx.sessions
    this.parentSession = this.sessions.prepare(SessionId('parent'))
    this.detachParent = this.sessions.enter(this.parentSession)
    this.sessions.announce(this.parentSession)
    this.childSession = this.sessions.fork(
      this.parentSession,
      undefined,
      SessionId('child'),
    )
    this.manager = new VoiceSessionManager(
      new AuthorityGuard(
        { get: sessionId => this.sessions.get(SessionId(sessionId)) },
        { list: () => this.workspaces },
      ),
      new ConsentChallenges(),
      async (_binding, signal) => {
        signal.throwIfAborted()
        return { provider: 'qwen', model: 'qwen-synthetic-no-credential' }
      },
    )
    this.coordinator = new ManualTurnCoordinator(this.manager, async (binding, _authorization, signal) => {
      signal.throwIfAborted()
      const provider = new SyntheticProvider()
      this.providers.set(binding.sessionId, provider)
      return provider
    })
    ctx.effect(() => () => { this.close() }, 'dsh-live-voice synthetic IPC probe')
  }

  async begin(sessionId: string): Promise<IpcConsentReceipt> {
    if (this.records.size >= MAX_ACTIVE_CONNECTIONS) {
      throw remoteFailure('voice-capacity', 'synthetic voice active-connection limit reached')
    }
    const connectionId = this.nextConnectionId()
    try {
      const begun = this.manager.begin(connectionId, sessionId)
      this.records.set(connectionId, {
        sessionId,
        challenge: begun.challenge,
        queue: new EventQueue(),
        inputSequence: 0,
        inputBytes: 0,
        outputSequence: 0,
        outputBytes: 0,
        committed: false,
      })
      return { connectionId, sessionId, workspaceId: begun.binding.workspaceId, challenge: begun.challenge, expiresAt: begun.expiresAt }
    } catch (error) {
      throw guardedFailure(error)
    }
  }

  async accept(connectionId: string, challenge: string): Promise<IpcReadyReceipt> {
    const record = this.record(connectionId)
    if (challenge !== record.challenge) {
      throw remoteFailure('consent-invalid', 'consent challenge belongs to a different connection capability')
    }
    try {
      const ready = await this.manager.acceptConsent(connectionId, challenge)
      const authorization = await this.coordinator.start(connectionId, {
        event: event => { this.receiveProviderEvent(connectionId, event) },
        failed: error => { this.failOutput(connectionId, error.code, error.message) },
      })
      return {
        connectionId,
        sessionId: ready.binding.sessionId,
        workspaceId: ready.binding.workspaceId,
        provider: authorization.provider,
        model: authorization.model,
      }
    } catch (error) {
      throw guardedFailure(error)
    }
  }

  async append(connectionId: string, frame: IpcPcm16Frame): Promise<IpcAppendReceipt> {
    const record = this.record(connectionId)
    if (record.committed) throw remoteFailure('voice-turn-committed', 'manual turn was already committed')
    if (!Number.isSafeInteger(frame.sequence) || frame.sequence !== record.inputSequence) {
      throw remoteFailure('voice-sequence-invalid', 'PCM input sequence is not the next expected value')
    }
    const chunk = decodePcmBase64(frame.pcm16Base64, MAX_INPUT_PCM16_CHUNK_BYTES, 'input')
    if (record.inputBytes + chunk.byteLength > MAX_INPUT_PCM16_TURN_BYTES) {
      throw remoteFailure('voice-turn-limit', 'PCM input exceeds the bounded manual turn')
    }
    try {
      this.coordinator.appendPcm16(connectionId, chunk)
    } catch (error) {
      const failure = guardedFailure(error)
      if (failure.failure.code === 'authority-changed') this.stopExact(connectionId)
      throw failure
    }
    record.inputSequence += 1
    record.inputBytes += chunk.byteLength
    return { acceptedBytes: chunk.byteLength, turnBytes: record.inputBytes, nextSequence: record.inputSequence }
  }

  async commit(connectionId: string): Promise<IpcControlReceipt> {
    const record = this.record(connectionId)
    if (record.committed) throw remoteFailure('voice-turn-committed', 'manual turn was already committed')
    if (record.inputBytes === 0) throw remoteFailure('voice-turn-empty', 'manual turn has no PCM input')
    try {
      record.committed = true
      this.coordinator.commit(connectionId)
      return { stopped: false }
    } catch (error) {
      record.committed = false
      const failure = guardedFailure(error)
      if (failure.failure.code === 'authority-changed') this.stopExact(connectionId)
      throw failure
    }
  }

  async stop(connectionId: string): Promise<IpcControlReceipt> {
    return { stopped: this.stopExact(connectionId) }
  }

  async *events(connectionId: string, signal: AbortSignal): AsyncGenerator<IpcVoiceEvent> {
    const record = this.record(connectionId)
    try {
      yield* record.queue.iterate(signal)
    } finally {
      if (signal.aborted) this.stopExact(connectionId)
    }
  }

  replaceParentSessionForTest(): Session {
    this.detachParent()
    const replacement = this.sessions.prepare(SessionId('parent'))
    const detach = this.sessions.enter(replacement)
    try {
      this.sessions.announce(replacement)
    } catch (error) {
      detach()
      throw error
    }
    this.detachParent = detach
    return replacement
  }

  emitAudioForTest(connectionId: string, pcm24: Uint8Array): boolean {
    this.receiveProviderEvent(connectionId, { type: 'audio', pcm24 })
    return this.records.has(connectionId)
  }

  emitTranscriptForTest(connectionId: string, text: string): boolean {
    this.receiveProviderEvent(connectionId, { type: 'transcript', role: 'assistant', text, final: true })
    return this.records.has(connectionId)
  }

  seedOutputBytesForTest(connectionId: string, bytes: number): void { this.record(connectionId).outputBytes = bytes }

  close(): void {
    for (const connectionId of [...this.records.keys()]) this.stopExact(connectionId)
    this.coordinator.close()
    this.detachParent()
  }

  private receiveProviderEvent(connectionId: string, event: ManualTurnProviderEvent): void {
    const record = this.records.get(connectionId)
    if (record === undefined) return
    if (event.type === 'audio') {
      if (event.pcm24.byteLength === 0
        || event.pcm24.byteLength % 2 !== 0
        || event.pcm24.byteLength > MAX_OUTPUT_PCM16_CHUNK_BYTES
        || record.outputBytes + event.pcm24.byteLength > MAX_OUTPUT_PCM16_TURN_BYTES) {
        this.failOutput(connectionId, 'voice-output-invalid', 'provider PCM output violates its byte boundary')
        return
      }
      const frame: IpcVoiceEvent = {
        sequence: record.outputSequence++,
        type: 'audio',
        pcm24Base64: Buffer.from(event.pcm24).toString('base64'),
      }
      record.outputBytes += event.pcm24.byteLength
      if (!record.queue.push(frame)) this.teardownAfterQueueFailure(connectionId, record)
      return
    }
    if (event.type === 'transcript') {
      if (event.text.length > MAX_VOICE_TRANSCRIPT_LENGTH) {
        this.failOutput(connectionId, 'voice-transcript-limit', 'provider transcript violates its length boundary')
        return
      }
      if (!record.queue.push({
        sequence: record.outputSequence++,
        type: 'transcript',
        role: event.role,
        text: event.text,
        final: event.final,
      })) this.teardownAfterQueueFailure(connectionId, record)
      return
    }
    if (!record.queue.push({ sequence: record.outputSequence++, type: 'done', status: event.status })) {
      this.teardownAfterQueueFailure(connectionId, record)
      return
    }
    record.queue.end()
  }

  private stopExact(connectionId: string): boolean {
    const record = this.records.get(connectionId)
    if (record === undefined) return false
    this.records.delete(connectionId)
    this.coordinator.stop(connectionId)
    this.manager.stop(connectionId)
    record.queue.end()
    this.providers.delete(record.sessionId)
    return true
  }

  private record(connectionId: string): ConnectionRecord {
    const record = this.records.get(connectionId)
    if (record === undefined) throw remoteFailure('voice-connection-missing', 'connection identity is not active')
    return record
  }

  private nextConnectionId(): string {
    let connectionId: string
    do {
      connectionId = `ipc_${randomBytes(CAPABILITY_BYTES).toString('base64url')}`
    } while (this.records.has(connectionId))
    return connectionId
  }

  private failOutput(connectionId: string, code: string, message: string): void {
    const record = this.records.get(connectionId)
    if (record === undefined) return
    record.queue.fail(remoteFailure(code, message))
    this.teardownAfterQueueFailure(connectionId, record)
  }

  private teardownAfterQueueFailure(connectionId: string, record: ConnectionRecord): void {
    if (this.records.get(connectionId) !== record) return
    this.records.delete(connectionId)
    this.coordinator.stop(connectionId)
    this.manager.stop(connectionId)
    this.providers.delete(record.sessionId)
  }
}

function decodePcmBase64(value: string, maxBytes: number, direction: string): Uint8Array {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4
  if (typeof value !== 'string' || value.length === 0) {
    throw remoteFailure('voice-base64-invalid', `${direction} PCM is not canonical base64`)
  }
  if (value.length > maxEncodedLength) {
    throw remoteFailure('voice-frame-invalid', `${direction} PCM frame violates its encoded byte boundary`)
  }
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw remoteFailure('voice-base64-invalid', `${direction} PCM is not canonical base64`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || bytes.byteLength === 0 || bytes.byteLength % 2 !== 0 || bytes.byteLength > maxBytes) {
    throw remoteFailure('voice-frame-invalid', `${direction} PCM frame violates its byte boundary`)
  }
  return new Uint8Array(bytes)
}

function remoteFailure(code: string, message: string): TypertRemoteFailure {
  return new TypertRemoteFailure({ code, message, details: {} })
}

function guardedFailure(error: unknown): TypertRemoteFailure {
  if (error instanceof TypertRemoteFailure) return error
  const guarded = asGuardedVoiceError(error)
  return remoteFailure(guarded.code, guarded.message)
}

interface Fixture {
  readonly host: Context
  readonly client: Context
  readonly service: IpcVoiceProbeService
  readonly remote: IpcRemote
  readonly transport: NullOriginMessagePortTransport
  activeHostStreamCount(endpoint: string): number
  dispose(): Promise<void>
}

let generated: GeneratedArtifacts
const fixtures: Fixture[] = []
const dependencyProvenance = process.env.DSH_LIVE_VOICE_DEPENDENCY_PROVENANCE ?? 'local-unverified'
const receipt = {
  exactAlphaCommit: process.env.DSH_LIVE_VOICE_EXPECTED_ALPHA_COMMIT ?? 'unknown',
  exactAlphaBuiltEntrypointsSha256:
    process.env.DSH_LIVE_VOICE_ALPHA_BUILT_ENTRYPOINTS_SHA256 ?? 'unknown',
  pluginRevision: process.env.DSH_LIVE_VOICE_REVISION ?? 'unknown',
  pluginDirty: process.env.DSH_LIVE_VOICE_PLUGIN_DIRTY === 'true',
  dependencyProvenance,
  publishable: process.env.DSH_LIVE_VOICE_PLUGIN_DIRTY !== 'true'
    && dependencyProvenance === 'fresh-frozen-lockfile',
  node: process.version,
  platform: process.platform,
  architecture: process.arch,
  generatedHostArtifactSha256: '',
  generatedRemoteArtifactSha256: '',
  credentialBackedProvider: false,
  liveProvider: false,
  physicalAudio: false,
  audibleLatency: false,
  electron: false,
  tauri: false,
  packagedDesktop: false,
  officialSeamConfirmation: false,
  workerTunnelNullOriginBlocked: false,
  streamCancellationAbortObserved: false,
  addressedVoiceStreamTeardownObserved: false,
  strictDescriptors: 0,
  maxEventQueueItems: MAX_EVENT_QUEUE_ITEMS,
  maxUnaryQueueItems: MAX_PENDING_UNARY,
  maxUnaryQueueBodyBytes: MAX_PENDING_UNARY * MAX_SYNTHETIC_RPC_BODY_BYTES,
  maxStreamOpenBodyBytes: MAX_SYNTHETIC_RPC_BODY_BYTES,
  maxStreamOpenJsonDepth: MAX_STREAM_OPEN_JSON_DEPTH,
  maxStreamOpenJsonNodes: MAX_STREAM_OPEN_JSON_NODES,
  maxStreamInboxItems: MAX_STREAM_INBOX_ITEMS,
  maxStreamInboxBytes: MAX_STREAM_INBOX_BYTES,
  globalFetchCalls: 0,
  webSocketConstructions: 0,
  sampleTurn: undefined as {
    readonly inputBytes: number
    readonly inputBase64Bytes: number
    readonly outputBytes: number
    readonly elapsedMs: number
    readonly transport: TransportMetrics
  } | undefined,
  sequentialBurst: undefined as {
    readonly frames: number
    readonly frameBytes: number
    readonly totalBytes: number
    readonly base64Bytes: number
    readonly base64Expansion: number
    readonly latencyMsP50: number
    readonly latencyMsP95: number
    readonly latencyMsMax: number
    readonly unaryRequests: number
    readonly requestBodyBytes: number
    readonly responseBodyBytes: number
    readonly maxUnaryInFlight: number
    readonly wallClockPaced: false
    readonly audible: false
  } | undefined,
}

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location')
const originalTransport = Object.getOwnPropertyDescriptor(globalThis, '__DSH_TRANSPORT__')
const originalFetch = globalThis.fetch
const originalWebSocket = globalThis.WebSocket
const forbiddenFetch = vi.fn(() => { throw new Error('global fetch is forbidden in the IPC-equivalent proof') })
const forbiddenWebSocket = vi.fn(() => { throw new Error('global WebSocket is forbidden in the IPC-equivalent proof') })

beforeAll(async () => {
  const leakedEnvironmentNames = Object.keys(process.env).filter(name =>
    /(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH|GITHUB|DASHSCOPE|QWEN|OPENAI|ANTHROPIC|AWS_|AZURE_)/iu.test(name),
  )
  expect(leakedEnvironmentNames).toEqual([])
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: {
      href: 'file:///synthetic/dsh/index.html',
      protocol: 'file:',
      origin: 'null',
      hostname: '',
      search: '',
    },
  })
  globalThis.fetch = forbiddenFetch as unknown as typeof fetch
  globalThis.WebSocket = forbiddenWebSocket as unknown as typeof WebSocket
  generated = await generateArtifacts()
})

afterEach(async () => {
  const failures: unknown[] = []
  for (const fixture of fixtures.splice(0).reverse()) {
    try {
      await fixture.dispose()
    } catch (error) {
      failures.push(error)
    }
  }
  Reflect.deleteProperty(globalThis, '__DSH_TRANSPORT__')
  if (failures.length > 0) throw new AggregateError(failures, 'synthetic IPC fixture disposal failed')
})

afterAll(() => {
  receipt.globalFetchCalls = forbiddenFetch.mock.calls.length
  receipt.webSocketConstructions = forbiddenWebSocket.mock.calls.length
  console.info(`DSH_LIVE_VOICE_ALPHA_IPC_RECEIPT=${JSON.stringify({
    claim: 'structured-clone IPC-equivalent Remote feasibility only; not packaged Desktop support',
    blocker: 'exact-alpha WorkerTunnel unary URL resolution rejects file:// null origin',
    ...receipt,
  })}`)
  restoreProperty('location', originalLocation)
  restoreProperty('__DSH_TRANSPORT__', originalTransport)
  globalThis.fetch = originalFetch
  globalThis.WebSocket = originalWebSocket
})

describe.sequential('DSH Live Voice exact-alpha IPC-equivalent feasibility', () => {
  it('characterizes the exact WorkerTunnel file/null-origin unary blocker', async () => {
    const sent: unknown[] = []
    const tunnel = new WorkerTunnel({
      addEventListener: () => {},
      postMessage: (frame: unknown) => { sent.push(frame) },
    } as unknown as Worker)

    await expect(tunnel.fetch(new URL('http://dsh.internal/api/ipcVoiceProbe/begin'), {
      method: 'POST', body: '{}',
    })).rejects.toThrow(/invalid url/iu)
    expect(sent).toEqual([])
    expect(globalThis.location.origin).toBe('null')
    receipt.workerTunnelNullOriginBlocked = true
  })

  it('carries one bounded turn through generated Remotes and preserves fork isolation', async () => {
    const started = performance.now()
    const fixture = await setup()
    expect(fixture.service.parentSession).not.toBe(fixture.service.childSession)
    expect(fixture.service.childSession.header.parentSession)
      .toBe(fixture.service.parentSession.id)
    expect(() => fixture.service.sessions.fork(
      fixture.service.parentSession,
      undefined,
      SessionId('parent'),
    )).toThrow(/already exists/iu)
    const parent = value(await fixture.remote.begin('parent'))
    const child = value(await fixture.remote.begin('child'))
    expect(parent.connectionId).not.toBe(child.connectionId)
    expect(await fixture.remote.accept('ipc_unissued-capability', parent.challenge))
      .toMatchObject({ ok: false, error: { code: 'voice-connection-missing' } })
    expect(await fixture.remote.accept(child.connectionId, parent.challenge))
      .toMatchObject({ ok: false, error: { code: 'consent-invalid' } })
    const parentReady = value(await fixture.remote.accept(parent.connectionId, parent.challenge))
    const childReady = value(await fixture.remote.accept(child.connectionId, child.challenge))
    expect(parentReady).toMatchObject({
      provider: 'qwen',
      model: 'qwen-synthetic-no-credential',
      sessionId: 'parent',
      workspaceId: 'workspace-synthetic',
    })
    expect(childReady).toMatchObject({
      provider: 'qwen',
      model: 'qwen-synthetic-no-credential',
      sessionId: 'child',
      workspaceId: 'workspace-synthetic',
    })

    const abort = new AbortController()
    const events = fixture.remote.events(child.connectionId, abort.signal)
    const collected = collect(events)

    const parentReplacement = fixture.service.replaceParentSessionForTest()
    expect(parentReplacement).not.toBe(fixture.service.parentSession)
    expect(fixture.service.sessions.get(SessionId('parent'))).toBe(parentReplacement)
    expect(fixture.service.sessions.get(SessionId('child'))).toBe(fixture.service.childSession)
    expect(() => fixture.service.sessions.fork(
      fixture.service.parentSession,
      undefined,
      SessionId('stale-parent-child'),
    )).toThrow(/not the live/iu)
    const staleParent = await fixture.remote.append(parent.connectionId, {
      sequence: 0,
      pcm16Base64: Buffer.from([1, 0]).toString('base64'),
    })
    expect(staleParent).toMatchObject({ ok: false, error: { code: 'authority-changed' } })
    expect(fixture.service.records.has(parent.connectionId)).toBe(false)
    expect(fixture.service.records.has(child.connectionId)).toBe(true)
    expect(fixture.service.manager.size).toBe(1)
    expect(fixture.service.coordinator.size).toBe(1)

    const childBytes = new Uint8Array([1, 0, 2, 0])
    const childBase64 = Buffer.from(childBytes).toString('base64')
    expect(value(await fixture.remote.append(child.connectionId, {
      sequence: 0,
      pcm16Base64: childBase64,
    }))).toEqual({ acceptedBytes: 4, turnBytes: 4, nextSequence: 1 })
    await fixture.remote.commit(child.connectionId).then(value)

    const frames = await collected
    expect(frames.map(frame => frame.sequence)).toEqual([0, 1, 2, 3])
    const audio = frames.find((frame): frame is Extract<IpcVoiceEvent, { type: 'audio' }> => frame.type === 'audio')
    expect(audio).toBeDefined()
    expect(Buffer.from(audio?.pcm24Base64 ?? '', 'base64')).toEqual(Buffer.from([1, 0, 2, 0]))
    expect(frames.at(-1)).toMatchObject({ type: 'done', status: 'completed' })

    expect(value(await fixture.remote.stop(parent.connectionId))).toEqual({ stopped: false })
    expect(value(await fixture.remote.stop(child.connectionId))).toEqual({ stopped: true })
    await vi.waitFor(() => {
      expect(fixture.service.records.size).toBe(0)
      expect(fixture.service.manager.size).toBe(0)
      expect(fixture.service.coordinator.size).toBe(0)
    })
    expect(forbiddenFetch).not.toHaveBeenCalled()
    expect(forbiddenWebSocket).not.toHaveBeenCalled()

    receipt.sampleTurn = {
      inputBytes: childBytes.byteLength,
      inputBase64Bytes: new TextEncoder().encode(childBase64).byteLength,
      outputBytes: Buffer.from(audio?.pcm24Base64 ?? '', 'base64').byteLength,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
      transport: { ...fixture.transport.metrics },
    }
  })

  it('enforces canonical base64, sequence, chunk, turn, and output queue bounds', async () => {
    const fixture = await setup()
    const begun = value(await fixture.remote.begin('child'))
    const connectionId = begun.connectionId
    await fixture.remote.accept(connectionId, begun.challenge).then(value)

    await expect(fixture.remote.append(connectionId, new Uint8Array([1, 0]) as never))
      .rejects.toThrow(/input|object|frame/iu)
    expect(await fixture.remote.append(connectionId, { sequence: 0, pcm16Base64: 'AQ' }))
      .toMatchObject({ ok: false, error: { code: 'voice-base64-invalid' } })
    expect(await fixture.remote.append(connectionId, {
      sequence: 1,
      pcm16Base64: Buffer.from([1, 0]).toString('base64'),
    })).toMatchObject({ ok: false, error: { code: 'voice-sequence-invalid' } })
    expect(await fixture.remote.append(connectionId, {
      sequence: 0,
      pcm16Base64: Buffer.alloc(MAX_INPUT_PCM16_CHUNK_BYTES + 2).toString('base64'),
    })).toMatchObject({ ok: false, error: { code: 'voice-frame-invalid' } })

    const fullChunk = Buffer.alloc(3_200)
    const latencies: number[] = []
    const burstUnaryStart = fixture.transport.metrics.unaryRequests
    const burstRequestBodyStart = fixture.transport.metrics.requestBodyBytes
    const burstResponseBodyStart = fixture.transport.metrics.responseBodyBytes
    let base64Bytes = 0
    let sequence = 0
    let sent = 0
    while (sent + fullChunk.byteLength <= MAX_INPUT_PCM16_TURN_BYTES) {
      const pcm16Base64 = fullChunk.toString('base64')
      const started = performance.now()
      const appended = value(await fixture.remote.append(connectionId, {
        sequence,
        pcm16Base64,
      }))
      latencies.push(performance.now() - started)
      base64Bytes += new TextEncoder().encode(pcm16Base64).byteLength
      sent = appended.turnBytes
      sequence = appended.nextSequence
    }
    const burstUnaryEnd = fixture.transport.metrics.unaryRequests
    const burstRequestBodyEnd = fixture.transport.metrics.requestBodyBytes
    const burstResponseBodyEnd = fixture.transport.metrics.responseBodyBytes
    expect(sent).toBe(MAX_INPUT_PCM16_TURN_BYTES)
    expect(sequence).toBe(300)
    expect(fixture.transport.metrics.maxPendingUnary).toBe(1)
    expect(await fixture.remote.append(connectionId, {
      sequence,
      pcm16Base64: Buffer.from([1, 0]).toString('base64'),
    })).toMatchObject({ ok: false, error: { code: 'voice-turn-limit' } })
    expect(value(await fixture.remote.commit(connectionId))).toEqual({ stopped: false })
    expect(await fixture.remote.append(connectionId, {
      sequence,
      pcm16Base64: Buffer.from([1, 0]).toString('base64'),
    })).toMatchObject({ ok: false, error: { code: 'voice-turn-committed' } })
    const sortedLatency = [...latencies].sort((left, right) => left - right)
    receipt.sequentialBurst = {
      frames: sequence,
      frameBytes: fullChunk.byteLength,
      totalBytes: sent,
      base64Bytes,
      base64Expansion: Math.round((base64Bytes / sent) * 100_000) / 100_000,
      latencyMsP50: percentile(sortedLatency, 0.5),
      latencyMsP95: percentile(sortedLatency, 0.95),
      latencyMsMax: rounded(sortedLatency.at(-1) ?? 0),
      unaryRequests: burstUnaryEnd - burstUnaryStart,
      requestBodyBytes: burstRequestBodyEnd - burstRequestBodyStart,
      responseBodyBytes: burstResponseBodyEnd - burstResponseBodyStart,
      maxUnaryInFlight: fixture.transport.metrics.maxPendingUnary,
      wallClockPaced: false,
      audible: false,
    }

    const overflow = await setup('connection-queue')
    const overflowBegin = value(await overflow.remote.begin('child'))
    const overflowId = overflowBegin.connectionId
    await overflow.remote.accept(overflowId, overflowBegin.challenge).then(value)
    let retained = true
    for (let index = 0; index <= MAX_EVENT_QUEUE_ITEMS; index += 1) {
      retained = overflow.service.emitAudioForTest(overflowId, new Uint8Array([index, 0]))
    }
    expect(retained).toBe(false)
    expect(overflow.service.records.has(overflowId)).toBe(false)
    expect(overflow.service.manager.size).toBe(0)
    expect(overflow.service.coordinator.size).toBe(0)
    expect(value(await overflow.remote.stop(overflowId))).toEqual({ stopped: false })
    expect(value(await fixture.remote.stop(connectionId))).toEqual({ stopped: true })
  })

  it('bounds Host capabilities and tears down every invalid provider-output path', async () => {
    const capacity = await setup()
    const active: string[] = []
    for (let index = 0; index < MAX_ACTIVE_CONNECTIONS; index += 1) {
      active.push(value(await capacity.remote.begin('child')).connectionId)
    }
    expect(await capacity.remote.begin('child')).toMatchObject({ ok: false, error: { code: 'voice-capacity' } })
    expect(capacity.service.records.size).toBe(MAX_ACTIVE_CONNECTIONS)
    for (const connectionId of active) expect(value(await capacity.remote.stop(connectionId))).toEqual({ stopped: true })

    const chunk = await readyFixture()
    expect(chunk.fixture.service.emitAudioForTest(
      chunk.connectionId,
      new Uint8Array(MAX_OUTPUT_PCM16_CHUNK_BYTES + 2),
    )).toBe(false)
    expectExactTeardown(chunk.fixture, chunk.connectionId)

    const turn = await readyFixture()
    turn.fixture.service.seedOutputBytesForTest(turn.connectionId, MAX_OUTPUT_PCM16_TURN_BYTES)
    expect(turn.fixture.service.emitAudioForTest(turn.connectionId, new Uint8Array([1, 0]))).toBe(false)
    expectExactTeardown(turn.fixture, turn.connectionId)

    const transcript = await readyFixture()
    expect(transcript.fixture.service.emitTranscriptForTest(
      transcript.connectionId,
      'x'.repeat(MAX_VOICE_TRANSCRIPT_LENGTH + 1),
    )).toBe(false)
    expectExactTeardown(transcript.fixture, transcript.connectionId)
  })

  it('bounds the isolated null-origin page adapter before enqueue', async () => {
    const unaryChannel = new MessageChannel()
    const unary = new NullOriginMessagePortTransport(unaryChannel.port1)
    await expect(unary.fetch(new URL('http://dsh.internal/api/probe'), {
      method: 'POST', body: 'x'.repeat(MAX_SYNTHETIC_RPC_BODY_BYTES + 1),
    })).rejects.toThrow(/body limit/iu)
    const pending = Array.from({ length: MAX_PENDING_UNARY }, () =>
      unary.fetch(new URL('http://dsh.internal/api/probe'), { method: 'POST', body: '{}' }))
    for (const operation of pending) void operation.catch(() => {})
    await expect(unary.fetch(new URL('http://dsh.internal/api/probe'), { method: 'POST', body: '{}' }))
      .rejects.toThrow(/unary queue limit/iu)
    expect(unary.metrics.maxPendingUnary).toBe(MAX_PENDING_UNARY)
    expect(MAX_PENDING_UNARY * MAX_SYNTHETIC_RPC_BODY_BYTES).toBe(768 * 1024)
    unary.close()
    unaryChannel.port2.close()
    await Promise.allSettled(pending)

    const streamChannel = new MessageChannel()
    const streams = new NullOriginMessagePortTransport(streamChannel.port1)
    const inboundFrames: TunnelInboundFrame[] = []
    streamChannel.port2.addEventListener('message', event => {
      inboundFrames.push(event.data as TunnelInboundFrame)
    })
    streamChannel.port2.start()
    const oversizedOpen = streams.open('ipcVoiceProbe/events', {
      args: { connectionId: 'x'.repeat(MAX_SYNTHETIC_RPC_BODY_BYTES + 1) },
    }, new AbortController().signal)[Symbol.asyncIterator]()
    await expect(oversizedOpen.next()).rejects.toThrow(/stream-open payload limit/iu)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(inboundFrames).toEqual([])
    expect(streams.metrics.streamOpens).toBe(0)
    expect(streams.metrics.maxPendingStreams).toBe(0)

    const opened = new Promise<TunnelRequestId>(resolve => {
      streamChannel.port2.addEventListener('message', event => {
        const frame = event.data as { readonly t?: string; readonly id?: TunnelRequestId }
        if (frame.t === 'stream-open' && frame.id !== undefined) resolve(frame.id)
      }, { once: true })
    })
    const endpoint = 'ipcVoiceProbe/events'
    const iterator = streams.open(endpoint, { args: { connectionId: 'synthetic' } }, new AbortController().signal)
      [Symbol.asyncIterator]()
    const first = iterator.next()
    const streamId = await opened
    streamChannel.port2.postMessage({
      t: 'stream-item',
      id: streamId,
      value: { sequence: 0 },
    } satisfies TunnelOutboundFrame)
    await expect(first).resolves.toEqual({ done: false, value: { sequence: 0 } })
    for (let index = 0; index < MAX_STREAM_INBOX_ITEMS; index += 1) {
      streamChannel.port2.postMessage({
        t: 'stream-item',
        id: streamId,
        value: { sequence: index + 1 },
      } satisfies TunnelOutboundFrame)
    }
    streamChannel.port2.postMessage({
      t: 'stream-item',
      id: streamId,
      value: { sequence: MAX_STREAM_INBOX_ITEMS + 1 },
    } satisfies TunnelOutboundFrame)
    streamChannel.port2.postMessage({
      t: 'stream-item',
      id: streamId,
      value: { sequence: MAX_STREAM_INBOX_ITEMS + 2, late: true },
    } satisfies TunnelOutboundFrame)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    await expect(iterator.next()).rejects.toThrow(/stream inbox limit/iu)
    expect(streams.metrics.aborts).toBe(1)
    expect(streams.activeStreamCount(endpoint)).toBe(0)
    streams.close()
    streamChannel.port2.close()
  })

  it('propagates stream cancellation and releases only the addressed voice state', async () => {
    const fixture = await setup()
    const parentBegun = value(await fixture.remote.begin('parent'))
    await fixture.remote.accept(parentBegun.connectionId, parentBegun.challenge).then(value)
    const parentProvider = fixture.service.providers.get('parent')
    expect(parentProvider).toBeDefined()
    const begun = value(await fixture.remote.begin('child'))
    const connectionId = begun.connectionId
    await fixture.remote.accept(connectionId, begun.challenge).then(value)
    const childProvider = fixture.service.providers.get('child')
    expect(childProvider).toBeDefined()
    if (parentProvider === undefined || childProvider === undefined) {
      throw new Error('synthetic providers were not retained for cancellation verification')
    }
    const abort = new AbortController()
    const iterator = fixture.remote.events(connectionId, abort.signal)[Symbol.asyncIterator]()
    const pending = iterator.next()
    await vi.waitFor(() => {
      expect(fixture.transport.activeStreamCount('ipcVoiceProbe/events')).toBe(1)
      expect(fixture.activeHostStreamCount('ipcVoiceProbe/events')).toBe(1)
    })
    const abortsBefore = fixture.transport.metrics.aborts
    const reason = new Error('synthetic caller cancelled')
    abort.abort(reason)
    await expect(pending).rejects.toThrow(/synthetic caller cancelled/iu)
    await expect(childProvider.closed).resolves.toBe('local')
    await vi.waitFor(() => {
      expect(fixture.service.records.has(connectionId)).toBe(false)
      expect(fixture.service.records.has(parentBegun.connectionId)).toBe(true)
      expect(fixture.service.manager.size).toBe(1)
      expect(fixture.service.coordinator.size).toBe(1)
      expect(fixture.service.providers.size).toBe(1)
      expect(fixture.service.providers.get('parent')).toBe(parentProvider)
      expect(fixture.transport.activeStreamCount('ipcVoiceProbe/events')).toBe(0)
      expect(fixture.activeHostStreamCount('ipcVoiceProbe/events')).toBe(0)
    })
    expect(fixture.transport.metrics.aborts - abortsBefore).toBe(1)
    expect(parentProvider.isClosed).toBe(false)
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(fixture.service.records.has(connectionId)).toBe(false)
    expect(fixture.transport.activeStreamCount('ipcVoiceProbe/events')).toBe(0)
    expect(fixture.activeHostStreamCount('ipcVoiceProbe/events')).toBe(0)
    expect(value(await fixture.remote.stop(parentBegun.connectionId))).toEqual({ stopped: true })
    await expect(parentProvider.closed).resolves.toBe('local')
    expect(fixture.service.records.size).toBe(0)
    expect(fixture.service.manager.size).toBe(0)
    expect(fixture.service.coordinator.size).toBe(0)
    expect(fixture.service.providers.size).toBe(0)
    expect(forbiddenFetch).not.toHaveBeenCalled()
    expect(forbiddenWebSocket).not.toHaveBeenCalled()
    receipt.streamCancellationAbortObserved = true
    receipt.addressedVoiceStreamTeardownObserved = true
  })
})

async function setup(_label = 'default'): Promise<Fixture> {
  const cleanup: Array<() => void | Promise<void>> = []
  const host = new Context()
  cleanup.push(() => host.fiber.dispose())
  try {
    await host.plugin(WebServer, { host: '127.0.0.1', port: 0 })
    provideBrowserCredentials(host)
    await host.plugin(TypertRegistry)
    await host.plugin(SessionStore)
    await host.plugin(TypertGatewayService, {})
    await host.plugin({ name: 'synthetic-host-connection', inject: hostConnectionInject, apply: applyHostConnection })
    const service = new IpcVoiceProbeService(host)
    cleanup.push(() => { service.close() })
    const disposeTypert = host.typert.register(generated.host)
    cleanup.push(() => disposeTypert())
    const disposeEvents = host.typertGateway.registerRemoteEvents(idleRemoteEvents, { home: '/synthetic/no-user-path' })
    cleanup.push(() => disposeEvents())

    const channel = new MessageChannel()
    cleanup.push(() => { channel.port1.close() })
    cleanup.push(() => { channel.port2.close() })
    const transport = new NullOriginMessagePortTransport(channel.port1)
    cleanup.push(() => { transport.close() })
    const server = new TunnelServer({
      port: { postMessage: (frame, transfer) => { channel.port2.postMessage(frame, transfer as readonly ArrayBuffer[]) } },
      requestListener: () => Promise.reject(new Error('synthetic proof has no route-lane listener')),
      unaryApiLane: 'direct',
    })
    channel.port2.addEventListener('message', event => { server.handleMessage(event.data) })
    channel.port2.start()
    const shared = host.connection.createSharedFetchHandler('/api')
    const activeHostStreams = new Map<string, number>()
    const openHostStream = host.typertGateway.wireStream.open.bind(host.typertGateway.wireStream)
    server.serve({
      directFetch: request => shared.fetch(request),
      bootPayload: () => ({ injections: [] }),
      openStream: async (endpoint, payload, signal) => {
        const source = await openHostStream(endpoint, payload, signal)
        return {
          async *[Symbol.asyncIterator]() {
            activeHostStreams.set(endpoint, (activeHostStreams.get(endpoint) ?? 0) + 1)
            try {
              yield* source
            } finally {
              const remaining = (activeHostStreams.get(endpoint) ?? 1) - 1
              if (remaining === 0) activeHostStreams.delete(endpoint)
              else activeHostStreams.set(endpoint, remaining)
            }
          },
        }
      },
      streamFailure: host.typertGateway.wireStream.failure,
    })

    const priorTransport = Object.getOwnPropertyDescriptor(globalThis, '__DSH_TRANSPORT__')
    Object.defineProperty(globalThis, '__DSH_TRANSPORT__', {
      configurable: true,
      value: {
        fetch: transport.fetch,
        openStream: (endpoint: string, payload: unknown, signal: AbortSignal) => transport.open(endpoint, payload, signal),
        ownsHost: true,
      },
    })
    cleanup.push(() => { restoreProperty('__DSH_TRANSPORT__', priorTransport) })

    const client = new Context()
    cleanup.push(() => client.fiber.dispose())
    await client.plugin(TypertRegistry)
    await client.plugin({ name: 'synthetic-client-connection', apply: applyClientConnection })
    await client.plugin({ name: 'synthetic-client-gateway', inject: clientGatewayInject, apply: applyClientGateway })
    const disposeRemote = await client.remote.$mount(generated.remote)
    cleanup.push(() => disposeRemote())
    await vi.waitFor(() => {
      const connection = client.get('connection') as ConnectionHandle
      expect(connection.generation.getSnapshot()).toBeDefined()
      expect(connection.isLoopback).toBe(true)
    })
    const remote = (client.remote as unknown as { readonly ipcVoiceProbe: IpcRemote }).ipcVoiceProbe
    let disposed = false
    const fixture: Fixture = {
      host,
      client,
      service,
      remote,
      transport,
      activeHostStreamCount: endpoint => activeHostStreams.get(endpoint) ?? 0,
      async dispose() {
        if (disposed) return
        disposed = true
        await settleCleanup(cleanup)
      },
    }
    fixtures.push(fixture)
    return fixture
  } catch (error) {
    await settleCleanup(cleanup, error)
    throw new Error('unreachable synthetic IPC setup branch')
  }
}

async function settleCleanup(
  cleanup: Array<() => void | Promise<void>>,
  primary?: unknown,
): Promise<void> {
  const failures: unknown[] = []
  for (const release of cleanup.splice(0).reverse()) {
    try {
      await release()
    } catch (error) {
      failures.push(error)
    }
  }
  if (primary !== undefined) {
    if (failures.length > 0) {
      throw new AggregateError([primary, ...failures], 'synthetic IPC setup failed and partial cleanup also failed')
    }
    throw primary
  }
  if (failures.length > 0) throw new AggregateError(failures, 'synthetic IPC fixture cleanup failed')
}

async function readyFixture(): Promise<{ readonly fixture: Fixture; readonly connectionId: string }> {
  const fixture = await setup()
  const begun = value(await fixture.remote.begin('child'))
  await fixture.remote.accept(begun.connectionId, begun.challenge).then(value)
  return { fixture, connectionId: begun.connectionId }
}

function expectExactTeardown(fixture: Fixture, connectionId: string): void {
  expect(fixture.service.records.has(connectionId)).toBe(false)
  expect(fixture.service.manager.size).toBe(0)
  expect(fixture.service.coordinator.size).toBe(0)
  expect(fixture.service.providers.size).toBe(0)
}

async function generateArtifacts(): Promise<GeneratedArtifacts> {
  const [artifact] = new WorkspaceTypertGenerator(FIXTURE_ROOT).generate(['@dsh-live-voice/ipc-probe'], ['host'])
  if (artifact === undefined || artifact.remote === undefined) throw new Error('IPC probe did not generate both Remote faces')
  const zod = JSON.stringify(import.meta.resolve('zod'))
  const hostSource = artifact.js.replace("from 'zod'", `from ${zod}`)
  const remoteSource = artifact.remote.js.replace("from 'zod'", `from ${zod}`)
  const hostArtifactSha256 = createHash('sha256').update(artifact.js).digest('hex')
  const remoteArtifactSha256 = createHash('sha256').update(artifact.remote.js).digest('hex')
  const hostModule = await import(`data:text/javascript,${encodeURIComponent(hostSource)}`) as { readonly TYPERT: TypertContribution }
  const remoteModule = await import(`data:text/javascript,${encodeURIComponent(remoteSource)}`) as { readonly TYPERT_REMOTE: TypertRemoteContribution }
  const descriptors = remoteModule.TYPERT_REMOTE.descriptors
  expect(descriptors).toHaveLength(6)
  for (const descriptor of descriptors) {
    expect(descriptor.parameters.every(parameter => parameter.codec.mode === 'strict')).toBe(true)
    expect(descriptor.result.mode).toBe('strict')
  }
  receipt.strictDescriptors = descriptors.length
  receipt.generatedHostArtifactSha256 = hostArtifactSha256
  receipt.generatedRemoteArtifactSha256 = remoteArtifactSha256
  return {
    host: hostModule.TYPERT,
    remote: remoteModule.TYPERT_REMOTE,
    descriptors,
    hostArtifactSha256,
    remoteArtifactSha256,
  }
}

async function* idleRemoteEvents(signal: AbortSignal): AsyncGenerator<never> {
  await new Promise<void>(resolve => {
    if (signal.aborted) resolve()
    else signal.addEventListener('abort', () => { resolve() }, { once: true })
  })
}

function provideBrowserCredentials(ctx: Context): void {
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  } as never)
}

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = []
  for await (const value of source) values.push(value)
  return values
}

function value<T>(result: RemoteResult<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
  return result.value
}

function restoreProperty(key: PropertyKey, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
  else Object.defineProperty(globalThis, key, descriptor)
}

function percentile(sorted: readonly number[], fraction: number): number {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))
  return rounded(sorted[index] ?? 0)
}

function rounded(value: number): number { return Math.round(value * 100) / 100 }
