import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'

function contextFixture() {
  const disposers: Array<() => void> = []
  const listeners: Array<(session: { readonly id: string }) => void> = []
  let route: {
    readonly path: string
    readonly handler: (request: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>
  } | undefined
  const resolve = vi.fn(async () => ({ value: 'never-export-this', source: 'test' }))
  const ctx = {
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
    on(_event: 'session/disposed', listener: (session: { readonly id: string }) => void) {
      listeners.push(listener)
    },
  } as unknown as Context
  return {
    ctx,
    disposers,
    listeners,
    resolve,
    route: () => route,
  }
}

describe('host plugin composition', () => {
  it('registers the exact route without resolving a credential at startup', () => {
    const fixture = contextFixture()
    apply(fixture.ctx, {
      route: '/guarded-voice-test',
      credentialRef: 'DASHSCOPE_API_KEY',
      dashscopeWorkspaceId: 'workspace-1',
      model: 'qwen-audio-3.0-realtime-plus',
    })
    expect(fixture.route()?.path).toBe('/guarded-voice-test')
    expect(fixture.resolve).not.toHaveBeenCalled()
    expect(fixture.listeners).toHaveLength(1)
    fixture.listeners[0]?.({ id: 's1' })
    for (const dispose of fixture.disposers.reverse()) dispose()
    expect(fixture.route()).toBeUndefined()
  })

  it.each([
    [{ route: '../bad' }, /route/u],
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
