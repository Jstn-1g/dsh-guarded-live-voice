import type { Context } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { WebSocket, type RawData } from 'ws'
import {
  SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT,
  SYNTHETIC_DEMO_MODEL,
  SYNTHETIC_DEMO_USER_TRANSCRIPT,
  apply,
  inject,
} from '../../src/index.js'
import { GuardedVoiceGateway } from '../../src/host/gateway.js'

function contextFixture(connection: unknown = {}) {
  const disposers: Array<() => void> = []
  const sessionListeners: Array<(session: { readonly id: string }) => void> = []
  const indexListeners: Array<(table: unknown[]) => void> = []
  const session = { id: 's1' }
  let route: {
    readonly path: string
    readonly handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  } | undefined
  const resolve = vi.fn(async () => ({ value: 'never-export-this', source: 'test' }))
  const ctx = {
    connection,
    credentials: { resolve },
    sessions: { get: () => session },
    workspaceRegistry: { list: () => [{ id: 'w1', sessionIds: ['s1'] }] },
    webServer: {
      registerUpgrade(value: NonNullable<typeof route>) {
        route = value
        return () => { route = undefined }
      },
    },
    logger: { warn: () => {} },
    effect(factory: () => (() => void) | Promise<() => void>) {
      const disposer = factory()
      if (disposer instanceof Promise) throw new Error('unexpected async effect in test')
      disposers.push(disposer)
    },
    on(event: string, listener: ((session: { readonly id: string }) => void) | ((table: unknown[]) => void)) {
      if (event === 'session/disposed') {
        sessionListeners.push(listener as (session: { readonly id: string }) => void)
      } else if (event === 'webserver/index-inject') {
        indexListeners.push(listener as (table: unknown[]) => void)
      }
    },
  } as unknown as Context
  return {
    ctx,
    disposers,
    sessionListeners,
    indexListeners,
    resolve,
    route: () => route,
  }
}

function validConfig() {
  return {
    route: '/guarded-voice-test',
    credentialRef: 'DASHSCOPE_API_KEY',
    dashscopeWorkspaceId: 'workspace-1',
    model: 'qwen-audio-3.0-realtime-plus',
  } as const
}

function routeArguments() {
  const request = {} as IncomingMessage
  const end = vi.fn()
  const socket = { end } as unknown as Duplex
  const head = Buffer.alloc(0)
  return { end, head, request, socket }
}

function disposeFixture(fixture: ReturnType<typeof contextFixture>): void {
  for (const dispose of fixture.disposers.reverse()) dispose()
}

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
}

function nextJson(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (raw, isBinary) => {
      if (isBinary) {
        reject(new Error('expected a JSON control frame'))
        return
      }
      try { resolve(JSON.parse(raw.toString()) as Record<string, unknown>) } catch (error) { reject(error) }
    })
    socket.once('error', reject)
  })
}

function nextFrames(socket: WebSocket, count: number): Promise<Array<{ readonly raw: RawData; readonly isBinary: boolean }>> {
  return new Promise((resolve, reject) => {
    const frames: Array<{ readonly raw: RawData; readonly isBinary: boolean }> = []
    const onMessage = (raw: RawData, isBinary: boolean): void => {
      frames.push({ raw, isBinary })
      if (frames.length !== count) return
      socket.off('message', onMessage)
      socket.off('error', onError)
      resolve(frames)
    }
    const onError = (error: Error): void => {
      socket.off('message', onMessage)
      reject(error)
    }
    socket.on('message', onMessage)
    socket.once('error', onError)
  })
}

function closed(socket: WebSocket): Promise<void> {
  return new Promise(resolve => { socket.once('close', () => { resolve() }) })
}

