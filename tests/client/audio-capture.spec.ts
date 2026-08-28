import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserPcmCapture,
  StreamingPcm16Encoder,
  type CaptureProcessor,
} from '../../src/client/audio-capture.js'

class FakeNode {
  readonly connect = vi.fn()
  readonly disconnect = vi.fn()
}

class FakeContext {
  state: AudioContextState = 'suspended'
  readonly sampleRate = 48_000
  readonly destination = new FakeNode()
  readonly audioWorklet = { addModule: vi.fn(() => Promise.resolve()) }
  readonly source = new FakeNode()
  readonly resume = vi.fn(async () => { this.state = 'running' })
  readonly close = vi.fn(async () => { this.state = 'closed' })
  readonly createMediaStreamSource = vi.fn(() => this.source)
}

class FakeWorkletNode extends FakeNode {
  static readonly instances: FakeWorkletNode[] = []
  readonly port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    onmessageerror: null as (() => void) | null,
    close: vi.fn(),
  }
  onprocessorerror: (() => void) | null = null
  readonly name: string
  readonly options: AudioWorkletNodeOptions

  constructor(_context: AudioContext, name: string, options: AudioWorkletNodeOptions) {
    super()
    this.name = name
    this.options = options
    FakeWorkletNode.instances.push(this)
  }
}

class FakeProcessor implements CaptureProcessor {
  readonly node = new FakeNode() as unknown as AudioNode
  readonly dispose = vi.fn()
  private samples: ((channels: readonly Float32Array[]) => void) | undefined

  bind(samples: (channels: readonly Float32Array[]) => void): void {
    this.samples = samples
  }

  process(...channels: Float32Array[]): void {
    this.samples?.(channels)
  }
}

function pcmValues(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return Array.from({ length: bytes.byteLength / 2 }, (_, index) => view.getInt16(index * 2, true))
}

function captureFixture(options: {
  readonly media?: Promise<MediaStream>
  readonly processorResult?: Promise<CaptureProcessor>
  readonly frameBytes?: number
  readonly maxTurnBytes?: number
  readonly onChunk?: (chunk: Uint8Array) => void
} = {}) {
  const context = new FakeContext()
  const processor = new FakeProcessor()
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  const chunks: Uint8Array[] = []
  const onLimit = vi.fn()
  const onError = vi.fn()
  const getUserMedia = vi.fn(() => options.media ?? Promise.resolve(stream))
  const capture = new BrowserPcmCapture({
    mediaDevices: { getUserMedia } as Pick<MediaDevices, 'getUserMedia'>,
    createAudioContext: () => context as unknown as AudioContext,
    createProcessor: async (_context, onSamples) => {
      processor.bind(onSamples)
      return options.processorResult ?? processor
    },
    frameBytes: options.frameBytes ?? 8,
    maxTurnBytes: options.maxTurnBytes ?? 32,
    onChunk: options.onChunk ?? (chunk => { chunks.push(chunk) }),
    onLimit,
    onError,
  })
  return { capture, context, processor, track, stream, chunks, onLimit, onError, getUserMedia }
}

