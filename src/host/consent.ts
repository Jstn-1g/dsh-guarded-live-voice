import { randomBytes } from 'node:crypto'
import { GuardedVoiceError } from '../shared/errors.js'
import { CHALLENGE_PATTERN } from '../shared/wire.js'

export interface ConsentSubject {
  readonly connectionId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly provider: 'qwen'
}

export interface ConsentChallenge {
  readonly challenge: string
  readonly expiresAt: number
}

interface StoredChallenge extends ConsentChallenge {
  readonly subject: ConsentSubject
}

export interface ConsentChallengeOptions {
  readonly ttlMs?: number
  readonly now?: () => number
  readonly token?: () => string
}

const sameSubject = (left: ConsentSubject, right: ConsentSubject): boolean =>
  left.connectionId === right.connectionId
  && left.sessionId === right.sessionId
  && left.workspaceId === right.workspaceId
  && left.provider === right.provider

/** Short-lived, one-shot proof that the exact bound connection accepted disclosure. */
export class ConsentChallenges {
  private readonly records = new Map<string, StoredChallenge>()
  private readonly ttlMs: number
  private readonly now: () => number
  private readonly token: () => string

  constructor(options: ConsentChallengeOptions = {}) {
    this.ttlMs = options.ttlMs ?? 60_000
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1_000 || this.ttlMs > 5 * 60_000) {
      throw new TypeError('consent ttl must be an integer between 1 and 300 seconds')
    }
    this.now = options.now ?? Date.now
    this.token = options.token ?? (() => randomBytes(32).toString('base64url'))
  }

  issue(subject: ConsentSubject): ConsentChallenge {
    this.sweep()
    const challenge = this.token()
    if (!CHALLENGE_PATTERN.test(challenge) || this.records.has(challenge)) {
      throw new Error('consent token source produced an invalid or duplicate challenge')
    }
    const stored: StoredChallenge = {
      challenge,
      expiresAt: this.now() + this.ttlMs,
      subject: { ...subject },
    }
    this.records.set(challenge, stored)
    return { challenge: stored.challenge, expiresAt: stored.expiresAt }
  }

  consume(challenge: string, subject: ConsentSubject): void {
    if (!CHALLENGE_PATTERN.test(challenge)) {
      throw new GuardedVoiceError('consent-invalid', 'consent challenge is invalid')
    }
    const stored = this.records.get(challenge)
    if (stored === undefined) {
      throw new GuardedVoiceError('consent-invalid', 'consent challenge is unknown or already used')
    }
    // Delete before validation so a failed attempt can never be replayed.
    this.records.delete(challenge)
    if (this.now() >= stored.expiresAt) {
      throw new GuardedVoiceError('consent-expired', 'consent challenge expired')
    }
    if (!sameSubject(stored.subject, subject)) {
      throw new GuardedVoiceError('consent-invalid', 'consent challenge belongs to a different binding')
    }
  }

  revoke(challenge: string): void {
    this.records.delete(challenge)
  }

  sweep(): number {
    const now = this.now()
    let removed = 0
    for (const [challenge, record] of this.records) {
      if (now < record.expiresAt) continue
      this.records.delete(challenge)
      removed += 1
    }
    return removed
  }

  get size(): number {
    return this.records.size
  }
}
