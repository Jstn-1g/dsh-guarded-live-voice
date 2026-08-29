import { describe, expect, it } from 'vitest'
import { sessionIdOf } from '../../src/client/contract.js'

describe('strict Session-slot compatibility', () => {
  it('accepts only the exact string identity supplied by a strict Session slot', () => {
    expect(sessionIdOf({ sessionId: 'parent-session' })).toBe('parent-session')
    expect(sessionIdOf({ sessionId: 'forked-child-session' })).toBe('forked-child-session')

    for (const sessionId of [undefined, '', 0, null, {}, ['session']]) {
      expect(() => { sessionIdOf({ sessionId }) }).toThrow(/strict Session-scoped slot identity/u)
    }
  })
})