describe('host plugin composition', () => {
  it('orders route registration after the Harness connection service', () => {
    expect(inject).toEqual(['credentials', 'sessions', 'workspaceRegistry', 'webServer', 'connection'])
  })

  it('registers the exact route without resolving a credential at startup', () => {
    const fixture = contextFixture()
    apply(fixture.ctx, validConfig())
    expect(fixture.route()?.path).toBe('/guarded-voice-test')
    expect(fixture.resolve).not.toHaveBeenCalled()
    expect(fixture.sessionListeners).toHaveLength(1)
    expect(fixture.indexListeners).toHaveLength(1)
    const table: unknown[] = []
    fixture.indexListeners[0]?.(table)
    expect(table).toEqual([{
      kind: 'global',
      name: '__DSH_GUARDED_LIVE_VOICE__',
      value: { v: 1, route: '/guarded-voice-test' },
    }])
    expect(JSON.stringify(table)).not.toMatch(/DASHSCOPE|credential|workspace-1|qwen-audio/u)
    fixture.sessionListeners[0]?.({ id: 's1' })
    disposeFixture(fixture)
    expect(fixture.route()).toBeUndefined()
  })

  it('runs the registered synthetic demo end to end without validating or resolving Qwen configuration', async () => {
    const fixture = contextFixture()
    apply(fixture.ctx, {
      provider: 'synthetic-demo',
      route: '/synthetic-demo-test',
      credentialRef: 'literal-secret!',
      model: 'made-up-model',
      dashscopeWorkspaceId: 'not/a-workspace',
    })
    expect(fixture.route()?.path).toBe('/synthetic-demo-test')
    expect(fixture.resolve).not.toHaveBeenCalled()

    const server = createServer()
    server.on('upgrade', (request, socket, head) => {
      void fixture.route()?.handler(request, socket, head)
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}/synthetic-demo-test`, {
      origin: `http://127.0.0.1:${String(port)}`,
    })
    try {
      await opened(socket)
      const disclosureEvent = nextJson(socket)
      socket.send('{"v":1,"type":"bind","sessionId":"s1"}')
      const disclosure = await disclosureEvent
      expect(disclosure).toEqual({
        v: 1,
        type: 'consent.required',
        challenge: expect.stringMatching(/^[A-Za-z0-9_-]{32,128}$/u),
        expiresAt: expect.any(Number),
        sessionId: 's1',
        workspaceId: 'w1',
        provider: 'synthetic-demo',
        disclosure: {
          audioDestination: 'Local deterministic synthetic demo',
          exportedContext: 'none',
          executionAuthority: 'none',
          providerRetention: 'none; no external provider connection',
          currentMilestone: 'one bounded synthetic demo turn after acceptance',
        },
      })
      expect(fixture.resolve).not.toHaveBeenCalled()

      const readyEvent = nextJson(socket)
      socket.send(JSON.stringify({ v: 1, type: 'consent.accept', challenge: disclosure.challenge }))
      await expect(readyEvent).resolves.toEqual({
        v: 1,
        type: 'ready',
        sessionId: 's1',
        workspaceId: 'w1',
        provider: 'synthetic-demo',
        model: SYNTHETIC_DEMO_MODEL,
        authority: 'proposal-only',
      })
      expect(fixture.resolve).not.toHaveBeenCalled()

      const output = nextFrames(socket, 4)
      socket.send(Buffer.from([1, 0, 2, 0]))
      socket.send('{"v":1,"type":"turn.commit"}')
      const frames = await output
      expect(frames[0]?.isBinary).toBe(false)
      expect(JSON.parse(frames[0]!.raw.toString())).toEqual({
        v: 1,
        type: 'transcript',
        role: 'user',
        text: SYNTHETIC_DEMO_USER_TRANSCRIPT,
        final: true,
      })
      expect(frames[1]?.isBinary).toBe(false)
      expect(JSON.parse(frames[1]!.raw.toString())).toEqual({
        v: 1,
        type: 'transcript',
        role: 'assistant',
        text: SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT,
        final: true,
      })
      expect(frames[2]?.isBinary).toBe(true)
      const chime = Buffer.from(frames[2]!.raw as Buffer)
      expect(chime.byteLength).toBe(4_800)
      expect(createHash('sha256').update(chime).digest('hex'))
        .toBe('ef3d9ae9e285aaef41443f087dbf1a046ed32d50470394f1e492c86815811e57')
      expect(frames[3]?.isBinary).toBe(false)
      expect(JSON.parse(frames[3]!.raw.toString())).toEqual({
        v: 1,
        type: 'turn.done',
        status: 'completed',
      })
      expect(fixture.resolve).not.toHaveBeenCalled()

      const didClose = closed(socket)
      socket.close(1000)
      await didClose
    } finally {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
      disposeFixture(fixture)
      await new Promise<void>(resolve => { server.close(() => { resolve() }) })
    }
  })

  it('keeps the rc.2 connection shape on the existing carrier path', () => {
    const fixture = contextFixture({ rpc: {} })
    const gateway = vi.spyOn(GuardedVoiceGateway.prototype, 'handleUpgrade').mockImplementation(() => {})
    try {
      apply(fixture.ctx, validConfig())
      const args = routeArguments()
      fixture.route()?.handler(args.request, args.socket, args.head)
      expect(gateway).toHaveBeenCalledOnce()
      expect(gateway).toHaveBeenCalledWith(args.request, args.socket, args.head)
      expect(args.end).not.toHaveBeenCalled()
      expect(fixture.resolve).not.toHaveBeenCalled()
    } finally {
      gateway.mockRestore()
      disposeFixture(fixture)
    }
  })

  it('runs the alpha connection gate with its service receiver before the voice carrier', () => {
    let connection: { requestRejection(request: IncomingMessage): undefined }
    const requestRejection = vi.fn(function (this: unknown, _request: IncomingMessage) {
      expect(this).toBe(connection)
      return undefined
    })
    connection = { requestRejection }
    const fixture = contextFixture(connection)
    const gateway = vi.spyOn(GuardedVoiceGateway.prototype, 'handleUpgrade').mockImplementation(() => {})
    try {
      apply(fixture.ctx, validConfig())
      const args = routeArguments()
      fixture.route()?.handler(args.request, args.socket, args.head)
      expect(requestRejection).toHaveBeenCalledWith(args.request)
      expect(gateway).toHaveBeenCalledWith(args.request, args.socket, args.head)
      expect(args.end).not.toHaveBeenCalled()
    } finally {
      gateway.mockRestore()
      disposeFixture(fixture)
    }
  })

  it.each([401, 403] as const)('short-circuits a Harness connection rejection with status %i', (status) => {
    const requestRejection = vi.fn(() => status)
    const fixture = contextFixture({ requestRejection })
    const gateway = vi.spyOn(GuardedVoiceGateway.prototype, 'handleUpgrade').mockImplementation(() => {})
    try {
      apply(fixture.ctx, validConfig())
      const args = routeArguments()
      fixture.route()?.handler(args.request, args.socket, args.head)
      expect(requestRejection).toHaveBeenCalledWith(args.request)
      expect(args.end).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`^HTTP/1\\.1 ${String(status)} `, 'u')))
      expect(gateway).not.toHaveBeenCalled()
      expect(fixture.resolve).not.toHaveBeenCalled()
    } finally {
      gateway.mockRestore()
      disposeFixture(fixture)
    }
  })

  it.each([
    ['throws', () => { throw new Error('gate failed') }, /gate failed/u],
    ['returns an invalid status', () => 200, /invalid status/u],
  ])('fails closed when the Harness connection gate %s', (_label, requestRejection, message) => {
    const fixture = contextFixture({ requestRejection })
    const gateway = vi.spyOn(GuardedVoiceGateway.prototype, 'handleUpgrade').mockImplementation(() => {})
    try {
      apply(fixture.ctx, validConfig())
      const args = routeArguments()
      expect(() => fixture.route()?.handler(args.request, args.socket, args.head)).toThrow(message)
      expect(gateway).not.toHaveBeenCalled()
      expect(fixture.resolve).not.toHaveBeenCalled()
    } finally {
      gateway.mockRestore()
      disposeFixture(fixture)
    }
  })

  it.each([
    [{ route: '../bad' }, /bootstrap/u],
    [{ route: '/.' }, /bootstrap/u],
    [{ route: '/..' }, /bootstrap/u],
    [{ credentialRef: 'literal-secret!' }, /credential ref/u],
    [{ trustedHosts: 'localhost/bad' }, /trusted host/u],
    [{ model: 'made-up-model' }, /unsupported Qwen/u],
    [{ consentTtlMs: 999 }, /consent ttl/u],
    [{ maxConnections: 0 }, /max connections/u],
  ])('rejects invalid hand-built config %#', (config, message) => {
    const fixture = contextFixture()
    expect(() => apply(fixture.ctx, config)).toThrow(message)
  })
})
