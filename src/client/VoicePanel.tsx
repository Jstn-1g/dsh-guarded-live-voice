import type { VoicePanelProps } from './contract.js'
import css from './voice.module.css'

/** User-visible disclosure and setup result; it never receives the bearer challenge. */
export function VoicePanel({
  sessionId, useVoice, startVoice, acceptDisclosure, stopVoice, t,
}: VoicePanelProps) {
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
        <button type="button" className={css.secondaryButton} onClick={() => { stopVoice(String(sessionId)) }}>
          {t('control.stop')}
        </button>
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
        <button type="button" className={css.primaryButton} onClick={() => { acceptDisclosure(String(sessionId)) }}>
          {t('panel.accept')}
        </button>
      </div>
    </section>
  )
}
