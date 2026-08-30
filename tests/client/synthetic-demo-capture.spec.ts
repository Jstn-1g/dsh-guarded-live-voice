import { describe, expect, it, vi } from 'vitest'
import { SyntheticDemoCapture } from '../../src/client/synthetic-demo-capture.js'

describe('SyntheticDemoCapture', () => {
  it('emits one deterministic bounded PCM16 frame without a microphone', async () => {
    const onChunk = vi.fn()
    const capture = new SyntheticDemoCapture({
      onChunk,
      onLimit: vi.fn(),
      onError: vi.fn(),
    })

    await expect(capture.start()).resolves.toBeUndefined()
    expect(onChunk).toHaveBeenCalledOnce()
    const first = onChunk.mock.calls[0]?.[0] as Uint8Array
    expect(first).toBeInstanceOf(Uint8Array)
    expect(first.byteLength).toBe(3_200)
    expect(first.byteLength % 2).toBe(0)
    expect(first.some(value => value !== 0)).toBe(true)

    const secondSource = vi.fn()
    await new SyntheticDemoCapture({
      onChunk: secondSource,
      onLimit: vi.fn(),
      onError: vi.fn(),
    }).start()
    expect(secondSource.mock.calls[0]?.[0]).toEqual(first)
  })

  it('cannot restart after start or stop', async () => {
    const handlers = { onChunk: vi.fn(), onLimit: vi.fn(), onError: vi.fn() }
    const started = new SyntheticDemoCapture(handlers)
    await started.start()
    await expect(started.start()).rejects.toThrow(/cannot be restarted/u)

    const stopped = new SyntheticDemoCapture(handlers)
    stopped.stop()
    await expect(stopped.start()).rejects.toThrow(/cannot be restarted/u)
  })
})
