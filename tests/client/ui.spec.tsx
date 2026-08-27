import { isValidElement, type ReactElement, type ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { VoiceControl } from '../../src/client/VoiceControl.js'
import { VoicePanel } from '../../src/client/VoicePanel.js'
import type { VoiceClientSnapshot } from '../../src/client/controller.js'
import { en, type VoiceKey } from '../../src/client/locales.js'

function textOf(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (!isValidElement(node)) return ''
  return textOf((node.props as { readonly children?: ReactNode }).children)
}

function elements(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(elements)
  if (!isValidElement(node)) return []
  return [node, ...elements((node.props as { readonly children?: ReactNode }).children)]
}

function props(snapshot: VoiceClientSnapshot) {
  const setDraft = vi.fn()
  return {
    sessionId: 'session-1',
    useVoice: (selector: (value: VoiceClientSnapshot) => unknown) => selector(snapshot),
    startVoice: vi.fn(),
    acceptDisclosure: vi.fn(),
    stopVoice: vi.fn(),
    beginVoiceCapture: vi.fn(),
    finishVoiceCapture: vi.fn(),
    input: { draftRev: 7 },
    inputActions: { setDraft },
    setDraft,
    t: (key: VoiceKey) => en[key],
  }
}

describe('guarded voice composer surfaces', () => {
  it('renders the exact disclosure and accepts only through its explicit button', () => {
    const snapshot: VoiceClientSnapshot = {
      phase: 'awaiting-consent',
      sessionId: 'session-1',
      disclosure: {
        expiresAt: 1_900_000_060_000,
        workspaceId: 'workspace-1',
        audioDestination: 'Alibaba Cloud Qwen realtime API',
        exportedContext: 'none',
        executionAuthority: 'none',
        providerRetention: 'not specified for Qwen realtime audio',
        currentMilestone: 'one bounded manual audio turn after acceptance',
      },
    }
    const input = props(snapshot)
    const panel = VoicePanel(input as never)
    const text = textOf(panel)
    expect(text).toContain('Before voice is enabled')
    expect(text).toContain('Alibaba Cloud Qwen realtime API')
    expect(text).toContain('Not specified in the Qwen realtime-audio documentation')
    expect(text).toContain('One bounded manual turn after this acceptance')
    expect(text).toContain('session-1')
    expect(text).toContain('workspace-1')
    expect(text).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(input.acceptDisclosure).not.toHaveBeenCalled()

    const buttons = elements(panel).filter(element => element.type === 'button')
    const accept = buttons.find(button => textOf(button) === 'Continue setup')
    const cancel = buttons.find(button => textOf(button) === 'Cancel')
    expect(accept).toBeDefined()
    ;(accept?.props as { onClick(): void }).onClick()
    expect(input.acceptDisclosure).toHaveBeenCalledWith('session-1', 7)
    expect(input.startVoice).not.toHaveBeenCalled()
    expect(input.stopVoice).not.toHaveBeenCalled()
    ;(cancel?.props as { onClick(): void }).onClick()
    expect(input.stopVoice).toHaveBeenCalledWith('session-1')
  })

  it('renders nothing for another mounted session and keeps cancellation visible while waiting', () => {
    const other = props({ phase: 'connecting', sessionId: 'session-2' })
    expect(VoicePanel(other as never)).toBeNull()

    for (const phase of ['connecting', 'authorizing'] as const) {
      const snapshot: VoiceClientSnapshot = phase === 'connecting'
        ? { phase, sessionId: 'session-1' }
        : {
            phase,
            sessionId: 'session-1',
            disclosure: {
              expiresAt: 1_900_000_060_000,
              workspaceId: 'workspace-1',
              audioDestination: 'Alibaba Cloud Qwen realtime API',
              exportedContext: 'none',
              executionAuthority: 'none',
              providerRetention: 'not specified for Qwen realtime audio',
              currentMilestone: 'one bounded manual audio turn after acceptance',
            },
          }
      const input = props(snapshot)
      const panel = VoicePanel(input as never)
      const cancel = elements(panel).find(element => element.type === 'button' && textOf(element) === 'Cancel')
      expect(cancel).toBeDefined()
      ;(cancel?.props as { onClick(): void }).onClick()
      expect(input.stopVoice).toHaveBeenCalledWith('session-1')
    }
  })

  it('makes the compact control start, stop, and isolate sessions', () => {
    const idle = props({ phase: 'idle' })
    const idleControl = VoiceControl(idle as never)
    expect((idleControl.props as { disabled: boolean }).disabled).toBe(false)
    ;(idleControl.props as { onClick(): void }).onClick()
    expect(idle.startVoice).toHaveBeenCalledWith('session-1')

    const active = props({ phase: 'connecting', sessionId: 'session-1' })
    const activeControl = VoiceControl(active as never)
    expect((activeControl.props as { 'aria-pressed': boolean })['aria-pressed']).toBe(true)
    ;(activeControl.props as { onClick(): void }).onClick()
    expect(active.stopVoice).toHaveBeenCalledWith('session-1')

    const occupied = props({ phase: 'awaiting-consent', sessionId: 'session-2' })
    const occupiedControl = VoiceControl(occupied as never)
    expect((occupiedControl.props as { disabled: boolean }).disabled).toBe(true)

    const failedElsewhere = props({ phase: 'error', sessionId: 'session-2', error: 'setup failed' })
    const recoveredControl = VoiceControl(failedElsewhere as never)
    expect((recoveredControl.props as { disabled: boolean }).disabled).toBe(false)
    ;(recoveredControl.props as { onClick(): void }).onClick()
    expect(failedElsewhere.startVoice).toHaveBeenCalledWith('session-1')
  })

  it('starts microphone capture only through the exact ready-session button', () => {
    const input = props({
      phase: 'ready',
      sessionId: 'session-1',
      model: 'qwen-audio-3.0-realtime-plus',
      disclosure: {
        expiresAt: 1_900_000_060_000,
        workspaceId: 'workspace-1',
        audioDestination: 'Alibaba Cloud Qwen realtime API',
        exportedContext: 'none',
        executionAuthority: 'none',
        providerRetention: 'not specified for Qwen realtime audio',
        currentMilestone: 'one bounded manual audio turn after acceptance',
      },
    })
    const panel = VoicePanel(input as never)
    const text = textOf(panel)
    expect(text).toContain('Manual-turn transport ready')
    expect(text).toContain('Start one bounded microphone turn')
    const buttons = elements(panel).filter(element => element.type === 'button')
    const stop = buttons.find(button => textOf(button) === 'Close guarded voice setup')
    const record = buttons.find(button => textOf(button) === 'Start recording')
    ;(record?.props as { onClick(): void }).onClick()
    expect(input.beginVoiceCapture).toHaveBeenCalledWith('session-1')
    expect(input.finishVoiceCapture).not.toHaveBeenCalled()
    ;(stop?.props as { onClick(): void }).onClick()
    expect(input.stopVoice).toHaveBeenCalledWith('session-1')
  })

  it('keeps permission cancellation visible and commits recording only through its explicit button', () => {
    const disclosure = {
      expiresAt: 1_900_000_060_000,
      workspaceId: 'workspace-1',
      audioDestination: 'Alibaba Cloud Qwen realtime API' as const,
      exportedContext: 'none' as const,
      executionAuthority: 'none' as const,
      providerRetention: 'not specified for Qwen realtime audio' as const,
      currentMilestone: 'one bounded manual audio turn after acceptance' as const,
    }
    const preparing = props({ phase: 'preparing-audio', sessionId: 'session-1', disclosure })
    const preparingPanel = VoicePanel(preparing as never)
    expect(textOf(preparingPanel)).toContain('Waiting for microphone permission')
    const cancel = elements(preparingPanel).find(element => element.type === 'button')
    ;(cancel?.props as { onClick(): void }).onClick()
    expect(preparing.stopVoice).toHaveBeenCalledWith('session-1')

    const recording = props({ phase: 'recording', sessionId: 'session-1', disclosure })
    const recordingPanel = VoicePanel(recording as never)
    expect(textOf(recordingPanel)).toContain('This cannot submit the Harness composer or run tools')
    const finish = elements(recordingPanel)
      .find(element => element.type === 'button' && textOf(element) === 'Finish and request answer')
    ;(finish?.props as { onClick(): void }).onClick()
    expect(recording.finishVoiceCapture).toHaveBeenCalledWith('session-1')
  })

  it('keeps a failed setup inert and offers only dismiss or retry', () => {
    const input = props({ phase: 'error', sessionId: 'session-1', error: '<script>not markup</script>' })
    const panel = VoicePanel(input as never)
    expect(textOf(panel)).toContain('<script>not markup</script>')
    const buttons = elements(panel).filter(element => element.type === 'button')
    expect(buttons.map(textOf)).toEqual(['Dismiss', 'Try again'])
    ;(buttons[0]?.props as { onClick(): void }).onClick()
    ;(buttons[1]?.props as { onClick(): void }).onClick()
    expect(input.stopVoice).toHaveBeenCalledWith('session-1')
    expect(input.startVoice).toHaveBeenCalledWith('session-1')
    expect(input.acceptDisclosure).not.toHaveBeenCalled()
  })

  it('offers only a conflict-fenced, completed assistant transcript as an editable draft', () => {
    const disclosure = {
      expiresAt: 1_900_000_060_000,
      workspaceId: 'workspace-1',
      audioDestination: 'Alibaba Cloud Qwen realtime API' as const,
      exportedContext: 'none' as const,
      executionAuthority: 'none' as const,
      providerRetention: 'not specified for Qwen realtime audio' as const,
      currentMilestone: 'one bounded manual audio turn after acceptance' as const,
    }
    const completed = props({
      phase: 'completed',
      sessionId: 'session-1',
      disclosure,
      model: 'qwen-audio-3.0-realtime-plus',
      userTranscript: 'question',
      userTranscriptFinal: true,
      assistantTranscript: 'proposed answer',
      assistantTranscriptFinal: true,
      turnStatus: 'completed',
      draftRevision: 7,
    })
    const completedPanel = VoicePanel(completed as never)
    const useDraft = elements(completedPanel)
      .find(element => element.type === 'button' && textOf(element) === 'Use assistant text as draft')
    expect(useDraft).toBeDefined()
    expect((useDraft?.props as { disabled: boolean }).disabled).toBe(false)
    ;(useDraft?.props as { onClick(): void }).onClick()
    expect(completed.setDraft).toHaveBeenCalledWith('proposed answer')

    const conflict = props({
      phase: 'completed',
      sessionId: 'session-1',
      disclosure,
      assistantTranscript: 'stale answer',
      assistantTranscriptFinal: true,
      turnStatus: 'completed',
      draftRevision: 6,
    })
    const conflictPanel = VoicePanel(conflict as never)
    expect(textOf(conflictPanel)).toContain('The composer changed after voice consent')
    const blocked = elements(conflictPanel)
      .find(element => element.type === 'button' && textOf(element) === 'Use assistant text as draft')
    expect((blocked?.props as { disabled: boolean }).disabled).toBe(true)
    ;(blocked?.props as { onClick(): void }).onClick()
    expect(conflict.setDraft).not.toHaveBeenCalled()

    const cancelled = props({
      phase: 'completed',
      sessionId: 'session-1',
      disclosure,
      assistantTranscript: 'partial answer',
      assistantTranscriptFinal: true,
      turnStatus: 'cancelled',
      draftRevision: 7,
    })
    expect(elements(VoicePanel(cancelled as never))
      .some(element => element.type === 'button' && textOf(element) === 'Use assistant text as draft')).toBe(false)
  })
})
