import { CLIENT_BOOT_VERSION, parseGuardedVoiceClientBoot } from '../shared/boot.js'
import {
  MAX_INPUT_PCM16_CHUNK_BYTES,
  MAX_INPUT_PCM16_TURN_BYTES,
  MAX_OUTPUT_PCM16_CHUNK_BYTES,
  MAX_OUTPUT_PCM16_TURN_BYTES,
  MAX_VOICE_SOCKET_BUFFERED_BYTES,
} from '../shared/audio.js'
import { WIRE_VERSION, parseServerControl } from '../shared/wire.js'

export type VoiceClientPhase =
  | 'idle'
  | 'connecting'
  | 'awaiting-consent'
  | 'authorizing'
  | 'ready'
  | 'responding'
  | 'completed'
  | 'error'

export interface VoiceDisclosureView {
  readonly expiresAt: number
  readonly workspaceId: string
  readonly audioDestination: 'Alibaba Cloud Qwen realtime API'
  readonly exportedContext: 'none'
  readonly executionAuthority: 'none'
  readonly providerRetention: 'not specified for Qwen realtime audio'
  readonly currentMilestone: 'one bounded manual audio turn after acceptance'
}

export interface VoiceClientSnapshot {
  readonly phase: VoiceClientPhase
  readonly sessionId?: string
  readonly disclosure?: VoiceDisclosureView
  readonly model?: string
  readonly error?: string
  readonly userTranscript?: string
  readonly assistantTranscript?: string
  readonly userTranscriptFinal?: boolean
  readonly assistantTranscriptFinal?: boolean
  readonly turnStatus?: 'completed' | 'cancelled'
  /** Composer revision captured at the visible acceptance gesture. */
  readonly draftRevision?: number
}

interface VoiceSocket {
  readonly readyState: number
  readonly bufferedAmount: number
  binaryType?: BinaryType
  send(data: string | BufferSource): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open', listener: (event: Event) => void): void
  addEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  addEventListener(type: 'error', listener: (event: Event) => void): void
  addEventListener(type: 'close', listener: (event: CloseEvent) => void): void
  removeEventListener(type: 'open', listener: (event: Event) => void): void
  removeEventListener(type: 'message', listener: (event: MessageEvent<unknown>) => void): void
  removeEventListener(type: 'error', listener: (event: Event) => void): void
  removeEventListener(type: 'close', listener: (event: CloseEvent) => void): void
}

export interface VoiceAudioSink {
  /** Consume one bounded PCM16 mono/24 kHz provider chunk. */
  write(pcm24: Uint8Array): void
  /** Drop queued playback when the exact voice lifecycle stops or fails. */
  reset(): void
}

interface ActiveSocket {
  readonly socket: VoiceSocket
  readonly generation: number
  readonly sessionId: string
  readonly onOpen: (event: Event) => void
  readonly onMessage: (event: MessageEvent<unknown>) => void
  readonly onError: (event: Event) => void
  readonly onClose: (event: CloseEvent) => void
}

export interface VoiceClientControllerOptions {
  readonly route: string
  readonly location?: Pick<Location, 'href' | 'protocol'>
  readonly socketFactory?: (url: string) => VoiceSocket
  readonly now?: () => number
  readonly schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  readonly cancelScheduled?: (timer: ReturnType<typeof setTimeout>) => void
  readonly audioSink?: VoiceAudioSink
}

const IDLE: VoiceClientSnapshot = { phase: 'idle' }
const SOCKET_CONNECTING = 0
const SOCKET_OPEN = 1

/** Browser-side disclosure coordinator. Capture and default playback remain absent. */
export class VoiceClientController {
  private snapshot: VoiceClientSnapshot = IDLE
  private readonly listeners = new Set<() => void>()
  private readonly location: Pick<Location, 'href' | 'protocol'>
  private readonly route: string
  private readonly socketFactory: (url: string) => VoiceSocket
  private readonly now: () => number
  private readonly schedule: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  private readonly cancelScheduled: (timer: ReturnType<typeof setTimeout>) => void
  private active: ActiveSocket | undefined
  private challenge: string | undefined
  private consentTimer: ReturnType<typeof setTimeout> | undefined
  private generation = 0
  private disposed = false
  private readonly audioSink: VoiceAudioSink
  private inputBytes = 0
  private outputBytes = 0

