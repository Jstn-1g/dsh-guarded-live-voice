import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  MAX_QWEN_CREDENTIAL_BYTES,
  openQwenSession,
} from '../../src/host/qwen-transport.js'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

const sessionEvent = (
  type: 'session.created' | 'session.updated',
  id = 'sess-1',
): string => JSON.stringify({
  type,
  session: {
    id,
    model: 'qwen-audio-3.0-realtime-plus',
    object: 'realtime.session',
    ...(type === 'session.updated'
      ? { modalities: ['text'], turn_detection: null }
      : {}),
  },
})

async function startFakeQwen(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<{ port: number; server: WebSocketServer }> {
  const http = createServer()
  const server = new WebSocketServer({ noServer: true })
  http.on('upgrade', (request, socket, head) => {
    server.handleUpgrade(request, socket, head, ws => server.emit('connection', ws, request))
  })
  server.on('connection', onConnection)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => http.close(() => resolve()))
  })
  return { port: (http.address() as AddressInfo).port, server }
}

function fakeDial(port: number) {
  return (_endpoint: URL, options: { authorization: string; maxPayload: number }): WebSocket => new WebSocket(
    `ws://127.0.0.1:${port}`,
    {
      headers: { Authorization: options.authorization },
      maxPayload: options.maxPayload,
      perMessageDeflate: false,
    },
  )
}

function openThroughFake(
  port: number,
  signal: AbortSignal,
  readyTimeoutMs = 1_000,
) {
  return openQwenSession({
    workspaceId: 'workspace-123',
    model: 'qwen-audio-3.0-realtime-plus',
    resolveCredential: async () => 'test-secret',
    signal,
    readyTimeoutMs,
  }, { createSocket: fakeDial(port) })
}

