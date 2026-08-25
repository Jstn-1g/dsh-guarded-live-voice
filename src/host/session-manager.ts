import { AuthorityGuard, type AuthorityLease, type PublicAuthorityBinding } from './authority.js'
import { ConsentChallenges, type ConsentSubject } from './consent.js'
import type { AuthorizeProvider, ProviderAuthorization } from './provider.js'
import { GuardedVoiceError } from '../shared/errors.js'

interface AwaitingConsent {
  readonly phase: 'awaiting-consent'
  readonly lease: AuthorityLease
  readonly challenge: string
  readonly expiresAt: number
}

interface Authorizing {
  readonly phase: 'authorizing'
  readonly lease: AuthorityLease
  readonly abortController: AbortController
}

interface Ready {
  readonly phase: 'ready'
  readonly lease: AuthorityLease
  readonly provider: ProviderAuthorization
}

type ManagedConnection = AwaitingConsent | Authorizing | Ready

export interface BeginResult {
  readonly binding: PublicAuthorityBinding
  readonly challenge: string
  readonly expiresAt: number
}

export interface ReadyResult {
  readonly binding: PublicAuthorityBinding
  readonly provider: ProviderAuthorization
}

/** Pure lifecycle coordinator: authority -> disclosure acceptance -> provider authorization. */
export class VoiceSessionManager {
  private readonly connections = new Map<string, ManagedConnection>()

  constructor(
    private readonly authority: AuthorityGuard,
    private readonly consents: ConsentChallenges,
    private readonly authorizeProvider: AuthorizeProvider,
  ) {}

  begin(connectionId: string, sessionId: string): BeginResult {
    if (this.connections.has(connectionId)) {
      throw new GuardedVoiceError('invalid-state', 'connection is already bound')
    }
    const lease = this.authority.bind(sessionId)
    const subject = this.subject(connectionId, lease.binding)
    const issued = this.consents.issue(subject)
    this.connections.set(connectionId, {
      phase: 'awaiting-consent',
      lease,
      challenge: issued.challenge,
      expiresAt: issued.expiresAt,
    })
    return { binding: lease.binding, ...issued }
  }

  async acceptConsent(connectionId: string, challenge: string): Promise<ReadyResult> {
    const current = this.connections.get(connectionId)
    if (current?.phase !== 'awaiting-consent') {
      throw new GuardedVoiceError('consent-required', 'connection is not awaiting consent')
    }
    const binding = this.authority.revalidate(current.lease)
    this.consents.consume(challenge, this.subject(connectionId, binding))
    const authorizing: Authorizing = {
      phase: 'authorizing',
      lease: current.lease,
      abortController: new AbortController(),
    }
    this.connections.set(connectionId, authorizing)
    try {
      const provider = await this.authorizeProvider(binding, authorizing.abortController.signal)
      if (this.connections.get(connectionId) !== authorizing) {
        throw new GuardedVoiceError('invalid-state', 'connection stopped during provider authorization')
      }
      this.authority.revalidate(current.lease)
      this.connections.set(connectionId, { phase: 'ready', lease: current.lease, provider })
      return { binding, provider }
    } catch (error) {
      // A stopped connection may already have been replaced by a fresh bind
      // using the same transport id. Never let the stale completion erase it.
      if (this.connections.get(connectionId) === authorizing) this.connections.delete(connectionId)
      throw error
    }
  }

  revalidate(connectionId: string): ReadyResult {
    const current = this.connections.get(connectionId)
    if (current?.phase !== 'ready') {
      throw new GuardedVoiceError('consent-required', 'connection is not ready')
    }
    return {
      binding: this.authority.revalidate(current.lease),
      provider: current.provider,
    }
  }

  stop(connectionId: string): boolean {
    const current = this.connections.get(connectionId)
    if (current === undefined) return false
    if (current.phase === 'awaiting-consent') this.consents.revoke(current.challenge)
    if (current.phase === 'authorizing') {
      current.abortController.abort(new GuardedVoiceError('invalid-state', 'provider authorization was cancelled'))
    }
    this.connections.delete(connectionId)
    return true
  }

  stopSession(sessionId: string): string[] {
    const stopped: string[] = []
    for (const [connectionId, current] of this.connections) {
      if (current.lease.binding.sessionId !== sessionId) continue
      this.stop(connectionId)
      stopped.push(connectionId)
    }
    return stopped
  }

  get size(): number {
    return this.connections.size
  }

  private subject(connectionId: string, binding: PublicAuthorityBinding): ConsentSubject {
    return {
      connectionId,
      sessionId: binding.sessionId,
      workspaceId: binding.workspaceId,
      provider: 'qwen',
    }
  }
}
