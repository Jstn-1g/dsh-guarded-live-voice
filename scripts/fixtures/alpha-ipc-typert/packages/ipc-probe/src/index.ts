import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {
  IpcAppendReceipt,
  IpcConsentReceipt,
  IpcControlReceipt,
  IpcPcm16Frame,
  IpcReadyReceipt,
  IpcVoiceEvent,
} from './types.ts'

/** Generator-only shape; the exact-alpha smoke supplies the live Host implementation. */
export class IpcVoiceProbeService extends TypertRemoteService {
  constructor() {
    super(undefined, 'ipcVoiceProbe')
  }

  @Remote
  begin(sessionId: string): Promise<IpcConsentReceipt> {
    void sessionId
    throw new Error('generator-only Remote declaration')
  }

  @Remote
  accept(connectionId: string, challenge: string): Promise<IpcReadyReceipt> {
    void connectionId
    void challenge
    throw new Error('generator-only Remote declaration')
  }

  @Remote
  append(connectionId: string, frame: IpcPcm16Frame): Promise<IpcAppendReceipt> {
    void connectionId
    void frame
    throw new Error('generator-only Remote declaration')
  }

  @Remote
  commit(connectionId: string): Promise<IpcControlReceipt> {
    void connectionId
    throw new Error('generator-only Remote declaration')
  }

  @Remote
  stop(connectionId: string): Promise<IpcControlReceipt> {
    void connectionId
    throw new Error('generator-only Remote declaration')
  }

  @Remote({ mode: 'stream' })
  events(connectionId: string, signal: AbortSignal): AsyncIterable<IpcVoiceEvent> {
    void connectionId
    void signal
    throw new Error('generator-only Remote declaration')
  }
}

export type {
  IpcAppendReceipt,
  IpcConsentReceipt,
  IpcControlReceipt,
  IpcPcm16Frame,
  IpcReadyReceipt,
  IpcVoiceEvent,
} from './types.ts'
