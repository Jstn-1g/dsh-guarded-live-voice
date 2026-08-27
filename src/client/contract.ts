import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { VoiceClientSnapshot } from './controller.js'
import type { NS } from './locales.js'

export interface VoiceInjected {
  readonly hooks: { readonly voice: HostObservable<VoiceClientSnapshot> }
  readonly startVoice: (sessionId: string) => void
  readonly acceptDisclosure: (sessionId: string, draftRevision: number) => void
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
