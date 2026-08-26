import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-workspace'
import { AuthorityGuard } from './host/authority.js'
import { guardedVoiceClientBootInjection } from './host/boot.js'
import { assertTrustedHosts } from './host/carrier.js'
import { ConsentChallenges } from './host/consent.js'
import { GuardedVoiceGateway } from './host/gateway.js'
import { ManualTurnCoordinator } from './host/manual-turn.js'
import {
  DEFAULT_QWEN_REALTIME_MODEL,
  buildQwenRealtimeEndpoint,
  isQwenRealtimeModel,
  type QwenRealtimeModel,
} from './host/qwen.js'
import { VoiceSessionManager } from './host/session-manager.js'
import { openQwenManualTurn } from './host/qwen-manual-turn.js'
import { CLIENT_BOOT_VERSION, parseGuardedVoiceClientBoot } from './shared/boot.js'
import { GuardedVoiceError } from './shared/errors.js'

export {
  AuthorityGuard,
  type AuthorityLease,
  type PublicAuthorityBinding,
} from './host/authority.js'
export { assessUpgradeRequest, assertTrustedHosts } from './host/carrier.js'
export { guardedVoiceClientBootInjection } from './host/boot.js'
export { ConsentChallenges, type ConsentSubject } from './host/consent.js'
export {
  DEFAULT_QWEN_REALTIME_MODEL,
  MAX_QWEN_PROVIDER_CONTROL_BYTES,
  QWEN_REALTIME_MODELS,
  QwenHandshake,
  buildQwenRealtimeEndpoint,
  isQwenRealtimeModel,
  type QwenRealtimeModel,
  type QwenUpdatedSessionExpectation,
} from './host/qwen.js'
export {
  MAX_PROPOSAL_INSTRUCTION_LENGTH,
  MAX_PROPOSAL_TITLE_LENGTH,
  PROPOSAL_TOOL_NAME,
  parseGuardedProposal,
  type GuardedProposal,
} from './host/proposal.js'
export { VoiceSessionManager } from './host/session-manager.js'
export {
  ManualTurnCoordinator,
  type ManualTurnSink,
  type OpenManualTurnProvider,
} from './host/manual-turn.js'
export {
  DEFAULT_QWEN_INPUT_TIMEOUT_MS,
  DEFAULT_QWEN_RESPONSE_TIMEOUT_MS,
  MAX_QWEN_BUFFERED_BYTES,
  MAX_QWEN_INPUT_CHUNK_BYTES,
  MAX_QWEN_INPUT_TURN_BYTES,
  MAX_QWEN_OUTPUT_CHUNK_BYTES,
  MAX_QWEN_OUTPUT_TURN_BYTES,
  MAX_QWEN_REALTIME_EVENT_BYTES,
  MAX_QWEN_PHASE_TIMEOUT_MS,
  MAX_QWEN_TRANSCRIPT_LENGTH,
  openQwenManualTurn,
  type OpenQwenManualTurnOptions,
  type QwenManualTurnDependencies,
} from './host/qwen-manual-turn.js'
export type {
  ManualTurnProviderEvent,
  ManualTurnProviderSession,
  ManualTurnTranscriptRole,
} from './host/provider.js'
export { GuardedVoiceError, type GuardedVoiceErrorCode } from './shared/errors.js'
export {
  MAX_CONTROL_BYTES,
  WIRE_VERSION,
  encodeServerControl,
  parseClientControl,
  parseServerControl,
  type ClientControl,
  type ServerControl,
} from './shared/wire.js'
export {
  CLIENT_BOOT_GLOBAL,
  CLIENT_BOOT_VERSION,
  parseGuardedVoiceClientBoot,
  type GuardedVoiceClientBoot,
} from './shared/boot.js'

export interface Config {
  /** DSH credential reference, never a credential value. */
  credentialRef?: string
  /** Exact WebSocket path. */
  route?: string
  /** Qwen audio realtime model. */
  model?: string
  /** Alibaba Cloud Model Studio workspace subdomain; deliberately has no default. */
  dashscopeWorkspaceId?: string
  /** Comma-separated explicit hosts. Entries without ports permit any port. */
  trustedHosts?: string
  /** Lifetime of an exact-binding disclosure-acceptance challenge. */
  consentTtlMs?: number
  /** Maximum simultaneous pre-audio control connections. */
  maxConnections?: number
}

export const Config: z<Config> = z.object({
  credentialRef: z.string().default('DASHSCOPE_API_KEY'),
  route: z.string().default('/guarded-voice'),
  model: z.string().default(DEFAULT_QWEN_REALTIME_MODEL),
  dashscopeWorkspaceId: z.string(),
  trustedHosts: z.string().default('localhost,127.0.0.1,[::1]'),
  consentTtlMs: z.natural().min(1_000).max(300_000).default(60_000),
  maxConnections: z.natural().min(1).max(64).default(8),
})

