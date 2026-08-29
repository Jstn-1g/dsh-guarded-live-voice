import { sessionIdOf, type VoicePanelProps } from './contract.js'
import css from './voice.module.css'

/** User-visible disclosure and setup result; it never receives the bearer challenge. */
export function VoicePanel(props: VoicePanelProps) {
  const {
    useVoice, startVoice, acceptDisclosure, stopVoice,
    beginVoiceCapture, finishVoiceCapture, getVoiceSnapshot,
    isComposerBindingCurrent, claimVoiceDraftHandoff, inputActions, input, t,
  } = props
  const sessionId = sessionIdOf(props)
  const voice = useVoice(snapshot => snapshot)
  if (voice.sessionId !== String(sessionId) || voice.phase === 'idle') return null

  if (voice.phase === 'connecting') {
    return (
      <section className={css.panel} role="status">
        <span>{t('panel.connecting')}</span>
        <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
          {t('panel.cancel')}
        </button>
      </section>
    )
  }

  if (voice.phase === 'error') {
    return (
      <section className={`${css.panel} ${css.panelError}`} role="alert">
        <div className={css.panelHeading}>{t('panel.error')}</div>
        <p className={css.detail}>{voice.error}</p>
        <div className={css.actions}>
          <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
            {t('panel.dismiss')}
          </button>
          <button type="button" className={css.primaryButton} onClick={() => { startVoice(String(sessionId)) }}>
            {t('panel.retry')}
          </button>
        </div>
      </section>
    )
  }

  const disclosure = voice.disclosure
  if (disclosure === undefined) return null

  if (voice.phase === 'authorizing') {
    return (
      <section className={css.panel} role="status">
        <span>{t('panel.authorizing')}</span>
        <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
          {t('panel.cancel')}
        </button>
      </section>
    )
  }

  if (voice.phase === 'ready') {
    return (
      <section className={`${css.panel} ${css.panelReady}`} role="status">
        <div className={css.panelHeading}>{t('panel.ready')}</div>
        <p className={css.detail}>{t('panel.readyDetail')}</p>
        <p className={css.meta}>{voice.model}</p>
        <div className={css.actions}>
          <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
            {t('control.stop')}
          </button>
          <button type="button" className={css.primaryButton} onClick={() => { beginVoiceCapture(String(sessionId)) }}>
            {t('panel.record')}
          </button>
        </div>
      </section>
    )
  }

  if (voice.phase === 'preparing-audio') {
    return (
      <section className={css.panel} role="status">
        <div className={css.panelHeading}>{t('panel.preparingAudio')}</div>
        <p className={css.detail}>{t('panel.permissionDetail')}</p>
        <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
          {t('panel.cancel')}
        </button>
      </section>
    )
  }

  if (voice.phase === 'recording') {
    return (
      <section className={`${css.panel} ${css.panelRecording}`} role="status">
        <div className={css.panelHeading}>{t('panel.recording')}</div>
        <p className={css.detail}>{t('panel.recordingDetail')}</p>
        <div className={css.actions}>
          <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
            {t('panel.cancel')}
          </button>
          <button type="button" className={css.primaryButton} onClick={() => { finishVoiceCapture(String(sessionId)) }}>
            {t('panel.finishTurn')}
          </button>
        </div>
      </section>
    )
  }

  if (voice.phase === 'responding' || voice.phase === 'completed') {
    const composerBindingCurrent = isComposerBindingCurrent(String(sessionId), inputActions)
    const draftConflict = (voice.draftRevision !== undefined && input.draftRev !== voice.draftRevision)
      || !composerBindingCurrent
    return (
      <section className={`${css.panel} ${voice.phase === 'completed' ? css.panelReady : ''}`} role="status">
        <div className={css.panelHeading}>
          {t(voice.phase === 'completed' ? 'panel.completed' : 'panel.responding')}
        </div>
        <dl className={css.transcripts}>
          <div>
            <dt>{t('panel.userTranscript')}</dt>
            <dd>{voice.userTranscript ?? ''}</dd>
          </div>
          <div>
            <dt>{t('panel.assistantTranscript')}</dt>
            <dd>{voice.assistantTranscript ?? ''}</dd>
          </div>
        </dl>
        {draftConflict ? <p className={css.detail}>{t('panel.draftConflict')}</p> : null}
        <div className={css.actions}>
          <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
            {t('control.stop')}
          </button>
          {voice.phase === 'completed'
            && voice.turnStatus === 'completed'
            && voice.userTranscriptFinal === true
            && voice.userTranscript !== undefined
            && voice.userTranscript.trim() !== ''
            && voice.draftRevision !== undefined
            ? (
                <button
                  type="button"
                  className={css.primaryButton}
                  disabled={input.draftRev !== voice.draftRevision || !composerBindingCurrent}
                  title={input.draftRev === voice.draftRevision && composerBindingCurrent
                    ? undefined
                    : t('panel.draftConflict')}
                  onClick={() => {
                    const current = getVoiceSnapshot()
                    if (current.phase === 'completed'
                      && current.sessionId === String(sessionId)
                      && current.turnStatus === 'completed'
                      && current.userTranscriptFinal === true
                      && current.userTranscript !== undefined
                      && current.userTranscript.trim() !== ''
                      && current.userTranscript === voice.userTranscript
                      && current.draftRevision === voice.draftRevision
                      && input.draftRev === current.draftRevision
                      && claimVoiceDraftHandoff(
                        String(sessionId),
                        inputActions,
                        current.draftRevision,
                      )) {
                      inputActions.setDraft(current.userTranscript)
                    }
                  }}
                >
                  {t('panel.useUserAsDraft')}
                </button>
              )
            : null}
        </div>
      </section>
    )
  }

  return (
    <section className={css.panel} aria-label={t('panel.title')}>
      <div className={css.eyebrow}>{t('panel.preview')}</div>
      <h3 className={css.panelHeading}>{t('panel.title')}</h3>
      <dl className={css.disclosureGrid}>
        <div><dt>{t('panel.destination')}</dt><dd>{disclosure.audioDestination}</dd></div>
        <div><dt>{t('panel.context')}</dt><dd>{t('panel.none')}</dd></div>
        <div><dt>{t('panel.authority')}</dt><dd>{t('panel.proposalOnly')}</dd></div>
        <div><dt>{t('panel.retention')}</dt><dd>{t('panel.retentionUnknown')}</dd></div>
        <div><dt>{t('panel.milestone')}</dt><dd>{t('panel.noAudio')}</dd></div>
      </dl>
      <div className={css.binding}>
        <span>{t('panel.session')}: <code>{voice.sessionId}</code></span>
        <span>{t('panel.workspace')}: <code>{disclosure.workspaceId}</code></span>
        <span>{t('panel.expires')}: <time dateTime={new Date(disclosure.expiresAt).toISOString()}>{new Date(disclosure.expiresAt).toLocaleTimeString()}</time></span>
      </div>
      <div className={css.actions}>
        <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
          {t('panel.cancel')}
        </button>
        <button type="button" className={css.primaryButton} onClick={() => {
          acceptDisclosure(String(sessionId), input.draftRev, inputActions)
        }}>
          {t('panel.accept')}
        </button>
      </div>
    </section>
  )
}
