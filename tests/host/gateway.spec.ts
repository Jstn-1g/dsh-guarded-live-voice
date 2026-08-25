import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket } from 'ws'
import { AuthorityGuard } from '../../src/host/authority.js'
import { ConsentChallenges } from '../../src/host/consent.js'
import { GuardedVoiceGateway } from '../../src/host/gateway.js'
import type { AuthorizeProvider } from '../../src/host/provider.js'
import { VoiceSessionManager } from '../../src/host/session-manager.js'

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()))
})

const nextJson = (socket: WebSocket): Promise<Record<string, unknown>> => new Promise((resolve, reject) => {
  socket.once('message', raw => {
    try { resolve(JSON.parse(raw.toString()) as Record<string, unknown>) } catch (error) { reject(error) }
  })
  socket.once('error', reject)
})

const opened = (socket: WebSocket): Promise<void> => new Promise((resolve, reject) => {
  socket.once('open', resolve)
  socket.once('error', reject)
})

const closed = (socket: WebSocket): Promise<number> => new Promise(resolve => {
  socket.once('close', code => { resolve(code) })
})

interface StartGatewayOptions {
  readonly bindTimeoutMs?: number
  readonly consentTtlMs?: number
  readonly maxConnections?: number
  readonly authorize?: AuthorizeProvider
}