  constructor(private readonly options: VoiceClientControllerOptions) {
    this.location = options.location ?? window.location
    this.route = parseGuardedVoiceClientBoot({ v: CLIENT_BOOT_VERSION, route: options.route }).route
    if (this.location.protocol !== 'http:' && this.location.protocol !== 'https:') {
      throw new TypeError('guarded voice requires an HTTP(S) page')
    }
    this.socketFactory = options.socketFactory ?? (url => new WebSocket(url))
    this.now = options.now ?? Date.now
    this.schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.cancelScheduled = options.cancelScheduled ?? (timer => { clearTimeout(timer) })
    this.audioSink = options.audioSink ?? { write: () => {}, reset: () => {} }
  }

  /** Return the identity-stable view until one lifecycle fact changes. */
  getSnapshot = (): VoiceClientSnapshot => this.snapshot

  /** Subscribe to browser-visible lifecycle changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Begin exact-session setup; only the later accept call can authorize the provider. */
  start(sessionId: string): void {
    if (this.disposed) return
    this.releaseActive(1000, 'replaced')
    this.resetTurn()
    const generation = ++this.generation
    let socket: VoiceSocket
    try {
      socket = this.socketFactory(this.socketUrl().toString())
    } catch (error) {
      this.fail(sessionId, error)
      return
    }
    const active: ActiveSocket = {
      socket,
      generation,
      sessionId,
      onOpen: () => { this.opened(active) },
      onMessage: event => { this.received(active, event) },
      onError: () => { this.failedSocket(active, 'voice websocket failed') },
      onClose: event => { this.closed(active, event) },
    }
    this.active = active
    socket.binaryType = 'arraybuffer'
    socket.addEventListener('open', active.onOpen)
    socket.addEventListener('message', active.onMessage)
    socket.addEventListener('error', active.onError)
    socket.addEventListener('close', active.onClose)
    this.publish({ phase: 'connecting', sessionId })
  }

  /** Append one bounded PCM16 mono/16 kHz chunk to this exact ready Session. */
  appendPcm16(sessionId: string, chunk: Uint8Array): void {
    const active = this.active
    if (this.disposed
      || this.snapshot.phase !== 'ready'
      || this.snapshot.sessionId !== sessionId
      || active?.sessionId !== sessionId
      || active.socket.readyState !== SOCKET_OPEN) return
    if (chunk.byteLength === 0
      || chunk.byteLength > MAX_INPUT_PCM16_CHUNK_BYTES
      || chunk.byteLength % 2 !== 0
      || this.inputBytes + chunk.byteLength > MAX_INPUT_PCM16_TURN_BYTES) {
      this.failedSocket(active, new Error('PCM16 input exceeds the manual-turn boundary'))
      return
    }
    if (active.socket.bufferedAmount + chunk.byteLength > MAX_VOICE_SOCKET_BUFFERED_BYTES) {
      this.failedSocket(active, new Error('voice websocket backpressure limit reached'))
      return
    }
    try {
      const owned = new Uint8Array(chunk)
      active.socket.send(owned)
      this.inputBytes += owned.byteLength
    } catch (error) {
      this.failedSocket(active, error)
    }
  }

  /** Commit the one manual turn. This operation can never submit the DSH composer. */
  commitTurn(sessionId: string): void {
    const active = this.active
    if (this.disposed
      || this.snapshot.phase !== 'ready'
      || this.snapshot.sessionId !== sessionId
      || active?.sessionId !== sessionId
      || active.socket.readyState !== SOCKET_OPEN
      || this.inputBytes === 0) return
    try {
      const commit = JSON.stringify({ v: WIRE_VERSION, type: 'turn.commit' })
      if (active.socket.bufferedAmount + commit.length > MAX_VOICE_SOCKET_BUFFERED_BYTES) {
        throw new Error('voice websocket backpressure limit reached')
      }
      active.socket.send(commit)
    } catch (error) {
      this.failedSocket(active, error)
      return
    }
    this.publish({
      ...this.snapshot,
      phase: 'responding',
      userTranscript: '',
      assistantTranscript: '',
      userTranscriptFinal: false,
      assistantTranscriptFinal: false,
    })
  }

