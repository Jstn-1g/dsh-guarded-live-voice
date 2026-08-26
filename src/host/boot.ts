import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import {
  CLIENT_BOOT_GLOBAL,
  CLIENT_BOOT_VERSION,
  parseGuardedVoiceClientBoot,
  type GuardedVoiceClientBoot,
} from '../shared/boot.js'

/** Publish only the non-secret browser route through DSH's structured boot table. */
export function guardedVoiceClientBootInjection(route: string): IndexInjection {
  const value: GuardedVoiceClientBoot = parseGuardedVoiceClientBoot({ v: CLIENT_BOOT_VERSION, route })
  return { kind: 'global', name: CLIENT_BOOT_GLOBAL, value }
}
