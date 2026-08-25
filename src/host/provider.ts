import type { PublicAuthorityBinding } from './authority.js'

export interface ProviderAuthorization {
  readonly provider: 'qwen'
  readonly model: string
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