  /** Consume the hidden one-shot challenge after the visible acceptance gesture. */
  accept(sessionId: string, draftRevision?: number): void {
    if (this.disposed
      || this.snapshot.phase !== 'awaiting-consent'
      || this.snapshot.sessionId !== sessionId
      || this.challenge === undefined
      || this.active?.sessionId !== sessionId
      || this.active.socket.readyState !== SOCKET_OPEN) return
    const disclosure = this.snapshot.disclosure
    const active = this.active
    if (disclosure === undefined || this.now() >= disclosure.expiresAt) {
      if (active !== undefined) this.failedSocket(active, new Error('disclosure acceptance expired'))
      return
    }
    const challenge = this.challenge
    this.challenge = undefined
    this.clearConsentTimer()
    try {
      active.socket.send(JSON.stringify({
        v: WIRE_VERSION,
        type: 'consent.accept',
        challenge,
      }))
    } catch (error) {
      this.failedSocket(active, error)
      return
    }
    this.publish({
      phase: 'authorizing',
      sessionId,
      disclosure,
      ...(draftRevision !== undefined && Number.isSafeInteger(draftRevision) && draftRevision >= 0
        ? { draftRevision }
        : {}),
    })
  }

  /** Stop only the addressed setup; a different mounted Session cannot cancel it. */
  stop(sessionId?: string): void {
    if (sessionId !== undefined && this.snapshot.sessionId !== sessionId) return
    const active = this.active
    if (active?.socket.readyState === SOCKET_OPEN) {
      try {
        active.socket.send(JSON.stringify({ v: WIRE_VERSION, type: 'stop' }))
      } catch {
        // Explicit cancellation still owns cleanup when the transport rejects its final frame.
      }
    }
    ++this.generation
    this.releaseActive(1000, 'stopped')
    this.resetTurn()
    this.publish(IDLE)
  }

