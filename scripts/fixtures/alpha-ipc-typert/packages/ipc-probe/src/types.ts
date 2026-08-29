/** Disclosure receipt for one exact synthetic Session binding. */
export interface IpcConsentReceipt {
  readonly connectionId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly challenge: string
  readonly expiresAt: number
}

/** Provider-ready receipt; no credential or exported Harness context crosses this boundary. */
export interface IpcReadyReceipt {
  readonly connectionId: string
  readonly sessionId: string
  readonly workspaceId: string
  readonly provider: 'qwen'
  readonly model: string
}

/** One canonical base64 PCM16 input frame. */
export interface IpcPcm16Frame {
  readonly sequence: number
  readonly pcm16Base64: string
}

/** Bounded acknowledgement for one accepted input frame. */
export interface IpcAppendReceipt {
  readonly acceptedBytes: number
  readonly turnBytes: number
  readonly nextSequence: number
}

/** Bounded completion receipt for one control operation. */
export interface IpcControlReceipt {
  readonly stopped: boolean
}

export type IpcVoiceEvent =
  | {
      readonly sequence: number
      readonly type: 'transcript'
      readonly role: 'user' | 'assistant'
      readonly text: string
      readonly final: boolean
    }
  | {
      readonly sequence: number
      readonly type: 'audio'
      readonly pcm24Base64: string
    }
  | {
      readonly sequence: number
      readonly type: 'done'
      readonly status: 'completed' | 'cancelled'
    }
