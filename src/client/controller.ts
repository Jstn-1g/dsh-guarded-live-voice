import { CLIENT_BOOT_VERSION, parseGuardedVoiceClientBoot } from '../shared/boot.js'
import { WIRE_VERSION, parseServerControl } from '../shared/wire.js'

export type VoiceClientPhase =
  | 'idle'
  | 'connecting'
  | 'awaiting-consent'
  | 'authorizing'
  | 'ready'
  | 'error'

export interface VoiceDisclosureView {
  readonly expiresAt: number
  readonly workspaceId: string
  readonly audioDestination: 'Alibaba Cloud Qwen realtime API'
  readonly exportedContext: 'none'
  readonly executionAuthority: 'none'
  readonly providerRetention: 'not specified for Qwen realtime audio'
  readonly currentMilestone: 'no microphone access or audio transmission'
}

export interface VoiceClientSnapshot {
  readonly phase: VoiceClientPhase
  readonly sessionId?: string
  readonly disclosure?: VoiceDisclosureView
  readonly model?: string
  readonly error?: string
}

interface VoiceSocket {
  readonly readyState: number
  send(data: string): void
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
}

const IDLE: VoiceClientSnapshot = { phase: 'idle' }
const SOCKET_CONNECTING = 0
const SOCKET_OPEN = 1

/** Browser-side disclosure and setup coordinator. Microphone and audio remain absent. */
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
    socket.addEventListener('open', active.onOpen)
    socket.addEventListener('message', active.onMessage)
    socket.addEventListener('error', active.onError)
    socket.addEventListener('close', active.onClose)
    this.publish({ phase: 'connecting', sessionId })
  }

  /** Consume the hidden one-shot challenge after the visible acceptance gesture. */
  accept(sessionId: string): void {
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
    this.publish({ phase: 'authorizing', sessionId, disclosure })
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
    this.publish(IDLE)
  }

  /** Release all browser resources and ignore every late socket callback. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ++this.generation
    this.releaseActive(1000, 'plugin disposed')
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
      this.failedSocket(active, 'voice websocket sent a binary frame before audio was enabled')
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
        })
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
    this.publish({ phase: 'error', sessionId, error: message })
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
