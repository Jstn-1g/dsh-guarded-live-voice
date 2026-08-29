import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../../src/index.js'
import { GuardedVoiceGateway } from '../../src/host/gateway.js'

function contextFixture(connection: unknown = {}) {
  const disposers: Array<() => void> = []
  const sessionListeners: Array<(session: { readonly id: string }) => void> = []
  const indexListeners: Array<(table: unknown[]) => void> = []
  let route: {
    readonly path: string
    readonly handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  } | undefined
  const resolve = vi.fn(async () => ({ value: 'never-export-this', source: 'test' }))
  const ctx = {
    connection,
    credentials: { resolve },
    sessions: { get: () => ({ id: 's1' }) },
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
