import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { AuthorityGuard } from '../../src/host/authority.js'
import { ConsentChallenges } from '../../src/host/consent.js'
import type { AuthorizeProvider, VoiceProviderId } from '../../src/host/provider.js'
import { VoiceSessionManager } from '../../src/host/session-manager.js'

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

interface RealSession {
  readonly id: string
  readonly header: { readonly parentSession?: string }
}

interface RealSessionStore {
  prepare(id: string): RealSession
  enter(session: RealSession): () => void
  announce(session: RealSession): void
  fork(parent: RealSession, cwd: string | undefined, id: string): RealSession
  get(id: string): RealSession | undefined
}

/** Keep the host-only runtime import opaque to the client declaration program. */
const SESSION_RUNTIME_SPECIFIER = ['@deepseek-ai', 'dsh-session'].join('/')

function fixture(
  authorize: AuthorizeProvider = vi.fn(async () => ({ provider: 'qwen' as const, model: 'qwen-test' })),
  provider: VoiceProviderId = 'qwen',
) {
  const session = { id: 's1' }
  const sessions = new Map<string, unknown>([['s1', session]])
  const workspaces = [{ id: 'w1', sessionIds: ['s1'] }]
  const authority = new AuthorityGuard(
    { get: id => sessions.get(id) },
    { list: () => workspaces },
  )
  const consents = new ConsentChallenges({ token: () => TOKEN })
  const manager = new VoiceSessionManager(authority, consents, authorize, provider)
  return { authorize, manager, sessions, session, workspaces, consents }
}

