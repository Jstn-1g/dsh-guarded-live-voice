import { useLayoutEffect, type ReactNode } from 'react'
import type { VoiceControlProps, VoicePanelProps } from './contract.js'
import { VoiceControl } from './VoiceControl.js'
import { VoicePanel } from './VoicePanel.js'

interface SessionSeatProps {
  readonly sessionId: unknown
  readonly mountVoiceSession: (sessionId: string) => () => void
}

/** Stop the exact lifecycle when this strict session-scoped seat unmounts. */
function useVoiceSessionSeat({ sessionId, mountVoiceSession }: SessionSeatProps): void {
  useLayoutEffect(
    () => mountVoiceSession(String(sessionId)),
    [mountVoiceSession, sessionId],
  )
}

/** Session-scoped compact control with deterministic unmount cleanup. */
export function VoiceControlSeat(props: VoiceControlProps): ReactNode {
  useVoiceSessionSeat(props)
  return <VoiceControl {...props} />
}

/** Session-scoped disclosure panel with deterministic unmount cleanup. */
export function VoicePanelSeat(props: VoicePanelProps): ReactNode {
  useVoiceSessionSeat(props)
  return <VoicePanel {...props} />
}