export const inject = ['credentials', 'sessions', 'workspaceRegistry', 'webServer']

function resolvedConfig(config: Config = {}): Required<Omit<Config, 'dashscopeWorkspaceId'>> & Pick<Config, 'dashscopeWorkspaceId'> {
  return {
    credentialRef: config.credentialRef ?? 'DASHSCOPE_API_KEY',
    route: config.route ?? '/guarded-voice',
    model: config.model ?? DEFAULT_QWEN_REALTIME_MODEL,
    trustedHosts: config.trustedHosts ?? 'localhost,127.0.0.1,[::1]',
    consentTtlMs: config.consentTtlMs ?? 60_000,
    maxConnections: config.maxConnections ?? 8,
    ...(config.dashscopeWorkspaceId === undefined ? {} : { dashscopeWorkspaceId: config.dashscopeWorkspaceId }),
  }
}

function parseTrustedHosts(value: string): string[] {
  const hosts = value.split(',').map(entry => entry.trim()).filter(Boolean)
  assertTrustedHosts(hosts)
  return hosts
}

function assertRoute(route: string): void {
  parseGuardedVoiceClientBoot({ v: CLIENT_BOOT_VERSION, route })
}

/** Register the exact-session disclosure carrier and one bounded manual provider turn. */
export function apply(ctx: Context, input?: Config): void {
  const config = resolvedConfig(input)
  assertRoute(config.route)
  const trustedHosts = parseTrustedHosts(config.trustedHosts)
  const ref = credentialRef(config.credentialRef)
  if (!isQwenRealtimeModel(config.model)) {
    throw new TypeError(`unsupported Qwen realtime model: ${config.model}`)
  }
  const model: QwenRealtimeModel = config.model

  const authority = new AuthorityGuard(
    { get: sessionId => ctx.sessions.get(SessionId(sessionId)) },
    { list: () => ctx.workspaceRegistry.list() },
  )
  const manager = new VoiceSessionManager(
    authority,
    new ConsentChallenges({ ttlMs: config.consentTtlMs }),
    async (_binding, signal) => {
      signal.throwIfAborted()
      if (config.dashscopeWorkspaceId === undefined) {
        throw new GuardedVoiceError('provider-unconfigured', 'DashScope workspace id is not configured')
      }
      // Validate the allowlisted provider endpoint after client-attested
      // acceptance, before a future transport is allowed to use it.
      buildQwenRealtimeEndpoint(config.dashscopeWorkspaceId, model)
      const resolved = await ctx.credentials.resolve(ref)
      signal.throwIfAborted()
      if (resolved === undefined) {
        throw new GuardedVoiceError('provider-unconfigured', 'DashScope credential is not configured')
      }
      // Do not retain or return resolved.value. The live transport milestone
      // will resolve again for each provider connection.
      return { provider: 'qwen', model }
    },
  )
  const turns = new ManualTurnCoordinator(
    manager,
    async (_binding, authorization, signal) => {
      signal.throwIfAborted()
      if (authorization.provider !== 'qwen' || authorization.model !== model) {
        throw new GuardedVoiceError('provider-unconfigured', 'provider authorization does not match Qwen configuration')
      }
      if (config.dashscopeWorkspaceId === undefined) {
        throw new GuardedVoiceError('provider-unconfigured', 'DashScope workspace id is not configured')
      }
      return openQwenManualTurn({
        workspaceId: config.dashscopeWorkspaceId,
        model,
        signal,
        resolveCredential: async (credentialSignal) => {
          credentialSignal.throwIfAborted()
          const resolved = await ctx.credentials.resolve(ref)
          credentialSignal.throwIfAborted()
          return resolved?.value
        },
      })
    },
  )
  const gateway = new GuardedVoiceGateway({
    manager,
    turns,
    trustedHosts,
    maxConnections: config.maxConnections,
    logger: { warn: error => { ctx.logger.warn(error) } },
  })

  ctx.on('webserver/index-inject', (table) => {
    table.push(guardedVoiceClientBootInjection(config.route))
  })
  ctx.effect(() => ctx.webServer.registerUpgrade({
    path: config.route,
    handler: (request, socket, head) => { gateway.handleUpgrade(request, socket, head) },
  }), `guarded-live-voice: ${config.route} upgrade`)
  ctx.effect(() => () => { gateway.close() }, 'guarded-live-voice: gateway cleanup')
  ctx.on('session/disposed', (session) => { gateway.stopSession(String(session.id)) })
}
