import { describe, expect, it, vi } from 'vitest'
import {
  VoiceClientController,
  type VoiceAudioCaptureFactory,
  type VoiceAudioCaptureHandlers,
} from '../../src/client/controller.js'

type SocketEventName = 'open' | 'message' | 'error' | 'close'
type SocketListener = (event: Event | MessageEvent<unknown> | CloseEvent) => void

class FakeSocket {
  readyState = 0
  bufferedAmount = 0
  binaryType: BinaryType = 'blob'
  readonly sent: string[] = []
  readonly binary: Uint8Array[] = []
  readonly closes: Array<{ readonly code?: number; readonly reason?: string }> = []
  private readonly listeners = new Map<SocketEventName, Set<SocketListener>>()

  send(data: string | BufferSource): void {
    if (typeof data === 'string') this.sent.push(data)
    else if (data instanceof ArrayBuffer) this.binary.push(new Uint8Array(data))
    else this.binary.push(new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)))
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && code !== 1000 && (code < 3000 || code > 4999)) {
      throw new DOMException('invalid browser WebSocket close code', 'InvalidAccessError')
    }
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
      currentMilestone: 'one bounded manual audio turn after acceptance',
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

function fixture(socket = new FakeSocket(), captureFactory?: VoiceAudioCaptureFactory) {
  let now = NOW
  let scheduled: { readonly callback: () => void; readonly delayMs: number } | undefined
  const timer = {} as ReturnType<typeof setTimeout>
  const cancelScheduled = vi.fn()
  const audioSink = { prepare: vi.fn(() => Promise.resolve()), write: vi.fn(), reset: vi.fn() }
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
    audioSink,
    ...(captureFactory === undefined ? {} : { captureFactory }),
  })
  return {
    controller,
    socket,
    socketFactory,
    cancelScheduled,
    audioSink,
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
    expect(f.socket.closes).toEqual([{ code: 4000, reason: 'invalid voice state' }])
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

  it('relays one exact-session bounded PCM turn and accepts only ordered streamed output', () => {
    const f = fixture()
    const composerIdentity = {}
    const sameIdReplacementIdentity = {}
    f.controller.start('session-1')
    expect(f.socket.binaryType).toBe('arraybuffer')
    f.socket.open()
    f.socket.message(consentEvent())
    f.controller.accept('session-1', 9, composerIdentity)
    f.socket.message(readyEvent())
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'ready', draftRevision: 9 })

    f.controller.appendPcm16('other-session', new Uint8Array([1, 0]))
    expect(f.socket.binary).toEqual([])
    const pcm = new Uint8Array([1, 0, 2, 0])
    f.controller.appendPcm16('session-1', pcm)
    pcm.fill(9)
    expect(f.socket.binary).toEqual([new Uint8Array([1, 0, 2, 0])])
    f.controller.commitTurn('other-session')
    expect(f.controller.getSnapshot().phase).toBe('ready')
    f.controller.commitTurn('session-1')
    expect(JSON.parse(f.socket.sent.at(-1) ?? '')).toEqual({ v: 1, type: 'turn.commit' })
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'responding', draftRevision: 9 })

    f.socket.message(JSON.stringify({
      v: 1, type: 'transcript', role: 'user', text: 'hello', final: true,
    }))
    f.socket.message(JSON.stringify({
      v: 1, type: 'transcript', role: 'assistant', text: 'answer', final: true,
    }))
    const audio = new Uint8Array([3, 0, 4, 0])
    f.socket.message(audio.buffer)
    expect(f.audioSink.write).toHaveBeenCalledWith(new Uint8Array([3, 0, 4, 0]))
    f.socket.message(JSON.stringify({ v: 1, type: 'turn.done', status: 'completed' }))
    expect(f.controller.getSnapshot()).toMatchObject({
      phase: 'completed',
      turnStatus: 'completed',
      userTranscript: 'hello',
      userTranscriptFinal: true,
      assistantTranscript: 'answer',
      assistantTranscriptFinal: true,
      draftRevision: 9,
    })
    expect(f.socket.closes).toEqual([{ code: 1000, reason: 'turn complete' }])
    expect(f.controller.isComposerBindingCurrent('session-1', sameIdReplacementIdentity)).toBe(false)
    expect(f.controller.claimDraftHandoff('session-1', sameIdReplacementIdentity, 9)).toBe(false)
    expect(f.controller.isComposerBindingCurrent('session-1', composerIdentity)).toBe(true)
    expect(f.controller.claimDraftHandoff('session-1', composerIdentity, 8)).toBe(false)
    expect(f.controller.claimDraftHandoff('session-1', composerIdentity, 9)).toBe(true)
    expect(f.controller.claimDraftHandoff('session-1', composerIdentity, 9)).toBe(false)
    f.controller.appendPcm16('session-1', new Uint8Array([5, 0]))
    expect(f.socket.binary).toHaveLength(1)
    f.controller.stop('session-1')
    expect(f.audioSink.reset).toHaveBeenCalled()
  })

  it('prepares capture from an explicit gesture, relays owned PCM, and commits only on finish', async () => {
    let handlers: VoiceAudioCaptureHandlers | undefined
    const capture = {
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn((flush?: boolean) => {
        if (flush === true) handlers?.onChunk(new Uint8Array([3, 0]))
      }),
    }
    const f = fixture(new FakeSocket(), callbacks => {
      handlers = callbacks
      return capture
    })
    f.controller.start('session-1')
    f.socket.open()
    f.socket.message(consentEvent())
    f.controller.accept('session-1', 3)
    f.socket.message(readyEvent())

    f.controller.beginCapture('other-session')
    expect(capture.start).not.toHaveBeenCalled()
    f.controller.beginCapture('session-1')
    expect(f.controller.getSnapshot().phase).toBe('preparing-audio')
    expect(f.audioSink.prepare).toHaveBeenCalledTimes(1)
    await vi.waitFor(() => { expect(f.controller.getSnapshot().phase).toBe('recording') })

    handlers?.onChunk(new Uint8Array([1, 0, 2, 0]))
    expect(f.socket.binary).toEqual([new Uint8Array([1, 0, 2, 0])])
    expect(f.socket.sent.some(frame => frame.includes('turn.commit'))).toBe(false)
    f.controller.finishCapture('other-session')
    expect(capture.stop).not.toHaveBeenCalled()
    f.controller.finishCapture('session-1')
    expect(capture.stop).toHaveBeenCalledWith(true)
    expect(f.socket.binary).toEqual([
      new Uint8Array([1, 0, 2, 0]),
      new Uint8Array([3, 0]),
    ])
    expect(JSON.parse(f.socket.sent.at(-1) ?? '')).toEqual({ v: 1, type: 'turn.commit' })
    expect(f.controller.getSnapshot()).toMatchObject({ phase: 'responding', draftRevision: 3 })

    const binaryCount = f.socket.binary.length
    handlers?.onChunk(new Uint8Array([4, 0]))
    handlers?.onLimit()
    expect(f.socket.binary).toHaveLength(binaryCount)
    expect(f.socket.sent.filter(frame => frame.includes('turn.commit'))).toHaveLength(1)
  })

  it('fails the exact lifecycle on permission denial and auto-commits only at the hard capture cap', async () => {
    const deniedCapture = {
      start: vi.fn(() => Promise.reject(new Error('microphone permission was denied'))),
      stop: vi.fn(),
    }
    const denied = fixture(new FakeSocket(), () => deniedCapture)
    denied.controller.start('session-1')
    denied.socket.open()
    denied.socket.message(consentEvent())
    denied.controller.accept('session-1')
    denied.socket.message(readyEvent())
    denied.controller.beginCapture('session-1')
    await vi.waitFor(() => {
      expect(denied.controller.getSnapshot()).toMatchObject({
        phase: 'error',
        error: 'microphone permission was denied',
      })
    })
    expect(deniedCapture.stop).toHaveBeenCalledWith(false)
    expect(denied.socket.closes).toEqual([{ code: 4000, reason: 'invalid voice state' }])
    expect(denied.socket.listenerCount()).toBe(0)
    expect(() => { denied.controller.start('session-2') }).not.toThrow()
    expect(denied.controller.getSnapshot()).toEqual({ phase: 'connecting', sessionId: 'session-2' })
    expect(denied.socketFactory).toHaveBeenCalledTimes(2)
    expect(denied.socket.closes).toHaveLength(1)

    let handlers: VoiceAudioCaptureHandlers | undefined
    const capped = fixture(new FakeSocket(), callbacks => {
      handlers = callbacks
      return { start: () => Promise.resolve(), stop: vi.fn() }
    })
    capped.controller.start('session-1')
    capped.socket.open()
    capped.socket.message(consentEvent())
    capped.controller.accept('session-1')
    capped.socket.message(readyEvent())
    capped.controller.beginCapture('session-1')
    await vi.waitFor(() => { expect(capped.controller.getSnapshot().phase).toBe('recording') })
    handlers?.onChunk(new Uint8Array([1, 0]))
    handlers?.onLimit()
    handlers?.onLimit()
    expect(JSON.parse(capped.socket.sent.at(-1) ?? '')).toEqual({ v: 1, type: 'turn.commit' })
    expect(capped.socket.sent.filter(frame => frame.includes('turn.commit'))).toHaveLength(1)
    expect(capped.controller.getSnapshot().phase).toBe('responding')
  })

  it('fails closed on malformed or out-of-phase manual audio', () => {
    const odd = fixture()
    odd.controller.start('session-1')
    odd.socket.open()
    odd.socket.message(consentEvent())
    odd.controller.accept('session-1')
    odd.socket.message(readyEvent())
    odd.controller.appendPcm16('session-1', new Uint8Array([1]))
    expect(odd.controller.getSnapshot()).toMatchObject({ phase: 'error', error: expect.stringContaining('PCM16') })

    const earlyOutput = fixture()
    earlyOutput.controller.start('session-1')
    earlyOutput.socket.open()
    earlyOutput.socket.message(consentEvent())
    earlyOutput.controller.accept('session-1')
    earlyOutput.socket.message(readyEvent())
    earlyOutput.socket.message(new Uint8Array([1, 0]).buffer)
    expect(earlyOutput.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'voice websocket sent audio outside the active response',
    })

    const congested = fixture()
    congested.controller.start('session-1')
    congested.socket.open()
    congested.socket.message(consentEvent())
    congested.controller.accept('session-1')
    congested.socket.message(readyEvent())
    congested.socket.bufferedAmount = 512 * 1024
    congested.controller.appendPcm16('session-1', new Uint8Array([1, 0]))
    expect(congested.controller.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'voice websocket backpressure limit reached',
    })
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

  it('tears down a parent only after its last seat leaves during a fork-child switch', async () => {
    let handlers: VoiceAudioCaptureHandlers | undefined
    const capture = {
      start: vi.fn(() => Promise.resolve()),
      stop: vi.fn(),
    }
    const f = fixture(new FakeSocket(), callbacks => {
      handlers = callbacks
      return capture
    })
    const releaseParentControl = f.controller.mountSession('parent')
    const releaseParentPanel = f.controller.mountSession('parent')
    const releaseChildControl = f.controller.mountSession('child')
    const releaseChildPanel = f.controller.mountSession('child')
    f.controller.start('parent')
    f.socket.open()
    f.socket.message(consentEvent('parent'))
    f.controller.accept('parent')
    f.socket.message(readyEvent('parent'))
    f.controller.beginCapture('parent')
    await vi.waitFor(() => { expect(f.controller.getSnapshot().phase).toBe('recording') })
    handlers?.onChunk(new Uint8Array([1, 0]))

    releaseParentControl()
    expect(f.controller.getSnapshot().phase).toBe('recording')
    expect(capture.stop).not.toHaveBeenCalled()
    expect(f.socket.closes).toEqual([])

    releaseParentPanel()
    await Promise.resolve()
    expect(f.controller.getSnapshot()).toEqual({ phase: 'idle' })
    expect(capture.stop).toHaveBeenCalledOnce()
    expect(capture.stop).toHaveBeenCalledWith(false)
    expect(f.socket.sent.map(value => JSON.parse(value)).at(-1)).toEqual({ v: 1, type: 'stop' })
    expect(f.socket.closes).toEqual([{ code: 1000, reason: 'stopped' }])
    expect(f.socket.listenerCount()).toBe(0)
    const binaryFramesAfterCleanup = f.socket.binary.length
    handlers?.onChunk(new Uint8Array([2, 0]))
    expect(f.socket.binary).toHaveLength(binaryFramesAfterCleanup)

    f.controller.start('child')
    releaseChildControl()
    await Promise.resolve()
    expect(f.controller.getSnapshot()).toEqual({ phase: 'connecting', sessionId: 'child' })
    releaseChildPanel()
    await Promise.resolve()
    expect(f.controller.getSnapshot()).toEqual({ phase: 'idle' })
  })

  it('cancels a transient final-seat release when StrictMode remounts the same Session', async () => {
    const f = fixture()
    const release = f.controller.mountSession('session-1')
    f.controller.start('session-1')
    release()
    const releaseReplay = f.controller.mountSession('session-1')

    await Promise.resolve()
    expect(f.controller.getSnapshot()).toEqual({ phase: 'connecting', sessionId: 'session-1' })
    expect(f.socket.closes).toEqual([])

    releaseReplay()
    await Promise.resolve()
    expect(f.controller.getSnapshot()).toEqual({ phase: 'idle' })
    expect(f.socket.closes).toEqual([{ code: 1000, reason: 'stopped' }])
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

  it('never starts audio after a preparing-audio observer stops or replaces the lifecycle', () => {
    const stoppedCapture = { start: vi.fn(() => Promise.resolve()), stop: vi.fn() }
    const stopped = fixture(new FakeSocket(), () => stoppedCapture)
    stopped.controller.start('session-1')
    stopped.socket.open()
    stopped.socket.message(consentEvent())
    stopped.controller.accept('session-1')
    stopped.socket.message(readyEvent())
    stopped.controller.subscribe(() => {
      if (stopped.controller.getSnapshot().phase === 'preparing-audio') {
        stopped.controller.stop('session-1')
      }
    })
    stopped.controller.beginCapture('session-1')

    expect(stopped.controller.getSnapshot()).toEqual({ phase: 'idle' })
    expect(stopped.audioSink.prepare).not.toHaveBeenCalled()
    expect(stoppedCapture.start).not.toHaveBeenCalled()
    expect(stoppedCapture.stop).toHaveBeenCalledWith(false)
    expect(stopped.audioSink.reset).toHaveBeenCalled()

    const first = new FakeSocket()
    const second = new FakeSocket()
    const sockets = [first, second]
    const replacementCapture = { start: vi.fn(() => Promise.resolve()), stop: vi.fn() }
    const replacementSink = { prepare: vi.fn(() => Promise.resolve()), write: vi.fn(), reset: vi.fn() }
    const controller = new VoiceClientController({
      route: '/guarded-voice',
      location: { href: 'https://localhost/', protocol: 'https:' },
      socketFactory: () => sockets.shift() as unknown as WebSocket,
      now: () => NOW,
      audioSink: replacementSink,
      captureFactory: () => replacementCapture,
    })
    controller.start('session-1')
    first.open()
    first.message(consentEvent())
    controller.accept('session-1')
    first.message(readyEvent())
    let replaceOnce = true
    controller.subscribe(() => {
      if (replaceOnce && controller.getSnapshot().phase === 'preparing-audio') {
        replaceOnce = false
        controller.start('session-2')
      }
    })
    controller.beginCapture('session-1')

    expect(controller.getSnapshot()).toEqual({ phase: 'connecting', sessionId: 'session-2' })
    expect(first.closes).toEqual([{ code: 1000, reason: 'replaced' }])
    expect(replacementSink.prepare).not.toHaveBeenCalled()
    expect(replacementCapture.start).not.toHaveBeenCalled()
    expect(replacementCapture.stop).toHaveBeenCalledWith(false)
    expect(replacementSink.reset).toHaveBeenCalled()
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
    expect(bind.socket.closes).toEqual([{ code: 4000, reason: 'invalid voice state' }])
    expect(bind.socket.listenerCount()).toBe(0)

    const accept = fixture()
    accept.controller.start('session-1')
    accept.socket.open()
    accept.socket.message(consentEvent())
    vi.spyOn(accept.socket, 'send').mockImplementation(() => { throw new Error('accept send failed') })
    accept.controller.accept('session-1')
    expect(accept.controller.getSnapshot()).toMatchObject({ phase: 'error', error: 'accept send failed' })
    expect(accept.socket.closes).toEqual([{ code: 4000, reason: 'invalid voice state' }])
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
      expect(f.socket.closes).toEqual([{ code: 4000, reason: 'invalid voice state' }])
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
      'DSH Live Voice snapshot listener failed:',
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
