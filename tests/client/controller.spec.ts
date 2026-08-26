import { describe, expect, it, vi } from 'vitest'
import { VoiceClientController } from '../../src/client/controller.js'

type SocketEventName = 'open' | 'message' | 'error' | 'close'
type SocketListener = (event: Event | MessageEvent<unknown> | CloseEvent) => void

class FakeSocket {
  readyState = 0
  readonly sent: string[] = []
  readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = []
  private readonly listeners = new Map<SocketEventName, Set<SocketListener>>()

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.closes.push({ ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) })
    this.readyState = 2
  }

  addEventListener(type: SocketEventName, listener: SocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set<SocketListener>()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: SocketEventName, listener: SocketListener): void {
    this.listeners.get(type)?.delete(listener)
  }

  open(): void {
    this.readyState = 1
    this.emit('open', new Event('open'))
  }

  message(data: unknown): void {
    this.emit('message', { data } as MessageEvent<unknown>)
  }

  fail(): void {
    this.emit('error', new Event('error'))
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = 3
    this.emit('close', { code, reason } as CloseEvent)
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0)
  }

  private emit(type: SocketEventName, event: Event | MessageEvent<unknown> | CloseEvent): void {
    for (const listener of [...this.listeners.get(type) ?? []]) listener(event)
  }
}

const CHALLENGE = 'a'.repeat(43)
const NOW = 1_900_000_000_000

function consentEvent(sessionId = 'session-1', workspaceId = 'workspace-1', expiresAt = NOW + 60_000): string {
  return JSON.stringify({
    v: 1,
    type: 'consent.required',
    challenge: CHALLENGE,
    expiresAt,
    sessionId,
    workspaceId,
    provider: 'qwen',
    disclosure: {
      audioDestination: 'Alibaba Cloud Qwen realtime API',
      exportedContext: 'none',
      executionAuthority: 'none',
      providerRetention: 'not specified for Qwen realtime audio',
      currentMilestone: 'no microphone access or audio transmission',
    },
  })
}

function readyEvent(sessionId = 'session-1', workspaceId = 'workspace-1'): string {
  return JSON.stringify({
    v: 1,
    type: 'ready',
    sessionId,
    workspaceId,
    provider: 'qwen',
    model: 'qwen-audio-3.0-realtime-plus',
    authority: 'proposal-only',
  })
}

function fixture(socket = new FakeSocket()) {
  let now = NOW
  let scheduled: { readonly callback: () => void; readonly delayMs: number } | undefined
  const timer = {} as ReturnType<typeof setTimeout>
  const cancelScheduled = vi.fn()
  const socketFactory = vi.fn((_url: string) => socket as unknown as WebSocket)
  const controller = new VoiceClientController({
    route: '/guarded-voice',
    location: { href: 'https://user:password@localhost:8443/chat', protocol: 'https:' },
    socketFactory,
    now: () => now,
    schedule: (callback, delayMs) => {
      scheduled = { callback, delayMs }
      return timer
    },
    cancelScheduled,
  })
  return {
    controller,
    socket,
    socketFactory,
    cancelScheduled,
    scheduled: () => scheduled,
    setNow(value: number) { now = value },
  }
}

