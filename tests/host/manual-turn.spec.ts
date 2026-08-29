import { describe, expect, it, vi } from 'vitest'
import { AuthorityGuard } from '../../src/host/authority.js'
import { ConsentChallenges } from '../../src/host/consent.js'
import { ManualTurnCoordinator } from '../../src/host/manual-turn.js'
import type {
  ManualTurnProviderEvent,
  ManualTurnProviderSession,
} from '../../src/host/provider.js'
import { VoiceSessionManager } from '../../src/host/session-manager.js'

function fixture() {
  const identity = { id: 's1' }
  const sessions = new Map<string, unknown>([['s1', identity]])
  const workspaces = [{ id: 'w1', sessionIds: ['s1'] }]
  const manager = new VoiceSessionManager(
    new AuthorityGuard(
      { get: id => sessions.get(id) },
      { list: () => workspaces },
    ),
    new ConsentChallenges({ token: () => Buffer.alloc(32, 1).toString('base64url') }),
    async () => ({ provider: 'qwen', model: 'qwen-audio-3.0-realtime-plus' }),
  )
  const listeners = new Set<(event: ManualTurnProviderEvent) => void>()
  let closeReason: (reason: Awaited<ManualTurnProviderSession['closed']>) => void = () => {}
  const session: ManualTurnProviderSession = {
    authorization: { provider: 'qwen', model: 'qwen-audio-3.0-realtime-plus' },
    closed: new Promise(resolve => { closeReason = resolve }),
    appendPcm16: vi.fn(),
    commit: vi.fn(),
    close: vi.fn(() => { closeReason('local') }),
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
  const openProvider = vi.fn(async () => session)
  const coordinator = new ManualTurnCoordinator(manager, openProvider)
  return {
    coordinator,
    manager,
    openProvider,
    session,
    sessions,
    workspaces,
    listeners,
    endProvider: (reason: Awaited<ManualTurnProviderSession['closed']>) => { closeReason(reason) },
  }
}

describe('ManualTurnCoordinator', () => {
  it('cannot open before one exact disclosure acceptance is consumed', async () => {
    const f = fixture()
    const sink = { event: vi.fn(), failed: vi.fn() }
    const begun = f.manager.begin('c1', 's1')
    await expect(f.coordinator.start('c1', sink)).rejects.toThrow(/not ready/u)
    expect(f.openProvider).not.toHaveBeenCalled()

    await f.manager.acceptConsent('c1', begun.challenge)
    await expect(f.coordinator.start('c1', sink)).resolves.toEqual({
      provider: 'qwen',
      model: 'qwen-audio-3.0-realtime-plus',
    })
    expect(f.openProvider).toHaveBeenCalledWith(
      { sessionId: 's1', workspaceId: 'w1' },
      { provider: 'qwen', model: 'qwen-audio-3.0-realtime-plus' },
      expect.any(AbortSignal),
    )
    f.coordinator.appendPcm16('c1', new Uint8Array([1, 0]))
    f.coordinator.commit('c1')
    expect(f.session.appendPcm16).toHaveBeenCalledWith(new Uint8Array([1, 0]))
    expect(f.session.commit).toHaveBeenCalledTimes(1)

    for (const listener of f.listeners) listener({
      type: 'transcript', role: 'assistant', text: 'draft me', final: true,
    })
    expect(sink.event).toHaveBeenCalledWith({
      type: 'transcript', role: 'assistant', text: 'draft me', final: true,
    })
    f.coordinator.stop('c1')
    expect(f.session.close).toHaveBeenCalledTimes(1)
  })

  it('revalidates the live object and workspace before every audio operation', async () => {
    const f = fixture()
    const begun = f.manager.begin('c1', 's1')
    await f.manager.acceptConsent('c1', begun.challenge)
    await f.coordinator.start('c1', { event: vi.fn(), failed: vi.fn() })

    f.sessions.set('s1', { id: 'reused-s1' })
    expect(() => f.coordinator.appendPcm16('c1', new Uint8Array([1, 0])))
      .toThrow(/same live session/u)
    expect(f.session.appendPcm16).not.toHaveBeenCalled()
    expect(f.session.close).toHaveBeenCalledTimes(1)
    expect(f.coordinator.size).toBe(0)

    const moved = fixture()
    const movedBegin = moved.manager.begin('c2', 's1')
    await moved.manager.acceptConsent('c2', movedBegin.challenge)
    await moved.coordinator.start('c2', { event: vi.fn(), failed: vi.fn() })
    moved.workspaces[0] = { id: 'w2', sessionIds: ['s1'] }
    expect(() => moved.coordinator.commit('c2')).toThrow(/membership changed/u)
    expect(moved.session.commit).not.toHaveBeenCalled()
    expect(moved.session.close).toHaveBeenCalledTimes(1)
    expect(moved.coordinator.size).toBe(0)
  })

  it('fails closed before forwarding output after a workspace move', async () => {
    const f = fixture()
    const sink = { event: vi.fn(), failed: vi.fn() }
    const begun = f.manager.begin('c1', 's1')
    await f.manager.acceptConsent('c1', begun.challenge)
    await f.coordinator.start('c1', sink)
    const listener = [...f.listeners][0]
    expect(listener).toBeDefined()

    f.workspaces[0] = { id: 'w2', sessionIds: ['s1'] }
    listener!({ type: 'transcript', role: 'assistant', text: 'stale', final: true })
    listener!({ type: 'done', status: 'completed' })

    expect(sink.event).not.toHaveBeenCalled()
    expect(sink.failed).toHaveBeenCalledOnce()
    expect(sink.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'authority-changed' }))
    expect(f.session.close).toHaveBeenCalledOnce()
    expect(f.coordinator.size).toBe(0)
  })

  it('fails closed before forwarding output after live object reuse', async () => {
    const f = fixture()
    const sink = { event: vi.fn(), failed: vi.fn() }
    const begun = f.manager.begin('c1', 's1')
    await f.manager.acceptConsent('c1', begun.challenge)
    await f.coordinator.start('c1', sink)
    const listener = [...f.listeners][0]
    expect(listener).toBeDefined()

    f.sessions.set('s1', { id: 'reused-s1' })
    listener!({ type: 'audio', pcm24: new Uint8Array([1, 0]) })

    expect(sink.event).not.toHaveBeenCalled()
    expect(sink.failed).toHaveBeenCalledOnce()
    expect(sink.failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'authority-changed' }))
    expect(f.session.close).toHaveBeenCalledOnce()
    expect(f.coordinator.size).toBe(0)
  })

  it('detaches the provider event stream before stop closes the session', async () => {
    const f = fixture()
    const sink = { event: vi.fn(), failed: vi.fn() }
    const begun = f.manager.begin('c1', 's1')
    await f.manager.acceptConsent('c1', begun.challenge)
    await f.coordinator.start('c1', sink)
    const lateListeners = [...f.listeners]
    f.coordinator.stop('c1')
    for (const listener of lateListeners) {
      listener({ type: 'transcript', role: 'assistant', text: 'late', final: true })
      listener({ type: 'done', status: 'completed' })
    }
    expect(sink.event).not.toHaveBeenCalled()
    expect(sink.failed).not.toHaveBeenCalled()
  })

  it('can stop every turn for one session and close the remainder', async () => {
    const first = fixture()
    const begun = first.manager.begin('c1', 's1')
    await first.manager.acceptConsent('c1', begun.challenge)
    await first.coordinator.start('c1', { event: vi.fn(), failed: vi.fn() })
    expect(first.coordinator.stopSession('s1')).toEqual(['c1'])
    expect(first.session.close).toHaveBeenCalledTimes(1)
    expect(first.coordinator.stopSession('missing')).toEqual([])

    const second = fixture()
    const secondBegin = second.manager.begin('c2', 's1')
    await second.manager.acceptConsent('c2', secondBegin.challenge)
    await second.coordinator.start('c2', { event: vi.fn(), failed: vi.fn() })
    second.coordinator.close()
    expect(second.session.close).toHaveBeenCalledTimes(1)
    expect(second.coordinator.size).toBe(0)
  })

  it('stops a disposed parent turn without touching its forked child turn', async () => {
    const parent = { id: 'parent' }
    const child = { id: 'child', header: { parentSession: 'parent' } }
    const sessions = new Map<string, unknown>([
      ['parent', parent],
      ['child', child],
    ])
    const workspaces = [{ id: 'w1', sessionIds: ['parent', 'child'] }]
    const tokens = [
      Buffer.alloc(32, 2).toString('base64url'),
      Buffer.alloc(32, 3).toString('base64url'),
    ]
    const manager = new VoiceSessionManager(
      new AuthorityGuard(
        { get: id => sessions.get(id) },
        { list: () => workspaces },
      ),
      new ConsentChallenges({ token: () => tokens.shift() ?? Buffer.alloc(32, 4).toString('base64url') }),
      async () => ({ provider: 'qwen', model: 'qwen-audio-3.0-realtime-plus' }),
    )
    const providerBySession = new Map<string, ManualTurnProviderSession>()
    const coordinator = new ManualTurnCoordinator(manager, async (binding) => {
      const provider: ManualTurnProviderSession = {
        authorization: { provider: 'qwen', model: 'qwen-audio-3.0-realtime-plus' },
        closed: new Promise(() => {}),
        appendPcm16: vi.fn(),
        commit: vi.fn(),
        close: vi.fn(),
        subscribe: () => () => {},
      }
      providerBySession.set(binding.sessionId, provider)
      return provider
    })
    const parentBegin = manager.begin('parent-connection', 'parent')
    const childBegin = manager.begin('child-connection', 'child')
    await manager.acceptConsent('parent-connection', parentBegin.challenge)
    await manager.acceptConsent('child-connection', childBegin.challenge)
    await coordinator.start('parent-connection', { event: vi.fn(), failed: vi.fn() })
    await coordinator.start('child-connection', { event: vi.fn(), failed: vi.fn() })

    expect(coordinator.stopSession('parent')).toEqual(['parent-connection'])
    expect(manager.stopSession('parent')).toEqual(['parent-connection'])
    sessions.delete('parent')

    const parentProvider = providerBySession.get('parent')
    const childProvider = providerBySession.get('child')
    expect(parentProvider?.close).toHaveBeenCalledOnce()
    expect(childProvider?.close).not.toHaveBeenCalled()
    coordinator.appendPcm16('child-connection', new Uint8Array([1, 0]))
    expect(childProvider?.appendPcm16).toHaveBeenCalledWith(new Uint8Array([1, 0]))
    expect(coordinator.size).toBe(1)

    coordinator.close()
    manager.stopSession('child')
  })

  it('releases a completed provider record without reporting a failure', async () => {
    const f = fixture()
    const sink = { event: vi.fn(), failed: vi.fn() }
    const begun = f.manager.begin('c1', 's1')
    await f.manager.acceptConsent('c1', begun.challenge)
    await f.coordinator.start('c1', sink)
    for (const listener of f.listeners) listener({ type: 'done', status: 'completed' })
    f.endProvider('local')
    await vi.waitFor(() => { expect(f.coordinator.size).toBe(0) })
    expect(sink.event).toHaveBeenCalledWith({ type: 'done', status: 'completed' })
    expect(sink.failed).not.toHaveBeenCalled()
  })

  it('closes a provider whose exact binding changed while it was opening', async () => {
    const f = fixture()
    const begun = f.manager.begin('c1', 's1')
    await f.manager.acceptConsent('c1', begun.challenge)
    let release: (session: ManualTurnProviderSession) => void = () => {}
    f.openProvider.mockImplementation(() => new Promise(resolve => { release = resolve }))
    const opening = f.coordinator.start('c1', { event: vi.fn(), failed: vi.fn() })
    f.workspaces[0] = { id: 'w2', sessionIds: ['s1'] }
    release(f.session)
    await expect(opening).rejects.toThrow(/membership changed/u)
    expect(f.session.close).toHaveBeenCalledTimes(1)
  })
})
