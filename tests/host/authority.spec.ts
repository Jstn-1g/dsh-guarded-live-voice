import { describe, expect, it } from 'vitest'
import { AuthorityGuard } from '../../src/host/authority.js'

function fixture() {
  const session = { id: 's1' }
  const sessions = new Map<string, unknown>([['s1', session]])
  const workspaces = [{ id: 'w1', sessionIds: ['s1'] }]
  const guard = new AuthorityGuard(
    { get: id => sessions.get(id) },
    { list: () => workspaces },
  )
  return { guard, session, sessions, workspaces }
}

describe('AuthorityGuard', () => {
  it('binds one exact live session to one workspace', () => {
    const { guard, session } = fixture()
    const lease = guard.bind('s1')
    expect(lease.binding).toEqual({ sessionId: 's1', workspaceId: 'w1' })
    expect(lease.sessionIdentity).toBe(session)
    expect(guard.revalidate(lease)).toBe(lease.binding)
  })

  it('rejects a missing live session', () => {
    const { guard } = fixture()
    expect(() => guard.bind('missing')).toThrow(/not live/u)
  })

  it('rejects absent and ambiguous workspace membership', () => {
    const { guard, workspaces } = fixture()
    workspaces[0]?.sessionIds.splice(0)
    expect(() => guard.bind('s1')).toThrow(/not attached/u)
    workspaces.push({ id: 'w2', sessionIds: ['s1'] }, { id: 'w3', sessionIds: ['s1'] })
    expect(() => guard.bind('s1')).toThrow(/more than one/u)
  })

  it('detects session-id reuse and workspace reassignment', () => {
    const { guard, sessions, workspaces } = fixture()
    const lease = guard.bind('s1')
    sessions.set('s1', { id: 's1' })
    expect(() => guard.revalidate(lease)).toThrow(/same live session/u)

    const second = guard.bind('s1')
    workspaces[0] = { id: 'w2', sessionIds: ['s1'] }
    expect(() => guard.revalidate(second)).toThrow(/membership changed/u)
  })
})
