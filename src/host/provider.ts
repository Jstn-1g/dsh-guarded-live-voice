import type { PublicAuthorityBinding } from './authority.js'
import type { VoiceProviderId } from '../shared/wire.js'

export type { VoiceProviderId } from '../shared/wire.js'

export interface ProviderAuthorization {
  readonly provider: VoiceProviderId
  readonly model: string
}

export type ManualTurnTranscriptRole = 'user' | 'assistant'

/** Value-bounded provider output. Raw provider errors never cross this face. */
export type ManualTurnProviderEvent =
  | {
      readonly type: 'transcript'
      readonly role: ManualTurnTranscriptRole
      /** Complete transcript observed so far, not an unbounded delta. */
      readonly text: string
      readonly final: boolean
    }
  | { readonly type: 'audio'; readonly pcm24: Uint8Array }
  | { readonly type: 'done'; readonly status: 'completed' | 'cancelled' }

export interface ManualTurnProviderSession {
  readonly authorization: ProviderAuthorization
  /** Resolves without provider-supplied detail when the connection ends. */
  readonly closed: Promise<'local' | 'provider-closed' | 'protocol-error' | 'transport-error'>
  appendPcm16(chunk: Uint8Array): void
  commit(): void
  close(): void
  subscribe(listener: (event: ManualTurnProviderEvent) => void): () => void
}

/**
 * Called only after disclosure acceptance has been consumed and authority
 * revalidated.
 * Implementations may resolve credentials here, but must not return or retain
 * credential material in this value.
 */
export type AuthorizeProvider = (
  binding: PublicAuthorityBinding,
  signal: AbortSignal,
) => Promise<ProviderAuthorization>
