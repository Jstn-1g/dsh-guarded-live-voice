import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { CLIENT_BOOT_GLOBAL, parseGuardedVoiceClientBoot } from '../shared/boot.js'
import { BrowserPcmCapture } from './audio-capture.js'
import { BrowserPcmPlaybackSink } from './audio-playback.js'
import { VoiceClientController } from './controller.js'
import type { VoiceInjected } from './contract.js'
import { en, NS, zh, type VoiceKey } from './locales.js'
import { bindPageLifecycleCleanup } from './page-lifecycle.js'
import { SyntheticDemoCapture } from './synthetic-demo-capture.js'
import { VoiceControlSeat, VoicePanelSeat } from './VoiceSeats.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DSH Live Voice disclosure and setup copy. */
    guardedVoice: VoiceKey
  }
}

/** Browser services required by the two DSH Live Voice slot contributions. */
export const inject = ['slots', 'locale']

/** Mount the user-visible, exact-session disclosure flow. */
export function apply(ctx: ClientContext): void {
  const raw = (globalThis as Record<string, unknown>)[CLIENT_BOOT_GLOBAL]
  const boot = parseGuardedVoiceClientBoot(raw)
  const controller = new VoiceClientController({
    route: boot.route,
    audioSink: new BrowserPcmPlaybackSink(),
    captureFactory: (handlers, provider) => provider === 'synthetic-demo'
      ? new SyntheticDemoCapture(handlers)
      : new BrowserPcmCapture(handlers),
  })
  const injected = (): VoiceInjected => ({
    hooks: { voice: controller },
    getVoiceSnapshot: controller.getSnapshot,
    mountVoiceSession: controller.mountSession,
    startVoice: sessionId => { controller.start(sessionId) },
    acceptDisclosure: (sessionId, draftRevision, composerIdentity) => {
      controller.accept(sessionId, draftRevision, composerIdentity)
    },
    isComposerBindingCurrent: (sessionId, composerIdentity) =>
      controller.isComposerBindingCurrent(sessionId, composerIdentity),
    claimVoiceDraftHandoff: (sessionId, composerIdentity, draftRevision) =>
      controller.claimDraftHandoff(sessionId, composerIdentity, draftRevision),
    stopVoice: sessionId => { controller.stop(sessionId) },
    appendVoicePcm16: (sessionId, chunk) => { controller.appendPcm16(sessionId, chunk) },
    commitVoiceTurn: sessionId => { controller.commitTurn(sessionId) },
    beginVoiceCapture: sessionId => { controller.beginCapture(sessionId) },
    finishVoiceCapture: sessionId => { controller.finishCapture(sessionId) },
  })

  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-live-voice: browser dictionaries')
  ctx.effect(
    () => bindPageLifecycleCleanup(
      window,
      () => { controller.stop() },
      () => { controller.dispose() },
    ),
    'dsh-live-voice: browser and document cleanup',
  )
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
    name: 'conversation.input.left',
    id: 'guarded-live-voice',
    order: 30,
    locale: NS,
    inject: injected,
  }, VoiceControlSeat))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'guarded-live-voice-disclosure',
    order: 30,
    locale: NS,
    inject: injected,
  }, VoicePanelSeat))
}