describe('deterministic fake Qwen WebSocket', () => {
  it('authenticates and sends only the fixed no-audio update after session.created', async () => {
    const received: unknown[] = []
    let authorization: string | undefined
    let extensions: string | undefined
    let resolveServerDone: () => void = () => {}
    const serverDone = new Promise<void>((resolve) => { resolveServerDone = resolve })
    const { port } = await startFakeQwen((ws, request) => {
      authorization = request.headers.authorization
      extensions = request.headers['sec-websocket-extensions']
      setTimeout(() => { ws.send(sessionEvent('session.created')) }, 10)
      ws.once('message', raw => {
        received.push(JSON.parse(raw.toString()))
        ws.send(sessionEvent('session.updated'))
        resolveServerDone()
      })
    })
    const requestedEndpoints: string[] = []
    const controller = new AbortController()
    const ready = openQwenSession({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: controller.signal,
    }, {
      createSocket: (endpoint, options) => {
        requestedEndpoints.push(endpoint.href)
        return new WebSocket(`ws://127.0.0.1:${port}`, {
          headers: { Authorization: options.authorization },
          maxPayload: options.maxPayload,
          perMessageDeflate: false,
        })
      },
    })

    await new Promise(resolve => setTimeout(resolve, 5))
    expect(received).toEqual([])
    const [lease] = await Promise.all([ready, serverDone])
    expect(requestedEndpoints).toEqual([
      'wss://workspace-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen-audio-3.0-realtime-plus',
    ])
    expect(requestedEndpoints[0]).not.toContain('test-secret')
    expect(authorization).toBe('Bearer test-secret')
    expect(extensions).toBeUndefined()
    expect(received).toEqual([{
      type: 'session.update',
      session: { modalities: ['text'], turn_detection: null },
    }])
    lease.close()
    expect(await lease.closed).toBe('local')
  })

  it('does no credential work when already aborted and times out a silent resolver safely', async () => {
    const aborted = new AbortController()
    aborted.abort(new Error('private abort reason'))
    let resolves = 0
    let sockets = 0
    await expect(openQwenSession({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => { resolves += 1; return 'secret' },
      signal: aborted.signal,
    }, {
      createSocket: () => { sockets += 1; throw new Error('not reached') },
    })).rejects.toThrow('Qwen realtime session was cancelled')
    expect(resolves).toBe(0)
    expect(sockets).toBe(0)

    const immediate = new AbortController()
    const immediateOpening = openQwenSession({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => { resolves += 1; return 'secret' },
      signal: immediate.signal,
    }, {
      createSocket: () => { sockets += 1; throw new Error('not reached') },
    })
    immediate.abort(new Error('private abort reason'))
    await expect(immediateOpening).rejects.toThrow('Qwen realtime session was cancelled')
    expect(resolves).toBe(0)
    expect(sockets).toBe(0)

    const timeout = openQwenSession({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: () => new Promise(() => {}),
      signal: new AbortController().signal,
      readyTimeoutMs: 10,
    })
    await expect(timeout).rejects.toThrow('Qwen realtime session timed out')

    let resolverSignal: AbortSignal | undefined
    const cooperativeTimeout = openQwenSession({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: signal => new Promise<string>((_resolve, reject) => {
        resolverSignal = signal
        signal.addEventListener('abort', () => { reject(new Error('private resolver reason')) }, { once: true })
      }),
      signal: new AbortController().signal,
      readyTimeoutMs: 10,
    })
    await expect(cooperativeTimeout).rejects.toThrow('Qwen realtime session timed out')
    expect(resolverSignal?.aborted).toBe(true)

    for (const readyTimeoutMs of [0, 60_001, 1.5]) {
      expect(() => openQwenSession({
        workspaceId: 'workspace-123',
        model: 'qwen-audio-3.0-realtime-plus',
        resolveCredential: async () => 'secret',
        signal: new AbortController().signal,
        readyTimeoutMs,
      })).toThrow(/ready timeout/u)
    }
  })

  it('does not dial when cancellation wins a pending credential resolution', async () => {
    let resolveCredential: (value: string) => void = () => {}
    const pendingCredential = new Promise<string>((resolve) => { resolveCredential = resolve })
    let resolverCalls = 0
    let socketCalls = 0
    const controller = new AbortController()
    const opening = openQwenSession({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: () => { resolverCalls += 1; return pendingCredential },
      signal: controller.signal,
    }, {
      createSocket: () => { socketCalls += 1; throw new Error('must not dial') },
    })
    await vi.waitFor(() => { expect(resolverCalls).toBe(1) })
    controller.abort(new Error('private abort reason'))
    await expect(opening).rejects.toThrow('Qwen realtime session was cancelled')
    resolveCredential('late-secret')
    await Promise.resolve()
    expect(socketCalls).toBe(0)
  })

  it('times out and removes a silent provider connection', async () => {
    let connected: () => void = () => {}
    const sawConnection = new Promise<void>((resolve) => { connected = resolve })
    const { port, server } = await startFakeQwen(() => { connected() })
    const opening = openThroughFake(port, new AbortController().signal, 50)
    await sawConnection
    await expect(opening).rejects.toThrow('Qwen realtime session timed out')
    await vi.waitFor(() => { expect(server.clients.size).toBe(0) })
  })

  it('cancels between session.created and session.updated with no lingering socket', async () => {
    let updateReceived: () => void = () => {}
    const sawUpdate = new Promise<void>((resolve) => { updateReceived = resolve })
    const { port, server } = await startFakeQwen((ws) => {
      ws.send(sessionEvent('session.created'))
      ws.once('message', () => { updateReceived() })
    })
    const controller = new AbortController()
    const opening = openThroughFake(port, controller.signal)
    await sawUpdate
    controller.abort(new Error('private abort reason'))
    await expect(opening).rejects.toThrow('Qwen realtime session was cancelled')
    await vi.waitFor(() => { expect(server.clients.size).toBe(0) })
  })

  it('keeps abort active after ready and closes idempotently', async () => {
    const { port, server } = await startFakeQwen((ws) => {
      ws.send(sessionEvent('session.created'))
      ws.once('message', () => { ws.send(sessionEvent('session.updated')) })
    })
    const controller = new AbortController()
    const lease = await openThroughFake(port, controller.signal)
    expect(server.clients.size).toBe(1)
    controller.abort(new Error('private abort reason'))
    expect(await lease.closed).toBe('aborted')
    await vi.waitFor(() => { expect(server.clients.size).toBe(0) })
    lease.close()
    lease.close()
    expect(await lease.closed).toBe('aborted')
  })

  it.each([
    ['binary event', (ws: WebSocket) => { ws.send(Buffer.from(sessionEvent('session.created'))) }],
    ['malformed event', (ws: WebSocket) => { ws.send('provider-secret malformed') }],
    ['provider error', (ws: WebSocket) => { ws.send(JSON.stringify({
      type: 'error',
      error: { message: 'provider-secret-detail', type: 'invalid_request_error' },
    })) }],
    ['out-of-order event', (ws: WebSocket) => { ws.send(sessionEvent('session.updated')) }],
  ])('fails closed on a %s without exposing provider detail', async (_label, sendEvent) => {
    const { port, server } = await startFakeQwen((ws) => { sendEvent(ws) })
    let failure: unknown
    try {
      await openThroughFake(port, new AbortController().signal)
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({
      code: 'invalid-state',
      message: 'Qwen realtime session failed',
    })
    expect(String(failure)).not.toMatch(/provider-secret/u)
    await vi.waitFor(() => { expect(server.clients.size).toBe(0) })
  })

  it('rejects changed session identity and never sends a second frame', async () => {
    const received: unknown[] = []
    const { port, server } = await startFakeQwen((ws) => {
      ws.send(sessionEvent('session.created'))
      ws.on('message', (raw) => {
        received.push(JSON.parse(raw.toString()))
        ws.send(sessionEvent('session.updated', 'sess-changed'))
      })
    })
    await expect(openThroughFake(port, new AbortController().signal))
      .rejects.toThrow('Qwen realtime session failed')
    expect(received).toHaveLength(1)
    await vi.waitFor(() => { expect(server.clients.size).toBe(0) })
  })

  it('rejects an updated session that does not confirm the safe configuration', async () => {
    const { port, server } = await startFakeQwen((ws) => {
      ws.send(sessionEvent('session.created'))
      ws.once('message', () => {
        ws.send(JSON.stringify({
          type: 'session.updated',
          session: {
            id: 'sess-1',
            modalities: ['text', 'audio'],
            model: 'qwen-audio-3.0-realtime-plus',
            object: 'realtime.session',
            turn_detection: { type: 'server_vad' },
          },
        }))
      })
    })
    await expect(openThroughFake(port, new AbortController().signal))
      .rejects.toThrow('Qwen realtime session failed')
    await vi.waitFor(() => { expect(server.clients.size).toBe(0) })
  })

  it('closes a ready session on any unsolicited provider event', async () => {
    let sendUnexpected: () => void = () => {}
    const { port, server } = await startFakeQwen((ws) => {
      ws.send(sessionEvent('session.created'))
      ws.once('message', () => {
        ws.send(sessionEvent('session.updated'))
        sendUnexpected = () => { ws.send(JSON.stringify({ type: 'rate_limits.updated' })) }
      })
    })
    const lease = await openThroughFake(port, new AbortController().signal)
    sendUnexpected()
    expect(await lease.closed).toBe('protocol-error')
    await vi.waitFor(() => { expect(server.clients.size).toBe(0) })
  })

  it('maps credential and socket failures to stable value-free errors', async () => {
    for (const credential of [
      undefined,
      '',
      'secret\r\ninjected',
      'x'.repeat(MAX_QWEN_CREDENTIAL_BYTES + 1),
    ]) {
      let socketCalls = 0
      let failure: unknown
      try {
        await openQwenSession({
          workspaceId: 'workspace-123',
          model: 'qwen-audio-3.0-realtime-plus',
          resolveCredential: async () => credential,
          signal: new AbortController().signal,
        }, {
          createSocket: () => { socketCalls += 1; throw new Error('not reached') },
        })
      } catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({
        code: 'provider-unconfigured',
        message: 'DashScope credential is missing or invalid',
      })
      expect(socketCalls).toBe(0)
    }

    let failure: unknown
    try {
      await openQwenSession({
        workspaceId: 'workspace-123',
        model: 'qwen-audio-3.0-realtime-plus',
        resolveCredential: async () => { throw new Error('credential-secret-detail') },
        signal: new AbortController().signal,
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ message: 'Qwen realtime session failed' })
    expect(String(failure)).not.toMatch(/credential-secret/u)

    failure = undefined
    try {
      await openQwenSession({
        workspaceId: 'workspace-123',
        model: 'qwen-audio-3.0-realtime-plus',
        resolveCredential: async () => 'test-secret',
        signal: new AbortController().signal,
      }, {
        createSocket: () => { throw new Error('socket-secret-detail') },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toMatchObject({ message: 'Qwen realtime session failed' })
    expect(String(failure)).not.toMatch(/socket-secret/u)
  })
})
