import { describe, expect, it, vi } from 'vitest'
import { AuthorityGuard } from '../../src/host/authority.js'
import { ConsentChallenges } from '../../src/host/consent.js'
import type { AuthorizeProvider } from '../../src/host/provider.js'
import { VoiceSessionManager } from '../../src/host/session-manager.js'

const TOKEN = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

function fixture(authorize: AuthorizeProvider = vi.fn(async () => ({ provider: 'qwen' as const, model: 'qwen-test' }))) {
  const session = { id: 's1' }
  const sessions = new Map<string, unknown>([['s1', session]])
  const workspaces = [{ id: 'w1', sessionIds: ['s1'] }]
  const authority = new AuthorityGuard(
    { get: id => sessions.get(id) },
    { list: () => workspaces },
  )
  const consents = new ConsentChallenges({ token: () => TOKEN })
  const manager = new VoiceSessionManager(authority, consents, authorize)
  return { authorize, manager, sessions, session, workspaces, consents }
}

describe('VoiceSessionManager', () => {
  it('cannot authorize a provider before exact consent', async () => {
    const { authorize, manager } = fixture()
    const begun = manager.begin('c1', 's1')
    expect(authorize).not.toHaveBeenCalled()
    expect(() => manager.revalidate('c1')).toThrow(/not ready/u)

    const ready = await manager.acceptConsent('c1', begun.challenge)
    expect(authorize).toHaveBeenCalledOnce()
    expect(ready.binding).toEqual({ sessionId: 's1', workspaceId: 'w1' })
    expect(manager.revalidate('c1')).toEqual(ready)
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
