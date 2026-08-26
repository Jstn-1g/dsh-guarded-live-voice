import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { apply } from '../../src/index.js'

function contextFixture() {
  const disposers: Array<() => void> = []
  const sessionListeners: Array<(session: { readonly id: string }) => void> = []
  const indexListeners: Array<(table: unknown[]) => void> = []
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
    for (const dispose of fixture.disposers.reverse()) dispose()
    expect(fixture.route()).toBeUndefined()
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
