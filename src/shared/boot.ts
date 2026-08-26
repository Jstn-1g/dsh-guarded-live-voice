export const CLIENT_BOOT_GLOBAL = '__DSH_GUARDED_LIVE_VOICE__' as const
export const CLIENT_BOOT_VERSION = 1 as const

export interface GuardedVoiceClientBoot {
  readonly v: typeof CLIENT_BOOT_VERSION
  readonly route: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate the non-secret Host-to-browser route descriptor. */
export function parseGuardedVoiceClientBoot(value: unknown): GuardedVoiceClientBoot {
  if (!isRecord(value)
    || Object.keys(value).some(key => key !== 'v' && key !== 'route')
    || value.v !== CLIENT_BOOT_VERSION
    || typeof value.route !== 'string'
    || !/^\/[A-Za-z0-9._~-]+$/u.test(value.route)
    || value.route === '/.'
    || value.route === '/..') {
    throw new TypeError('guarded voice browser bootstrap is invalid')
  }
  return { v: CLIENT_BOOT_VERSION, route: value.route }
}
