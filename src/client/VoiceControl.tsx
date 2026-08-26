import type { VoiceControlProps } from './contract.js'
import css from './voice.module.css'

/** Compact guarded-voice control inside the composer tool row. */
export function VoiceControl({ sessionId, useVoice, startVoice, stopVoice, t }: VoiceControlProps) {
  const voice = useVoice(snapshot => snapshot)
  const here = voice.sessionId === String(sessionId)
  const occupiedElsewhere = voice.phase !== 'idle' && voice.phase !== 'error' && !here
  const active = here && voice.phase !== 'idle' && voice.phase !== 'error'
  const label = occupiedElsewhere
    ? t('control.otherSession')
    : active ? t('control.stop') : t('control.start')

  return (
    <button
      type="button"
      className={`${css.voiceButton} ${active ? css.voiceButtonActive : ''}`}
      aria-label={label}
      aria-pressed={active}
      title={label}
      disabled={occupiedElsewhere}
      data-state={here ? voice.phase : 'idle'}
      onClick={() => {
        if (active) stopVoice(String(sessionId))
        else startVoice(String(sessionId))
      }}
    >
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <rect x="5" y="2" width="6" height="8" rx="3" fill="none" stroke="currentColor" strokeWidth="1.4" />
        <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2M5.5 14h5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      </svg>
    </button>
  )
}