  /** Release all browser resources and ignore every late socket callback. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.generation
    this.releaseActive(1000, 'plugin disposed')
    this.resetTurn()
    this.snapshot = IDLE
    this.listeners.clear()
  }

  private socketUrl(): URL {
    const url = new URL(this.route, this.location.href)
    url.protocol = this.location.protocol === 'https:' ? 'wss:' : 'ws:'
    url.username = ''
    url.password = ''
    return url
  }

  private opened(active: ActiveSocket): void {
    if (!this.isActive(active) || this.snapshot.phase !== 'connecting') return
    try {
      active.socket.send(JSON.stringify({
        v: WIRE_VERSION,
        type: 'bind',
        sessionId: active.sessionId,
      }))
    } catch (error) {
      this.failedSocket(active, error)
    }
  }

  private received(active: ActiveSocket, message: MessageEvent<unknown>): void {
    if (!this.isActive(active)) return
    if (typeof message.data !== 'string') {
      if (this.snapshot.phase !== 'responding' || !(message.data instanceof ArrayBuffer)) {
        this.failedSocket(active, 'voice websocket sent audio outside the active response')
        return
      }
      const pcm24 = new Uint8Array(message.data)
      if (pcm24.byteLength === 0
        || pcm24.byteLength > MAX_OUTPUT_PCM16_CHUNK_BYTES
        || pcm24.byteLength % 2 !== 0
        || this.outputBytes + pcm24.byteLength > MAX_OUTPUT_PCM16_TURN_BYTES) {
        this.failedSocket(active, 'voice websocket sent invalid PCM16 output')
        return
      }
      try {
        this.audioSink.write(new Uint8Array(pcm24))
        this.outputBytes += pcm24.byteLength
      } catch (error) {
        this.failedSocket(active, error)
      }
      return
    }
    try {
      const event = parseServerControl(message.data)
      if (event.type === 'consent.required') {
        const remainingMs = event.expiresAt - this.now()
        if (this.snapshot.phase !== 'connecting'
          || event.sessionId !== active.sessionId
          || remainingMs <= 0
          || remainingMs > 5 * 60_000) {
          throw new Error('voice disclosure does not match the active Session or has expired')
        }
        this.challenge = event.challenge
        const disclosure: VoiceDisclosureView = {
          expiresAt: event.expiresAt,
          workspaceId: event.workspaceId,
          ...event.disclosure,
        }
        this.consentTimer = this.schedule(() => {
          if (!this.isActive(active) || this.snapshot.phase !== 'awaiting-consent') return
          this.failedSocket(active, 'disclosure acceptance expired')
        }, remainingMs)
        this.publish({ phase: 'awaiting-consent', sessionId: active.sessionId, disclosure })
        return
      }
      if (event.type === 'ready') {
        const disclosure = this.snapshot.disclosure
        if (this.snapshot.phase !== 'authorizing'
          || disclosure === undefined
          || event.sessionId !== active.sessionId
          || event.workspaceId !== disclosure.workspaceId) {
          throw new Error('voice ready event does not match the accepted binding')
        }
        this.publish({
          phase: 'ready',
          sessionId: active.sessionId,
          disclosure,
          model: event.model,
          ...(this.snapshot.draftRevision === undefined
            ? {}
            : { draftRevision: this.snapshot.draftRevision }),
        })
        return
      }
      if (event.type === 'transcript') {
        if (this.snapshot.phase !== 'responding') {
          throw new Error('voice transcript arrived outside the active response')
        }
        this.publish(event.role === 'user'
          ? {
              ...this.snapshot,
              userTranscript: event.text,
              userTranscriptFinal: event.final,
            }
          : {
              ...this.snapshot,
              assistantTranscript: event.text,
              assistantTranscriptFinal: event.final,
            })
        return
      }
      if (event.type === 'turn.done') {
        if (this.snapshot.phase !== 'responding') {
          throw new Error('voice turn completed outside the active response')
        }
        this.publish({ ...this.snapshot, phase: 'completed', turnStatus: event.status })
        // The completed snapshot is sufficient for an explicit draft handoff.
        // Release the one-shot carrier immediately instead of retaining a
        // provider-free connection slot until the panel is dismissed.
        this.releaseRecord(active, true, 1000, 'turn complete')
        return
      }
      if (event.type === 'error') {
        this.failedSocket(active, `${event.code}: ${event.message}`)
        return
      }
      if (event.type === 'stopped') {
        throw new Error(`unexpected voice stopped event in phase ${this.snapshot.phase}`)
      }
      throw new Error(`unexpected voice event in phase ${this.snapshot.phase}`)
    } catch (error) {
      this.failedSocket(active, error)
    }
  }

  private failedSocket(active: ActiveSocket, error: unknown): void {
    if (!this.isActive(active)) return
    const sessionId = active.sessionId
    this.releaseRecord(active, true)
    this.fail(sessionId, error)
  }

  private closed(active: ActiveSocket, event: CloseEvent): void {
    if (!this.isActive(active)) return
    this.releaseRecord(active, false)
    const detail = event.reason === '' ? `code ${String(event.code)}` : event.reason
    this.fail(active.sessionId, new Error(`voice websocket closed unexpectedly (${detail})`))
  }

  private fail(sessionId: string, error: unknown): void {
    if (this.disposed) return
    const message = error instanceof Error ? error.message : String(error)
    this.resetTurn()
    this.publish({ phase: 'error', sessionId, error: message })
  }

  private resetTurn(): void {
    this.inputBytes = 0
    this.outputBytes = 0
    try { this.audioSink.reset() } catch {}
  }

  private isActive(active: ActiveSocket): boolean {
    return !this.disposed
      && this.active === active
      && active.generation === this.generation
  }

  private releaseActive(code: number, reason: string): void {
    const active = this.active
    if (active !== undefined) this.releaseRecord(active, true, code, reason)
    else this.clearConsentTimer()
  }

  private releaseRecord(active: ActiveSocket, close: boolean, code = 1008, reason = 'invalid voice state'): void {
    if (this.active !== active) return
    this.active = undefined
    this.challenge = undefined
    this.clearConsentTimer()
    active.socket.removeEventListener('open', active.onOpen)
    active.socket.removeEventListener('message', active.onMessage)
    active.socket.removeEventListener('error', active.onError)
    active.socket.removeEventListener('close', active.onClose)
    if (close && (active.socket.readyState === SOCKET_CONNECTING || active.socket.readyState === SOCKET_OPEN)) {
      try {
        active.socket.close(code, reason)
      } catch {
        // Ownership and listeners are already released; a throwing close cannot resurrect them.
      }
    }
  }

  private clearConsentTimer(): void {
    if (this.consentTimer === undefined) return
    this.cancelScheduled(this.consentTimer)
    this.consentTimer = undefined
  }

  private publish(snapshot: VoiceClientSnapshot): void {
    this.snapshot = snapshot
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (error) {
        console.error('guarded voice snapshot listener failed:', error)
      }
    }
  }
}
