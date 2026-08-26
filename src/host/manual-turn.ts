import { asGuardedVoiceError, GuardedVoiceError } from '../shared/errors.js'
import type { PublicAuthorityBinding } from './authority.js'
import type {
  ManualTurnProviderEvent,
  ManualTurnProviderSession,
  ProviderAuthorization,
} from './provider.js'
import type { VoiceSessionManager } from './session-manager.js'

export type OpenManualTurnProvider = (
  binding: PublicAuthorityBinding,
  authorization: ProviderAuthorization,
  signal: AbortSignal,
) => Promise<ManualTurnProviderSession>

export interface ManualTurnSink {
  event(event: ManualTurnProviderEvent): void
  failed(error: GuardedVoiceError): void
}

interface OpeningTurn {
  readonly phase: 'opening'
  readonly binding: PublicAuthorityBinding
  readonly abortController: AbortController
}

interface ReadyTurn {
  readonly phase: 'ready'
  readonly binding: PublicAuthorityBinding
  readonly session: ManualTurnProviderSession
  unsubscribe: () => void
  done: boolean
}

type TurnRecord = OpeningTurn | ReadyTurn

function sameBinding(left: PublicAuthorityBinding, right: PublicAuthorityBinding): boolean {
  return left.sessionId === right.sessionId && left.workspaceId === right.workspaceId
}

/**
 * Binds one provider turn to an already accepted manager connection.
 * Revalidation occurs before open, after open, before every audio/commit
 * operation, and before every provider event crosses back to the browser, so a
 * Session id-reuse or Workspace move cannot inherit either side of the turn.
 */
export class ManualTurnCoordinator {
  private readonly turns = new Map<string, TurnRecord>()

  constructor(
    private readonly manager: VoiceSessionManager,
    private readonly openProvider: OpenManualTurnProvider,
  ) {}

  async start(connectionId: string, sink: ManualTurnSink): Promise<ProviderAuthorization> {
    if (this.turns.has(connectionId)) {
      throw new GuardedVoiceError('invalid-state', 'manual turn is already open')
    }
    const ready = this.manager.revalidate(connectionId)
    const opening: OpeningTurn = {
      phase: 'opening',
      binding: ready.binding,
      abortController: new AbortController(),
    }
    this.turns.set(connectionId, opening)
    let provider: ManualTurnProviderSession | undefined
    try {
      provider = await this.openProvider(ready.binding, ready.provider, opening.abortController.signal)
      if (this.turns.get(connectionId) !== opening) {
        throw new GuardedVoiceError('invalid-state', 'manual turn stopped while opening')
      }
      const current = this.manager.revalidate(connectionId)
      if (!sameBinding(current.binding, opening.binding)
        || current.provider.provider !== provider.authorization.provider
        || current.provider.model !== provider.authorization.model) {
        throw new GuardedVoiceError('authority-changed', 'manual turn provider binding changed')
      }
      const record: ReadyTurn = {
        phase: 'ready',
        binding: opening.binding,
        session: provider,
        unsubscribe: () => {},
        done: false,
      }
      const unsubscribe = provider.subscribe((event) => {
        if (this.turns.get(connectionId) !== record) return
        try {
          this.revalidate(connectionId, record)
        } catch (error) {
          sink.failed(asGuardedVoiceError(error))
          return
        }
        if (event.type === 'done') record.done = true
        sink.event(event)
      })
      record.unsubscribe = unsubscribe
      this.turns.set(connectionId, record)
      void provider.closed.then((reason) => {
        if (this.turns.get(connectionId) !== record) return
        record.unsubscribe()
        this.turns.delete(connectionId)
        if (reason !== 'local' && !record.done) {
          sink.failed(new GuardedVoiceError('invalid-state', 'voice provider connection ended'))
        }
      })
      return provider.authorization
    } catch (error) {
      provider?.close()
      if (this.turns.get(connectionId) === opening) this.turns.delete(connectionId)
      throw error
    }
  }

  appendPcm16(connectionId: string, chunk: Uint8Array): void {
    const current = this.ready(connectionId)
    this.revalidate(connectionId, current)
    current.session.appendPcm16(chunk)
  }

  commit(connectionId: string): void {
    const current = this.ready(connectionId)
    this.revalidate(connectionId, current)
    current.session.commit()
  }

  stop(connectionId: string): boolean {
    const current = this.turns.get(connectionId)
    if (current === undefined) return false
    this.turns.delete(connectionId)
    if (current.phase === 'opening') current.abortController.abort()
    else {
      current.unsubscribe()
      current.session.close()
    }
    return true
  }

  stopSession(sessionId: string): string[] {
    const stopped: string[] = []
    for (const [connectionId, current] of this.turns) {
      if (current.binding.sessionId !== sessionId) continue
      this.stop(connectionId)
      stopped.push(connectionId)
    }
    return stopped
  }

  close(): void {
    for (const connectionId of [...this.turns.keys()]) this.stop(connectionId)
  }

  get size(): number { return this.turns.size }

  private ready(connectionId: string): ReadyTurn {
    const current = this.turns.get(connectionId)
    if (current?.phase !== 'ready') {
      throw new GuardedVoiceError('invalid-state', 'manual turn is not ready')
    }
    return current
  }

  private revalidate(connectionId: string, current: ReadyTurn): void {
    let latest: ReturnType<VoiceSessionManager['revalidate']>
    try {
      latest = this.manager.revalidate(connectionId)
    } catch (error) {
      this.stop(connectionId)
      throw error
    }
    if (!sameBinding(latest.binding, current.binding)) {
      this.stop(connectionId)
      throw new GuardedVoiceError('authority-changed', 'manual turn binding changed')
    }
  }
}