describe('VoiceSessionManager', () => {
  it('cannot authorize a provider before exact consent', async () => {
    const { authorize, manager } = fixture()
    const begun = manager.begin('c1', 's1')
    expect(begun.provider).toBe('qwen')
    expect(authorize).not.toHaveBeenCalled()
    expect(() => manager.revalidate('c1')).toThrow(/not ready/u)

    const ready = await manager.acceptConsent('c1', begun.challenge)
    expect(authorize).toHaveBeenCalledOnce()
    expect(ready.binding).toEqual({ sessionId: 's1', workspaceId: 'w1' })
    expect(manager.revalidate('c1')).toEqual(ready)
  })

  it('binds consent and readiness to one immutable configured provider', async () => {
    const authorizeSynthetic: AuthorizeProvider = vi.fn(async () => ({
      provider: 'synthetic-demo' as const,
      model: 'synthetic-demo-v1',
    }))
    const synthetic = fixture(authorizeSynthetic, 'synthetic-demo')
    const begun = synthetic.manager.begin('c1', 's1')
    expect(begun.provider).toBe('synthetic-demo')
    await expect(synthetic.manager.acceptConsent('c1', begun.challenge)).resolves.toMatchObject({
      provider: { provider: 'synthetic-demo', model: 'synthetic-demo-v1' },
    })

    const mismatched = fixture(undefined, 'synthetic-demo')
    const mismatchBegin = mismatched.manager.begin('c1', 's1')
    await expect(mismatched.manager.acceptConsent('c1', mismatchBegin.challenge))
      .rejects.toThrow(/does not match the disclosed provider/u)
    expect(mismatched.manager.size).toBe(0)

    expect(() => fixture(undefined, 'other' as VoiceProviderId)).toThrow(/voice provider/u)
  })

  it('rejects replay, duplicate binding, and wrong connection consent', async () => {
    const { manager } = fixture()
    const begun = manager.begin('c1', 's1')
    expect(() => manager.begin('c1', 's1')).toThrow(/already bound/u)
    await manager.acceptConsent('c1', begun.challenge)
    await expect(manager.acceptConsent('c1', begun.challenge)).rejects.toThrow(/not awaiting/u)
  })

  it('revalidates authority both before and after asynchronous authorization', async () => {
    let finish!: () => void
    const authorize = vi.fn(() => new Promise<{ provider: 'qwen'; model: string }>((resolve) => {
      finish = () => { resolve({ provider: 'qwen', model: 'qwen-test' }) }
    }))
    const { manager, sessions } = fixture(authorize)
    const begun = manager.begin('c1', 's1')
    const pending = manager.acceptConsent('c1', begun.challenge)
    sessions.set('s1', { id: 's1' })
    finish()
    await expect(pending).rejects.toThrow(/same live session/u)
    expect(manager.size).toBe(0)
  })

  it('cleans failed authorization and stops every connection for a disposed session', async () => {
    const failure = vi.fn(async () => { throw new Error('provider failed') })
    const failed = fixture(failure)
    const begun = failed.manager.begin('c1', 's1')
    await expect(failed.manager.acceptConsent('c1', begun.challenge)).rejects.toThrow(/provider failed/u)
    expect(failed.manager.size).toBe(0)

    const { manager, consents } = fixture()
    manager.begin('c1', 's1')
    expect(manager.stopSession('s1')).toEqual(['c1'])
    expect(manager.size).toBe(0)
    expect(consents.size).toBe(0)
    expect(manager.stop('missing')).toBe(false)
  })

  it('keeps a forked child authorized when its parent session is disposed', async () => {
    const sessionModule = await import(/* @vite-ignore */ SESSION_RUNTIME_SPECIFIER) as Record<string, unknown>
    const SessionStore = sessionModule.default
    const SessionId = sessionModule.SessionId as (value: string) => string
    const ctx = new Context()
    const install = ctx.plugin as unknown as (
      plugin: unknown,
    ) => { await(): Promise<void> }
    await install.call(ctx, SessionStore).await()
    const sessions = (ctx as unknown as { readonly sessions: RealSessionStore }).sessions
    const parent = sessions.prepare(SessionId('parent'))
    const detachParent = sessions.enter(parent)
    sessions.announce(parent)
    const child = sessions.fork(parent, undefined, SessionId('child'))
    const workspaces = [{ id: 'w1', sessionIds: ['parent', 'child'] }]
    const tokens = [TOKEN, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb']
    const manager = new VoiceSessionManager(
      new AuthorityGuard(
        { get: id => sessions.get(SessionId(id)) },
        { list: () => workspaces },
      ),
      new ConsentChallenges({ token: () => tokens.shift() ?? TOKEN }),
      vi.fn(async () => ({ provider: 'qwen' as const, model: 'qwen-test' })),
    )
    ;(ctx as unknown as {
      on(name: 'session/disposed', listener: (session: RealSession) => void): void
    }).on('session/disposed', session => { manager.stopSession(String(session.id)) })

    const parentBegin = manager.begin('parent-connection', 'parent')
    const childBegin = manager.begin('child-connection', 'child')
    await manager.acceptConsent('parent-connection', parentBegin.challenge)
    await manager.acceptConsent('child-connection', childBegin.challenge)

    expect(parent).not.toBe(child)
    expect(child.header.parentSession).toBe(parent.id)
    expect(() => sessions.fork(parent, undefined, parent.id)).toThrow(/already exists/u)
    detachParent()

    expect(sessions.get(parent.id)).toBeUndefined()
    expect(sessions.get(child.id)).toBe(child)
    expect(manager.size).toBe(1)
    expect(manager.revalidate('child-connection')).toEqual({
      binding: { sessionId: 'child', workspaceId: 'w1' },
      provider: { provider: 'qwen', model: 'qwen-test' },
    })
    expect(manager.stopSession('child')).toEqual(['child-connection'])
  })

  it('cannot resurrect a connection stopped during provider authorization', async () => {
    let finish!: () => void
    let observedSignal: AbortSignal | undefined
    const authorize = vi.fn((_binding, signal: AbortSignal) => new Promise<{ provider: 'qwen'; model: string }>((resolve) => {
      observedSignal = signal
      finish = () => { resolve({ provider: 'qwen', model: 'qwen-test' }) }
    }))
    const { manager } = fixture(authorize)
    const begun = manager.begin('c1', 's1')
    const pending = manager.acceptConsent('c1', begun.challenge)
    expect(manager.stop('c1')).toBe(true)
    expect(observedSignal?.aborted).toBe(true)
    finish()
    await expect(pending).rejects.toThrow(/stopped during/u)
    expect(manager.size).toBe(0)
  })
})
