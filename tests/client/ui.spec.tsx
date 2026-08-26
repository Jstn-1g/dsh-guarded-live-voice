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
  return {
    sessionId: 'session-1',
    useVoice: (selector: (value: VoiceClientSnapshot) => unknown) => selector(snapshot),
    startVoice: vi.fn(),
    acceptDisclosure: vi.fn(),
    stopVoice: vi.fn(),
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
        currentMilestone: 'no microphone access or audio transmission',
      },
    }
    const input = props(snapshot)
    const panel = VoicePanel(input as never)
    const text = textOf(panel)
    expect(text).toContain('Before voice is enabled')
    expect(text).toContain('Alibaba Cloud Qwen realtime API')
    expect(text).toContain('Not specified in the Qwen realtime-audio documentation')
    expect(text).toContain('No microphone access and no audio transmission')
    expect(text).toContain('session-1')
    expect(text).toContain('workspace-1')
    expect(text).not.toContain('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(input.acceptDisclosure).not.toHaveBeenCalled()

    const buttons = elements(panel).filter(element => element.type === 'button')
    const accept = buttons.find(button => textOf(button) === 'Continue setup')
    const cancel = buttons.find(button => textOf(button) === 'Cancel')
    expect(accept).toBeDefined()
    ;(accept?.props as { onClick(): void }).onClick()
    expect(input.acceptDisclosure).toHaveBeenCalledWith('session-1')
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
              currentMilestone: 'no microphone access or audio transmission',
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

  it('describes ready as a configuration check rather than a provider connection', () => {
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
        currentMilestone: 'no microphone access or audio transmission',
      },
    })
    const panel = VoicePanel(input as never)
    const text = textOf(panel)
    expect(text).toContain('Provider configuration found')
    expect(text).toContain('No provider connection was opened')
    const stop = elements(panel).find(element => element.type === 'button')
    ;(stop?.props as { onClick(): void }).onClick()
    expect(input.stopVoice).toHaveBeenCalledWith('session-1')
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
})