describe('browser PCM16 microphone capture', () => {
  afterEach(() => {
    FakeWorkletNode.instances.splice(0)
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resamples continuously across callback boundaries, downmixes, and clamps PCM16', () => {
    const source = Float32Array.from({ length: 12 }, (_, index) => (index - 6) / 6)
    const whole = new StreamingPcm16Encoder(48_000)
    const wholeBytes = new Uint8Array([
      ...whole.push([source]),
      ...whole.finish(),
    ])
    const split = new StreamingPcm16Encoder(48_000)
    const splitBytes = new Uint8Array([
      ...split.push([source.slice(0, 5)]),
      ...split.push([source.slice(5, 9)]),
      ...split.push([source.slice(9)]),
      ...split.finish(),
    ])
    expect(splitBytes).toEqual(wholeBytes)
    expect(pcmValues(wholeBytes)).toHaveLength(4)

    const stereo = new StreamingPcm16Encoder(16_000)
    expect(pcmValues(new Uint8Array([
      ...stereo.push([new Float32Array([-2, 1]), new Float32Array([0, 1])]),
      ...stereo.finish(),
    ]))).toEqual([-32_768, 32_767])
    expect(() => new StreamingPcm16Encoder(0)).toThrow(/sample rates/u)
    expect(() => new StreamingPcm16Encoder(16_000).push([
      new Float32Array(1), new Float32Array(2),
    ])).toThrow(/channel lengths/u)
  })

  it('emits the exact duration count at 44.1 kHz without duplicating the endpoint', () => {
    const source = new Float32Array(44_100)
    source[source.length - 1] = 1
    const encoder = new StreamingPcm16Encoder(44_100)
    const bytes: number[] = []
    for (let offset = 0; offset < source.length; offset += 128) {
      bytes.push(...encoder.push([source.slice(offset, offset + 128)]))
    }
    bytes.push(...encoder.finish())
    const output = new Uint8Array(bytes)
    expect(output.byteLength).toBe(16_000 * 2)
    expect(pcmValues(output).every(sample => sample === 0)).toBe(true)

    const upsample = new StreamingPcm16Encoder(8_000)
    expect(pcmValues(new Uint8Array([
      ...upsample.push([new Float32Array([1])]),
      ...upsample.finish(),
    ]))).toEqual([32_767, 32_767])
  })

  it('reports permission denial without leaking the browser exception and closes audio', async () => {
    const denied = Object.assign(new Error('device identifiers must stay private'), { name: 'NotAllowedError' })
    const f = captureFixture({ media: Promise.reject(denied) })
    await expect(f.capture.start()).rejects.toThrow('microphone permission was denied')
    expect(f.context.resume).toHaveBeenCalledTimes(1)
    expect(f.context.close).toHaveBeenCalledTimes(1)
    expect(f.chunks).toEqual([])
    f.capture.stop()
    expect(f.context.close).toHaveBeenCalledTimes(1)
  })

  it('fails safely through the default browser dependency checks', async () => {
    const unavailableContext = new FakeContext()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('AudioContext', class {
      constructor() { return unavailableContext }
    })
    const noMedia = new BrowserPcmCapture({
      onChunk: vi.fn(),
      onLimit: vi.fn(),
      onError: vi.fn(),
    })
    await expect(noMedia.start()).rejects.toThrow('microphone capture is unavailable in this browser')
    expect(unavailableContext.close).toHaveBeenCalledTimes(1)

    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn() } })
    vi.stubGlobal('AudioContext', undefined)
    vi.stubGlobal('webkitAudioContext', undefined)
    const noAudio = new BrowserPcmCapture({
      onChunk: vi.fn(),
      onLimit: vi.fn(),
      onError: vi.fn(),
    })
    await expect(noAudio.start()).rejects.toThrow('browser audio is unavailable')
  })

  it('emits only capped resampled frames, stops at the turn cap, and owns cleanup', async () => {
    const f = captureFixture({ frameBytes: 4, maxTurnBytes: 8 })
    await f.capture.start()
    expect(f.getUserMedia).toHaveBeenCalledWith({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    })
    f.processor.process(new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75]))
    f.processor.process(new Float32Array([0.5, 0.25, 0, -0.25, -0.5, -0.75]))
    expect(f.chunks.map(chunk => chunk.byteLength)).toEqual([4, 4])
    expect(f.chunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBe(8)
    expect(f.onLimit).toHaveBeenCalledTimes(1)
    expect(f.onError).not.toHaveBeenCalled()
    expect(f.context.source.disconnect).toHaveBeenCalledTimes(1)
    expect(f.processor.dispose).toHaveBeenCalledTimes(1)
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.context.close).toHaveBeenCalledTimes(1)

    f.capture.stop()
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.onLimit).toHaveBeenCalledTimes(1)
  })

  it('releases a late permission result after cancellation and never installs a processor', async () => {
    let resolveMedia!: (stream: MediaStream) => void
    const media = new Promise<MediaStream>(resolve => { resolveMedia = resolve })
    const f = captureFixture({ media })
    const start = f.capture.start()
    f.capture.stop(false)
    resolveMedia(f.stream)
    await start
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.context.close).toHaveBeenCalledTimes(1)
    expect(f.context.createMediaStreamSource).not.toHaveBeenCalled()
    expect(f.processor.dispose).not.toHaveBeenCalled()
    expect(f.chunks).toEqual([])
  })

  it('releases microphone ownership immediately while processor startup is pending', async () => {
    let resolveProcessor!: (processor: CaptureProcessor) => void
    const processorResult = new Promise<CaptureProcessor>(resolve => { resolveProcessor = resolve })
    const f = captureFixture({ processorResult })
    const start = f.capture.start()
    await vi.waitFor(() => { expect(f.context.createMediaStreamSource).toHaveBeenCalledTimes(1) })

    f.capture.stop(false)
    expect(f.context.source.disconnect).toHaveBeenCalledTimes(1)
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.context.close).toHaveBeenCalledTimes(1)

    resolveProcessor(f.processor)
    await start
    expect(f.processor.dispose).toHaveBeenCalledTimes(1)
    expect(f.context.source.disconnect).toHaveBeenCalledTimes(1)
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.context.close).toHaveBeenCalledTimes(1)
  })

  it('stops a late microphone stream after audio resume has already failed', async () => {
    let resolveMedia!: (stream: MediaStream) => void
    const media = new Promise<MediaStream>(resolve => { resolveMedia = resolve })
    const f = captureFixture({ media })
    f.context.resume.mockRejectedValueOnce(new Error('device routing detail must not escape'))

    await expect(f.capture.start()).rejects.toThrow('microphone capture could not start')
    expect(f.context.close).toHaveBeenCalledTimes(1)
    expect(f.track.stop).not.toHaveBeenCalled()

    resolveMedia(f.stream)
    await vi.waitFor(() => { expect(f.track.stop).toHaveBeenCalledTimes(1) })
    expect(f.context.createMediaStreamSource).not.toHaveBeenCalled()
    expect(f.processor.dispose).not.toHaveBeenCalled()
  })

  it('flushes one final even frame on an explicit stop', async () => {
    const f = captureFixture({ frameBytes: 8, maxTurnBytes: 32 })
    await f.capture.start()
    f.processor.process(new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75]))
    expect(f.chunks).toEqual([])
    f.capture.stop(true)
    expect(f.chunks).toHaveLength(1)
    expect(f.chunks[0]?.byteLength).toBe(4)
    expect((f.chunks[0]?.byteLength ?? 1) % 2).toBe(0)
    expect(f.track.stop).toHaveBeenCalledTimes(1)
  })

  it('still releases every resource when the final-frame consumer rejects', async () => {
    const f = captureFixture({
      frameBytes: 8,
      maxTurnBytes: 32,
      onChunk: () => { throw new Error('consumer detail must not escape') },
    })
    await f.capture.start()
    f.processor.process(new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75]))
    expect(() => { f.capture.stop(true) }).toThrow('microphone audio processing failed')
    expect(f.processor.dispose).toHaveBeenCalledTimes(1)
    expect(f.context.source.disconnect).toHaveBeenCalledTimes(1)
    expect(f.track.stop).toHaveBeenCalledTimes(1)
    expect(f.context.close).toHaveBeenCalledTimes(1)
  })

  it('installs the production AudioWorklet path and revokes its fixed module URL', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:guarded-voice')
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const context = new FakeContext()
    const track = { stop: vi.fn() }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    const chunks: Uint8Array[] = []
    const onError = vi.fn()
    const capture = new BrowserPcmCapture({
      mediaDevices: { getUserMedia: () => Promise.resolve(stream) } as Pick<MediaDevices, 'getUserMedia'>,
      createAudioContext: () => context as unknown as AudioContext,
      frameBytes: 8,
      maxTurnBytes: 32,
      onChunk: chunk => { chunks.push(chunk) },
      onLimit: vi.fn(),
      onError,
    })

    await capture.start()
    expect(context.audioWorklet.addModule).toHaveBeenCalledWith('blob:guarded-voice')
    expect(createObjectUrl).toHaveBeenCalledTimes(1)
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:guarded-voice')
    const worklet = FakeWorkletNode.instances[0]
    expect(worklet?.name).toBe('dsh-guarded-live-voice-capture-v1')
    expect(worklet?.options).toMatchObject({ numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1 })
    worklet?.port.onmessage?.({ data: new Float32Array([0, 0.25, 0.5, 0.75, 1, 0.75]) } as MessageEvent)
    capture.stop(true)
    expect(chunks).toHaveLength(1)
    expect(onError).not.toHaveBeenCalled()
    expect(worklet?.port.close).toHaveBeenCalledTimes(1)
    expect(worklet?.disconnect).toHaveBeenCalledTimes(1)
    expect(worklet?.onprocessorerror).toBeNull()
    expect(track.stop).toHaveBeenCalledTimes(1)
  })

  it('fails closed and cleans up when the production worklet processor crashes', async () => {
    vi.stubGlobal('AudioWorkletNode', FakeWorkletNode)
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:guarded-voice')
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    const context = new FakeContext()
    const track = { stop: vi.fn() }
    const stream = { getTracks: () => [track] } as unknown as MediaStream
    const onError = vi.fn()
    const capture = new BrowserPcmCapture({
      mediaDevices: { getUserMedia: () => Promise.resolve(stream) } as Pick<MediaDevices, 'getUserMedia'>,
      createAudioContext: () => context as unknown as AudioContext,
      onChunk: vi.fn(),
      onLimit: vi.fn(),
      onError,
    })
    await capture.start()
    const worklet = FakeWorkletNode.instances[0]
    worklet?.onprocessorerror?.()
    expect(onError).toHaveBeenCalledOnce()
    expect(onError).toHaveBeenCalledWith(new Error('microphone audio processing failed'))
    expect(worklet?.onprocessorerror).toBeNull()
    expect(worklet?.port.onmessage).toBeNull()
    expect(track.stop).toHaveBeenCalledTimes(1)
    expect(context.close).toHaveBeenCalledTimes(1)
  })
})
