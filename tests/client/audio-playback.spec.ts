import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserPcmPlaybackSink } from '../../src/client/audio-playback.js'

class FakeBuffer {
  samples = new Float32Array(0)
  readonly copyToChannel = vi.fn((samples: Float32Array) => { this.samples = new Float32Array(samples) })
}

class FakeSource {
  buffer: AudioBuffer | null = null
  onended: (() => void) | null = null
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
  readonly start = vi.fn()
  readonly stop = vi.fn()
}

class FakePlaybackContext {
  state: AudioContextState = 'suspended'
  currentTime = 10
  readonly destination = {}
  readonly buffers: FakeBuffer[] = []
  readonly sources: FakeSource[] = []
  readonly resume = vi.fn(async () => { this.state = 'running' })
  readonly close = vi.fn(async () => { this.state = 'closed' })
  readonly createBuffer = vi.fn(() => {
    const buffer = new FakeBuffer()
    this.buffers.push(buffer)
    return buffer
  })
  readonly createBufferSource = vi.fn(() => {
    const source = new FakeSource()
    this.sources.push(source)
    return source
  })
}

function pcm(...samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  samples.forEach((sample, index) => { view.setInt16(index * 2, sample, true) })
  return bytes
}

describe('ordered PCM16 browser playback', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('requires gesture preparation, converts samples, and schedules chunks in order', async () => {
    const context = new FakePlaybackContext()
    const sink = new BrowserPcmPlaybackSink({
      createAudioContext: () => context as unknown as AudioContext,
    })
    expect(() => sink.write(pcm(1))).toThrow(/user gesture/u)
    await sink.prepare()
    expect(context.resume).toHaveBeenCalledTimes(1)
    context.state = 'suspended'
    await sink.prepare()
    expect(context.resume).toHaveBeenCalledTimes(2)

    sink.write(pcm(-32_768, 16_384))
    sink.write(pcm(0, 32_767))
    expect(context.sources.map(source => source.start.mock.calls[0]?.[0])).toEqual([
      10,
      10 + 2 / 24_000,
    ])
    expect(context.buffers[0]?.samples[0]).toBe(-1)
    expect(context.buffers[0]?.samples[1]).toBeCloseTo(0.5, 4)
    expect(Array.from(context.buffers[1]?.samples ?? [])).toEqual([0, 1])

    context.sources[0]?.onended?.()
    expect(context.sources[0]?.disconnect).toHaveBeenCalledTimes(1)
    sink.reset()
    expect(context.sources[0]?.stop).not.toHaveBeenCalled()
    expect(context.sources[1]?.stop).toHaveBeenCalledTimes(1)
    expect(context.sources[1]?.disconnect).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(() => sink.write(pcm(1))).toThrow(/user gesture/u)
  })

  it('fails closed before scheduling beyond the bounded playback queue', async () => {
    const context = new FakePlaybackContext()
    const sink = new BrowserPcmPlaybackSink({
      createAudioContext: () => context as unknown as AudioContext,
      maxQueueSeconds: 3 / 24_000,
    })
    await sink.prepare()
    sink.write(pcm(1, 2))
    expect(() => sink.write(pcm(3, 4))).toThrow('audio playback backpressure limit reached')
    expect(context.sources).toHaveLength(1)
    expect(() => sink.write(new Uint8Array([1]))).toThrow(/invalid PCM16/u)
  })

  it('recovers queue capacity after scheduled audio ends and the clock advances', async () => {
    const context = new FakePlaybackContext()
    const sink = new BrowserPcmPlaybackSink({
      createAudioContext: () => context as unknown as AudioContext,
      maxQueueSeconds: 3 / 24_000,
    })
    await sink.prepare()
    sink.write(pcm(1, 2))
    context.currentTime = 10 + 2 / 24_000
    context.sources[0]?.onended?.()
    expect(() => sink.write(pcm(3, 4))).not.toThrow()
    expect(context.sources[1]?.start).toHaveBeenCalledWith(10 + 2 / 24_000)
  })

  it('bounds live source objects when provider audio is pathologically fragmented', async () => {
    const context = new FakePlaybackContext()
    const sink = new BrowserPcmPlaybackSink({
      createAudioContext: () => context as unknown as AudioContext,
      maxQueueSources: 2,
    })
    await sink.prepare()
    sink.write(pcm(1))
    sink.write(pcm(2))
    expect(() => sink.write(pcm(3))).toThrow('audio playback backpressure limit reached')
    expect(context.sources).toHaveLength(2)

    context.sources[0]?.onended?.()
    expect(() => sink.write(pcm(4))).not.toThrow()
    expect(context.sources).toHaveLength(3)
  })

  it('sanitizes a scheduling failure and disconnects the partial source', async () => {
    const context = new FakePlaybackContext()
    const sink = new BrowserPcmPlaybackSink({
      createAudioContext: () => context as unknown as AudioContext,
    })
    await sink.prepare()
    const source = new FakeSource()
    source.start.mockImplementation(() => { throw new Error('device identifier must not escape') })
    context.createBufferSource.mockReturnValueOnce(source)
    expect(() => sink.write(pcm(1, 2))).toThrow('audio playback scheduling failed')
    expect(source.onended).toBeNull()
    expect(source.disconnect).toHaveBeenCalledTimes(1)
    sink.reset()
    expect(source.stop).not.toHaveBeenCalled()
  })

  it('cleans up an audio context reset while resume is still pending', async () => {
    let finishResume!: () => void
    const context = new FakePlaybackContext()
    context.resume.mockImplementation(() => new Promise<void>(resolve => { finishResume = resolve }))
    const sink = new BrowserPcmPlaybackSink({
      createAudioContext: () => context as unknown as AudioContext,
    })
    const prepare = sink.prepare()
    sink.reset()
    finishResume()
    await prepare
    expect(context.close).toHaveBeenCalledTimes(1)
    expect(() => sink.write(pcm(1))).toThrow(/user gesture/u)
  })

  it('cannot let a superseded resume failure close a newer playback context', async () => {
    let rejectResume!: (error: Error) => void
    const first = new FakePlaybackContext()
    first.resume.mockImplementation(() => new Promise<void>((_resolve, reject) => { rejectResume = reject }))
    const second = new FakePlaybackContext()
    const contexts = [first, second]
    const sink = new BrowserPcmPlaybackSink({
      createAudioContext: () => contexts.shift() as unknown as AudioContext,
    })

    const superseded = sink.prepare()
    sink.reset()
    await sink.prepare()
    rejectResume(new Error('late first-generation failure'))
    await expect(superseded).rejects.toThrow('audio playback could not start')

    expect(first.close).toHaveBeenCalledTimes(1)
    expect(second.close).not.toHaveBeenCalled()
    expect(() => sink.write(pcm(1))).not.toThrow()
    expect(second.sources).toHaveLength(1)
  })

  it('sanitizes playback startup failures and closes the partial context', async () => {
    const context = new FakePlaybackContext()
    context.resume.mockRejectedValue(new Error('device path must not escape'))
    const sink = new BrowserPcmPlaybackSink({
      createAudioContext: () => context as unknown as AudioContext,
    })
    await expect(sink.prepare()).rejects.toThrow('audio playback could not start')
    expect(context.close).toHaveBeenCalledTimes(1)
  })

  it('constructs the default browser AudioContext lazily at preparation', async () => {
    const context = new FakePlaybackContext()
    const construct = vi.fn(function AudioContextMock() { return context })
    vi.stubGlobal('AudioContext', construct)
    const sink = new BrowserPcmPlaybackSink()
    expect(construct).not.toHaveBeenCalled()
    await sink.prepare()
    expect(construct).toHaveBeenCalledTimes(1)
    sink.reset()
  })
})
