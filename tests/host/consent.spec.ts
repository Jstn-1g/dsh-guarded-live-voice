import { describe, expect, it } from 'vitest'
import { ConsentChallenges, type ConsentSubject } from '../../src/host/consent.js'

const TOKEN_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const TOKEN_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const subject: ConsentSubject = {
  connectionId: 'c1',
  sessionId: 's1',
  workspaceId: 'w1',
  provider: 'qwen',
}

describe('ConsentChallenges', () => {
  it('issues one-shot consent for one exact binding', () => {
    const challenges = new ConsentChallenges({ token: () => TOKEN_A })
    const issued = challenges.issue(subject)
    expect(issued.challenge).toBe(TOKEN_A)
    expect(challenges.size).toBe(1)
    challenges.consume(TOKEN_A, subject)
    expect(challenges.size).toBe(0)
    expect(() => challenges.consume(TOKEN_A, subject)).toThrow(/unknown or already used/u)
  })

  it('burns a challenge when a different binding tries to use it', () => {
    const challenges = new ConsentChallenges({ token: () => TOKEN_A })
    challenges.issue(subject)
    expect(() => challenges.consume(TOKEN_A, { ...subject, sessionId: 's2' })).toThrow(/different binding/u)
    expect(() => challenges.consume(TOKEN_A, subject)).toThrow(/unknown or already used/u)

    const providerBound = new ConsentChallenges({ token: () => TOKEN_B })
    providerBound.issue(subject)
    expect(() => providerBound.consume(TOKEN_B, { ...subject, provider: 'synthetic-demo' }))
      .toThrow(/different binding/u)
    expect(() => providerBound.consume(TOKEN_B, subject)).toThrow(/unknown or already used/u)
  })

  it('expires, revokes, and sweeps challenges deterministically', () => {
    let now = 1_000
    let token = TOKEN_A
    const challenges = new ConsentChallenges({ ttlMs: 1_000, now: () => now, token: () => token })
    challenges.issue(subject)
    now = 2_000
    expect(() => challenges.consume(TOKEN_A, subject)).toThrow(/expired/u)

    token = TOKEN_B
    challenges.issue(subject)
    challenges.revoke(TOKEN_B)
    expect(challenges.size).toBe(0)

    token = TOKEN_A
    challenges.issue(subject)
    now = 3_001
    expect(challenges.sweep()).toBe(1)
  })

  it('rejects unsafe configuration and token generators', () => {
    expect(() => new ConsentChallenges({ ttlMs: 999 })).toThrow(/ttl/u)
    expect(() => new ConsentChallenges({ ttlMs: 300_001 })).toThrow(/ttl/u)
    const invalid = new ConsentChallenges({ token: () => 'short' })
    expect(() => invalid.issue(subject)).toThrow(/token source/u)
  })
})
