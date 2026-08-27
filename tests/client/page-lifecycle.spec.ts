import { describe, expect, it, vi } from 'vitest'
import { bindPageLifecycleCleanup } from '../../src/client/page-lifecycle.js'

describe('browser page lifecycle cleanup', () => {
  it('runs restartable cleanup for each raw pagehide and removes the listener during plugin disposal', () => {
    const target = new EventTarget()
    const removeEventListener = vi.spyOn(target, 'removeEventListener')
    const pagehideCleanup = vi.fn()
    const pluginCleanup = vi.fn()
    const dispose = bindPageLifecycleCleanup(target, pagehideCleanup, pluginCleanup)

    target.dispatchEvent(new Event('pagehide'))
    target.dispatchEvent(new Event('pagehide'))
    expect(pagehideCleanup).toHaveBeenCalledTimes(2)
    expect(pluginCleanup).not.toHaveBeenCalled()

    dispose()
    expect(removeEventListener).toHaveBeenCalledTimes(1)
    expect(pluginCleanup).toHaveBeenCalledTimes(1)
    target.dispatchEvent(new Event('pagehide'))
    expect(pagehideCleanup).toHaveBeenCalledTimes(2)
  })

  it('keeps irreversible plugin cleanup one-shot even after document cleanup', () => {
    const target = new EventTarget()
    const pagehideCleanup = vi.fn()
    const pluginCleanup = vi.fn()
    const dispose = bindPageLifecycleCleanup(target, pagehideCleanup, pluginCleanup)

    target.dispatchEvent(new Event('pagehide'))
    dispose()
    dispose()
    target.dispatchEvent(new Event('pagehide'))
    expect(pagehideCleanup).toHaveBeenCalledTimes(1)
    expect(pluginCleanup).toHaveBeenCalledTimes(1)
  })
})