describe('browser voice controller', () => {
  it('binds only after opening and keeps the bearer challenge out of its public snapshot', () => {
    const f = fixture()
    f.controller.start('session-1')
    expect(f.controller.getSnapshot()).toEqual({ phase: 'connecting', sessionId: 'session-1' })
    expect(f.socket.sent).toEqual([])
    expect(f.socketFactory).toHaveBeenCalledWith('wss://localhost:8443/guarded-voice')

    f.socket.open()
    expect(f.socket.sent.map(value => JSON.parse(value))).toEqual([{ v: 1, type: 'bind', sessionId: 'session-1' }])
    f.socket.message(consentEvent())
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: 'awaiting-consent',
      sessionId: 'session-1',
      disclosure: { workspaceId: 'workspace-1', expiresAt: NOW + 60_000 },
    })
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(CHALLENGE)
    expect(f.scheduled()?.delayMs).toBe(60_000)

    f.controller.accept('different-session')
    expect(f.socket.sent).toHaveLength(1)
    f.controller.accept('session-1')
    expect(f.socket.sent.map(value => JSON.parse(value))).toEqual([
      { v: 1, type: 'bind', sessionId: 'session-1' },
      { v: 1, type: 'consent.accept', challenge: CHALLENGE },
    ])
    expect(f.controller.getSnapshot().phase).toBe('authorizing')
    expect(JSON.stringify(f.controller.getSnapshot())).not.toContain(CHALLENGE)
    expect(f.cancelScheduled).toHaveBeenCalledTimes(1)

    f.controller.accept('session-1')
    expect(f.socket.sent).toHaveLength(2)
  })

  it('fails closed at the exact expiry boundary and closes the socket', () => {
    const f = fixture()
    f.controller.start('session-1')
    f.socket.open()
    f.socket.message(consentEvent())
    f.setNow(NOW + 60_000)
    f.controller.accept('session-1')
    expect(f.controller.getSnapshot()).toEqual({
      phase: 'error',
      sessionId: 'session-1',
      error: 'disclosure acceptance expired',
    })
    expect(f.socket.sent).toHaveLength(1)
    expect(f.socket.closes).toEqual([{ code: 1008, reason: 'invalid voice state' }])
    expect(f.socket.listenerCount()).toBe(0)
  })

  it('expires an untouched disclosure through the owned timer', () => {
    const f = fixture()
    f.controller.start('session-1')
    f.socket.open()
    f.socket.message(consentEvent())
    f.scheduled()?.callback()
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'error', error: 'disclosure acceptance expired' })
    expect(f.socket.closes).toHaveLength(1)
  })

  it.each([
    ['wrong session binding', consentEvent('session-2')],
    ['already-expired disclosure', consentEvent('session-1', 'workspace-1', NOW)],
    ['excessive disclosure lifetime', consentEvent('session-1', 'workspace-1', NOW + 300_001)],
    ['binary frame', new Uint8Array([1, 2, 3])],
  ])('rejects %s before acceptance', (_label, frame) => {
    const f = fixture()
    f.controller.start('session-1')
    f.socket.open()
    f.socket.message(frame)
    expect(f.controller.getSnapshot().phase).toBe('error')
    expect(f.socket.closes).toHaveLength(1)
    expect(f.socket.sent.map(value => JSON.parse(value))).toEqual([{ v: 1, type: 'bind', sessionId: 'session-1' }])
  })

  it('accepts ready only for the exact accepted session and workspace', () => {
    const f = fixture()
    f.controller.start('session-1')
    f.socket.open()
    f.socket.message(consentEvent())
    f.controller.accept('session-1')
    f.socket.message(readyEvent())
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: 'ready',
      sessionId: 'session-1',
      model: 'qwen-audio-3.0-realtime-plus',
      disclosure: { workspaceId: 'workspace-1' },
    })

    const mismatch = fixture()
    mismatch.controller.start('session-1')
    mismatch.socket.open()
    mismatch.socket.message(consentEvent())
    mismatch.controller.accept('session-1')
    mismatch.socket.message(readyEvent('session-1', 'workspace-2'))
    expect(mismatch.controller.getSnapshot()).toMatchObject({ phase: 'error' })
    expect(mismatch.socket.closes).toHaveLength(1)
  })

  it('stops only the addressed session and fences every late callback', () => {
    const f = fixture()
    f.controller.start('session-1')
    f.socket.open()
    f.controller.stop('session-2')
    expect(f.controller.getSnapshot().phase).toBe('connecting')
    expect(f.socket.closes).toEqual([])

    f.controller.stop('session-1')
    expect(f.socket.sent.map(value => JSON.parse(value))).toEqual([
      { v: 1, type: 'bind', sessionId: 'session-1' },
      { v: 1, type: 'stop' },
    ])
    expect(f.socket.closes).toEqual([{ code: 1000, reason: 'stopped' }])
    expect(f.controller.getSnapshot()).toEqual({ phase: 'idle' })
    f.socket.message(consentEvent())
    f.socket.serverClose(1008, 'late')
    expect(f.controller.getSnapshot()).toEqual({ phase: 'idle' })
  })

  it('replaces an old transport and ignores its detached events', () => {
    const first = new FakeSocket()
    const second = new FakeSocket()
    const sockets = [first, second]
    const controller = new VoiceClientController({
      route: '/guarded-voice',
      location: { href: 'http://localhost/', protocol: 'http:' },
      socketFactory: () => sockets.shift() as unknown as WebSocket,
      now: () => NOW,
    })
    controller.start('session-1')
    controller.start('session-2')
    expect(first.closes).toEqual([{ code: 1000, reason: 'replaced' }])
    first.open()
    first.message(consentEvent('session-1'))
    expect(controller.getSnapshot()).toEqual({ phase: 'connecting', sessionId: 'session-2' })
    second.open()
    expect(second.sent.map(value => JSON.parse(value))).toEqual([{ v: 1, type: 'bind', sessionId: 'session-2' }])
    controller.dispose()
  })

  it('contains reentrant stop and replacement calls from connecting observers', () => {
    const stopped = fixture()
    let stopOnce = true
    stopped.controller.subscribe(() => {
      if (stopOnce && stopped.controller.getSnapshot().phase === 'connecting') {
        stopOnce = false
        stopped.controller.stop('session-1')
      }
    })
    stopped.controller.start('session-1')
    expect(stopped.controller.getSnapshot()).toEqual({ phase: 'idle' })
    expect(stopped.socket.closes).toEqual([{ code: 1000, reason: 'stopped' }])
    expect(stopped.socket.listenerCount()).toBe(0)

    const first = new FakeSocket()
    const second = new FakeSocket()
    const sockets = [first, second]
    const controller = new VoiceClientController({
      route: '/guarded-voice',
      location: { href: 'http://localhost/', protocol: 'http:' },
      socketFactory: () => sockets.shift() as unknown as WebSocket,
      now: () => NOW,
    })
    let replaceOnce = true
    controller.subscribe(() => {
      const snapshot = controller.getSnapshot()
      if (replaceOnce && snapshot.phase === 'connecting' && snapshot.sessionId === 'session-1') {
        replaceOnce = false
        controller.start('session-2')
      }
    })
    controller.start('session-1')
    expect(first.closes).toEqual([{ code: 1000, reason: 'replaced' }])
    expect(first.listenerCount()).toBe(0)
    expect(controller.getSnapshot()).toEqual({ phase: 'connecting', sessionId: 'session-2' })
    first.open()
    expect(first.sent).toEqual([])
    second.open()
    expect(second.sent.map(value => JSON.parse(value))).toEqual([
      { v: 1, type: 'bind', sessionId: 'session-2' },
    ])
    controller.dispose()
  })

  it('surfaces server and transport failures without retaining resources', () => {
    const serverError = fixture()
    serverError.controller.start('session-1')
    serverError.socket.open()
    serverError.socket.message('{"v":1,"type":"error","code":"provider-unconfigured","message":"configuration missing"}')
    expect(serverError.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'provider-unconfigured: configuration missing',
    })
    expect(serverError.socket.listenerCount()).toBe(0)

    const close = fixture()
    close.controller.start('session-1')
    close.socket.serverClose(1006)
    expect(close.controller.getSnapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('code 1006') })

    const transport = fixture()
    transport.controller.start('session-1')
    transport.socket.fail()
    expect(transport.controller.getSnapshot()).toMatchObject({ phase: 'error', error: 'voice websocket failed' })
  })

  it('fails closed when bind or acceptance send throws, and cancellation still cleans up', () => {
    const bind = fixture()
    vi.spyOn(bind.socket, 'send').mockImplementation(() => { throw new Error('bind send failed') })
    bind.controller.start('session-1')
    bind.socket.open()
    expect(bind.controller.getSnapshot()).toMatchObject({ phase: 'error', error: 'bind send failed' })
    expect(bind.socket.closes).toEqual([{ code: 1008, reason: 'invalid voice state' }])
    expect(bind.socket.listenerCount()).toBe(0)

    const accept = fixture()
    accept.controller.start('session-1')
    accept.socket.open()
    accept.socket.message(consentEvent())
    vi.spyOn(accept.socket, 'send').mockImplementation(() => { throw new Error('accept send failed') })
    accept.controller.accept('session-1')
    expect(accept.controller.getSnapshot()).toMatchObject({ phase: 'error', error: 'accept send failed' })
    expect(accept.socket.closes).toEqual([{ code: 1008, reason: 'invalid voice state' }])
    expect(accept.socket.listenerCount()).toBe(0)

    const stop = fixture()
    stop.controller.start('session-1')
    stop.socket.open()
    vi.spyOn(stop.socket, 'send').mockImplementation(() => { throw new Error('stop send failed') })
    expect(() => { stop.controller.stop('session-1') }).not.toThrow()
    expect(stop.controller.getSnapshot()).toEqual({ phase: 'idle' })
    expect(stop.socket.closes).toEqual([{ code: 1000, reason: 'stopped' }])
    expect(stop.socket.listenerCount()).toBe(0)
  })

  it.each(['connecting', 'awaiting-consent', 'authorizing', 'ready'] as const)(
    'rejects an unsolicited Host stopped event while %s and closes the transport',
    phase => {
      const f = fixture()
      f.controller.start('session-1')
      if (phase !== 'connecting') {
        f.socket.open()
        f.socket.message(consentEvent())
      }
      if (phase === 'authorizing' || phase === 'ready') f.controller.accept('session-1')
      if (phase === 'ready') f.socket.message(readyEvent())
      expect(f.controller.getSnapshot().phase).toBe(phase)

      f.socket.message('{"v":1,"type":"stopped"}')
      expect(f.controller.getSnapshot()).toMatchObject({
        phase: 'error',
        sessionId: 'session-1',
        error: `unexpected voice stopped event in phase ${phase}`,
      })
      expect(f.socket.closes).toEqual([{ code: 1008, reason: 'invalid voice state' }])
      expect(f.socket.listenerCount()).toBe(0)
    },
  )

  it('contains a broken observer so other lifecycle subscribers still run', () => {
    const f = fixture()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const healthy = vi.fn()
    f.controller.subscribe(() => { throw new Error('observer failed') })
    f.controller.subscribe(healthy)
    f.controller.start('session-1')
    expect(logged).toHaveBeenCalledWith(
      'guarded voice snapshot listener failed:',
      expect.objectContaining({ message: 'observer failed' }),
    )
    expect(healthy).toHaveBeenCalledTimes(1)
    logged.mockRestore()
    f.controller.dispose()
  })

  it('handles socket construction failure and rejects unsafe construction inputs', () => {
    const broken = new VoiceClientController({
      route: '/guarded-voice',
      location: { href: 'http://localhost/', protocol: 'http:' },
      socketFactory: () => { throw new Error('constructor failed') },
    })
    broken.start('session-1')
    expect(broken.getSnapshot()).toEqual({ phase: 'error', sessionId: 'session-1', error: 'constructor failed' })

    expect(() => new VoiceClientController({
      route: '//remote.example/voice',
      location: { href: 'http://localhost/', protocol: 'http:' },
    })).toThrow(/bootstrap/u)
    expect(() => new VoiceClientController({
      route: '/guarded-voice',
      location: { href: 'file:///tmp/index.html', protocol: 'file:' },
    })).toThrow(/HTTP\(S\)/u)
  })

  it('disposes the active socket, timer, and subscriptions exactly once', () => {
    const f = fixture()
    const listener = vi.fn()
    const unsubscribe = f.controller.subscribe(listener)
    f.controller.start('session-1')
    f.socket.open()
    f.socket.message(consentEvent())
    expect(listener).toHaveBeenCalledTimes(2)
    f.controller.dispose()
    f.controller.dispose()
    expect(f.socket.closes).toEqual([{ code: 1000, reason: 'plugin disposed' }])
    expect(f.cancelScheduled).toHaveBeenCalledTimes(1)
    expect(f.socket.listenerCount()).toBe(0)
    f.socket.message(readyEvent())
    expect(f.controller.getSnapshot()).toEqual({ phase: 'idle' })
    unsubscribe()
  })
})
