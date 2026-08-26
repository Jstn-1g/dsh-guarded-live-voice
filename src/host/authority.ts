import { GuardedVoiceError } from '../shared/errors.js'
import { isValidWireId } from '../shared/wire.js'

export interface LiveSessionSource {
  get(sessionId: string): unknown | undefined
}

export interface WorkspaceView {
  readonly id: string
  readonly sessionIds: readonly string[]
}

export interface WorkspaceSource {
  list(): readonly WorkspaceView[]
}

export interface PublicAuthorityBinding {
  readonly sessionId: string
  readonly workspaceId: string
}

/** Opaque lease. The live object identity prevents an id-reuse race. */
export interface AuthorityLease {
  readonly binding: PublicAuthorityBinding
  readonly sessionIdentity: unknown
}

/** Exact session/workspace authority boundary for one voice connection. */
export class AuthorityGuard {
  constructor(
    private readonly sessions: LiveSessionSource,
    private readonly workspaces: WorkspaceSource,
  ) {}

  bind(sessionId: string): AuthorityLease {
    const sessionIdentity = this.sessions.get(sessionId)
    if (sessionIdentity === undefined) {
      throw new GuardedVoiceError('session-not-live', 'the requested session is not live')
    }
    const matches = this.workspaces.list().filter(workspace => workspace.sessionIds.includes(sessionId))
    if (matches.length === 0) {
      throw new GuardedVoiceError('workspace-not-found', 'the session is not attached to a workspace')
    }
    if (matches.length !== 1) {
      throw new GuardedVoiceError('authority-ambiguous', 'the session is attached to more than one workspace')
    }
    const [workspace] = matches
    if (workspace === undefined) {
      throw new GuardedVoiceError('workspace-not-found', 'the session is not attached to a workspace')
    }
    const workspaceId = String(workspace.id)
    if (!isValidWireId(workspaceId)) {
      throw new GuardedVoiceError('invalid-state', 'the workspace identifier is not safe for the browser protocol')
    }
    return {
      binding: { sessionId, workspaceId },
      sessionIdentity,
    }
  }

  revalidate(lease: AuthorityLease): PublicAuthorityBinding {
    if (this.sessions.get(lease.binding.sessionId) !== lease.sessionIdentity) {
      throw new GuardedVoiceError('authority-changed', 'the bound session is no longer the same live session')
    }
    const matches = this.workspaces.list().filter(workspace =>
      workspace.sessionIds.includes(lease.binding.sessionId),
    )
    const workspaceId = String(matches[0]?.id)
    if (matches.length !== 1 || !isValidWireId(workspaceId) || workspaceId !== lease.binding.workspaceId) {
      throw new GuardedVoiceError('authority-changed', 'the bound workspace membership changed')
    }
    return lease.binding
  }
}
