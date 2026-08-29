import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceClientSnapshot } from './controller.js'
import type { NS } from './locales.js'

export interface VoiceInjected {
  readonly hooks: { readonly voice: HostObservable<VoiceClientSnapshot> }
  /** Read the current lifecycle again at an explicit handoff gesture. */
  readonly getVoiceSnapshot: () => VoiceClientSnapshot
  /** Retain one rendered exact-Session seat until its React unmount. */
  readonly mountVoiceSession: (sessionId: string) => () => void
  readonly startVoice: (sessionId: string) => void
  /** Capture the stable, opaque composer action identity at consent. */
  readonly acceptDisclosure: (sessionId: string, draftRevision: number, composerIdentity: object) => void
  /** Compare the live composer with the identity captured at consent. */
  readonly isComposerBindingCurrent: (sessionId: string, composerIdentity: object) => boolean
  /** Consume the accepted binding immediately before a single draft write. */
  readonly claimVoiceDraftHandoff: (
    sessionId: string,
    composerIdentity: object,
    draftRevision: number,
  ) => boolean
  readonly stopVoice: (sessionId: string) => void
  readonly appendVoicePcm16: (sessionId: string, chunk: Uint8Array) => void
  readonly commitVoiceTurn: (sessionId: string) => void
  readonly beginVoiceCapture: (sessionId: string) => void
  readonly finishVoiceCapture: (sessionId: string) => void
}

export type VoiceControlProps =
  PropsRuntime<'conversation.input.left'> & InjectFace<VoiceInjected> & PropsLocale<typeof NS>

export type VoicePanelProps =
  PropsRuntime<'conversation.input.dock'> & InjectFace<VoiceInjected> & PropsLocale<typeof NS>