async function startGateway(options: StartGatewayOptions = {}) {
  const session = { id: 's1' }
  const sessions = new Map<string, unknown>([['s1', session]])
  const workspaces = [{ id: 'w1', sessionIds: ['s1'] }]
  const authorize = options.authorize ?? vi.fn(async () => ({ provider: 'qwen' as const, model: 'qwen-test' }))
  const manager = new VoiceSessionManager(
    new AuthorityGuard({ get: id => sessions.get(id) }, { list: () => workspaces }),
    new ConsentChallenges(options.consentTtlMs === undefined ? {} : { ttlMs: options.consentTtlMs }),
    authorize,
  )
  const warnings: Error[] = []
  const gateway = new GuardedVoiceGateway({
    manager,
    trustedHosts: ['127.0.0.1'],
    bindTimeoutMs: options.bindTimeoutMs ?? 1_000,
    ...(options.maxConnections === undefined ? {} : { maxConnections: options.maxConnections }),
    logger: { warn: error => { warnings.push(error) } },
  })
  const server: Server = createServer()
  server.on('upgrade', (request, socket, head) => { gateway.handleUpgrade(request, socket, head) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  cleanups.push(async () => {
    gateway.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
  return { authorize, gateway, manager, port, sessions, warnings }
}

function connect(port: number, origin = `http://127.0.0.1:${port}`): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}/guarded-voice`, { origin })
}

describe('GuardedVoiceGateway', () => {
  it('runs bind -> disclosure -> exact consent -> ready without early authorization', async () => {
    const { authorize, manager, port } = await startGateway()
    const socket = connect(port)
    await opened(socket)

    const disclosure = nextJson(socket)
    socket.send('{"v":1,"type":"bind","sessionId":"s1"}')
    const consent = await disclosure
    expect(consent.type).toBe('consent.required')
    expect(consent.disclosure).toEqual({
      audioDestination: 'Alibaba Cloud Qwen realtime API',
      exportedContext: 'none',
      executionAuthority: 'none',
    })
    expect(authorize).not.toHaveBeenCalled()

    const readyEvent = nextJson(socket)
    socket.send(JSON.stringify({ v: 1, type: 'consent.accept', challenge: consent.challenge }))
    await expect(readyEvent).resolves.toMatchObject({
      type: 'ready',
      sessionId: 's1',
      workspaceId: 'w1',
      provider: 'qwen',
      authority: 'proposal-only',
    })
    expect(authorize).toHaveBeenCalledOnce()

    const stoppedEvent = nextJson(socket)
    const didClose = closed(socket)
    socket.send('{"v":1,"type":"stop"}')
    await expect(stoppedEvent).resolves.toMatchObject({ type: 'stopped' })
    await expect(didClose).resolves.toBe(1000)
    expect(manager.size).toBe(0)
  })

  it('rejects cross-origin upgrades before creating a managed connection', async () => {
    const { manager, port } = await startGateway()
    const socket = connect(port, 'http://attacker.example')
    socket.on('error', () => {})
    const status = await new Promise<number>((resolve) => {
      socket.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
    })
    expect(status).toBe(403)
    expect(manager.size).toBe(0)
    socket.terminate()
  })

  it('stops an exact connection when its DSH session is disposed', async () => {
    const { gateway, manager, port } = await startGateway()
    const socket = connect(port)
    await opened(socket)
    const disclosure = nextJson(socket)
    socket.send('{"v":1,"type":"bind","sessionId":"s1"}')
    await disclosure
    const errorEvent = nextJson(socket)
    const didClose = closed(socket)
    gateway.stopSession('s1')
    await expect(errorEvent).resolves.toMatchObject({ type: 'error', code: 'authority-changed' })
    await expect(didClose).resolves.toBe(1008)
    expect(manager.size).toBe(0)
  })

  it('fails closed on binary input and on a connection that never binds', async () => {
    const first = await startGateway()
    const binary = connect(first.port)
    await opened(binary)
    const binaryError = nextJson(binary)
    binary.send(Buffer.from([1, 2, 3]))
    await expect(binaryError).resolves.toMatchObject({ type: 'error', code: 'invalid-message' })

    const second = await startGateway({ bindTimeoutMs: 20 })
    const idle = connect(second.port)
    await opened(idle)
    const timeoutError = nextJson(idle)
    await expect(timeoutError).resolves.toMatchObject({ type: 'error', code: 'invalid-state' })
    expect(second.warnings).toHaveLength(1)
  })

  it('expires an idle disclosure and reclaims its authority lease', async () => {
    const { manager, port } = await startGateway({ consentTtlMs: 1_000 })
    const socket = connect(port)
    await opened(socket)
    const disclosure = nextJson(socket)
    socket.send('{"v":1,"type":"bind","sessionId":"s1"}')
    await disclosure
    const expired = nextJson(socket)
    const didClose = closed(socket)
    await expect(expired).resolves.toMatchObject({ type: 'error', code: 'consent-expired' })
    await expect(didClose).resolves.toBe(1008)
    expect(manager.size).toBe(0)
  })

  it('enforces a hard simultaneous-connection cap', async () => {
    const { port } = await startGateway({ maxConnections: 1 })
    const first = connect(port)
    await opened(first)
    const second = connect(port)
    second.on('error', () => {})
    const status = await new Promise<number>((resolve) => {
      second.once('unexpected-response', (_request, response) => {
        response.resume()
        resolve(response.statusCode ?? 0)
      })
    })
    expect(status).toBe(429)
    second.terminate()
    first.close()
  })

  it('processes stop out of band and aborts pending provider authorization', async () => {
    let observedSignal: AbortSignal | undefined
    let started!: () => void
    const authorizationStarted = new Promise<void>(resolve => { started = resolve })
    const authorize: AuthorizeProvider = async (_binding, signal) => {
      observedSignal = signal
      started()
      return await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
      })
    }
    const { gateway, manager, port, warnings } = await startGateway({ authorize, maxConnections: 1 })
    const socket = connect(port)
    await opened(socket)
    const disclosure = nextJson(socket)
    socket.send('{"v":1,"type":"bind","sessionId":"s1"}')
    const consent = await disclosure
    socket.send(JSON.stringify({ v: 1, type: 'consent.accept', challenge: consent.challenge }))
    await authorizationStarted

    const terminalEvents: Array<Record<string, unknown>> = []
    socket.on('message', raw => {
      terminalEvents.push(JSON.parse(raw.toString()) as Record<string, unknown>)
    })
    const stopped = nextJson(socket)
    const didClose = closed(socket)
    socket.send('{"v":1,"type":"stop"}')
    await expect(stopped).resolves.toMatchObject({ type: 'stopped' })
    expect(gateway.connectionCount).toBe(0)
    expect(manager.size).toBe(0)

    // Capacity is reclaimed by the terminal transition itself, not deferred
    // until the peer completes its WebSocket close handshake.
    const replacement = connect(port)
    await opened(replacement)
    expect(gateway.connectionCount).toBe(1)
    replacement.close()

    await expect(didClose).resolves.toBe(1000)
    await new Promise(resolve => { setImmediate(resolve) })
    expect(observedSignal?.aborted).toBe(true)
    expect(terminalEvents.map(event => event.type)).toEqual(['stopped'])
    expect(warnings).toEqual([])
  })
})
