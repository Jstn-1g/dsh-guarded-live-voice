import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CLIENT_BOOT_GLOBAL, parseGuardedVoiceClientBoot } from '../shared/boot.js'
import { VoiceClientController } from './controller.js'
import type { VoiceInjected } from './contract.js'
import { en, NS, zh, type VoiceKey } from './locales.js'
import { VoiceControl } from './VoiceControl.js'
import { VoicePanel } from './VoicePanel.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Guarded voice disclosure and setup copy. */
    guardedVoice: VoiceKey
  }
}

/** Browser services required by the two guarded-voice slot contributions. */
export const inject = ['slots', 'locale']

/** Mount the user-visible, exact-session disclosure flow. */
export function apply(ctx: ClientContext): void {
  const raw = (globalThis as Record<string, unknown>)[CLIENT_BOOT_GLOBAL]
  const boot = parseGuardedVoiceClientBoot(raw)
  const controller = new VoiceClientController({ route: boot.route })
  const injected = (): VoiceInjected => ({
    hooks: { voice: controller },
    startVoice: sessionId => { controller.start(sessionId) },
    acceptDisclosure: sessionId => { controller.accept(sessionId) },
    stopVoice: sessionId => { controller.stop(sessionId) },
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'guarded-live-voice: browser dictionaries')
  ctx.effect(() => () => { controller.dispose() }, 'guarded-live-voice: browser cleanup')
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'guarded-live-voice',
    order: 30,
    locale: NS,
    inject: injected,
  }, VoiceControl))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'guarded-live-voice-disclosure',
    order: 30,
    locale: NS,
    inject: injected,
  }, VoicePanel))
}
