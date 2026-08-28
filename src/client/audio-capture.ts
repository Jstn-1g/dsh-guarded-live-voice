import {
  CAPTURE_PCM16_FRAME_BYTES,
  INPUT_PCM_SAMPLE_RATE,
  MAX_INPUT_PCM16_CHUNK_BYTES,
  MAX_INPUT_PCM16_TURN_BYTES,
} from '../shared/audio.js'
import type { VoiceAudioCapture, VoiceAudioCaptureHandlers } from './controller.js'

// Compatibility-stable worklet key. This is intentionally not the product name.
const WORKLET_NAME = 'dsh-guarded-live-voice-capture-v1'
const WORKLET_SOURCE = `
class GuardedLiveVoiceCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channels = inputs[0]
    if (channels && channels.length > 0 && channels[0].length > 0) {
      const mono = new Float32Array(channels[0].length)
      for (const channel of channels) {
        for (let index = 0; index < mono.length; index += 1) {
          mono[index] += channel[index] / channels.length
        }
      }
      this.port.postMessage(mono, [mono.buffer])
    }
    return true
  }
}
registerProcessor('${WORKLET_NAME}', GuardedLiveVoiceCapture)
`

export interface CaptureProcessor {
  readonly node: AudioNode
  dispose(): void
}

export type CaptureProcessorFactory = (
  context: AudioContext,
  onSamples: (channels: readonly Float32Array[]) => void,
  onError: () => void,
) => Promise<CaptureProcessor>

export interface BrowserPcmCaptureOptions extends VoiceAudioCaptureHandlers {
  readonly mediaDevices?: Pick<MediaDevices, 'getUserMedia'>
  readonly createAudioContext?: () => AudioContext
  readonly createProcessor?: CaptureProcessorFactory
  readonly frameBytes?: number
  readonly maxTurnBytes?: number
}

interface CaptureResources {
  readonly context: AudioContext
  readonly stream: MediaStream
  readonly source: MediaStreamAudioSourceNode
  readonly processor: CaptureProcessor
}

interface PendingCapture {
  readonly generation: number
  readonly context: AudioContext
  stream: MediaStream | undefined
  source: MediaStreamAudioSourceNode | undefined
}

/**
 * Stateful linear resampling preserves phase across browser audio callbacks.
 * The encoder accepts channel planes, downmixes them, and emits little-endian
 * mono PCM16 at the requested target rate.
 */
export class StreamingPcm16Encoder {
  private pending = new Float32Array(0)
  private position = 0
  private inputSamples = 0
  private outputSamples = 0

  constructor(
    private readonly sourceRate: number,
    private readonly targetRate = INPUT_PCM_SAMPLE_RATE,
  ) {
    if (!Number.isFinite(sourceRate) || sourceRate <= 0
      || !Number.isFinite(targetRate) || targetRate <= 0) {
      throw new TypeError('audio sample rates must be positive finite numbers')
    }
  }

  push(channels: readonly Float32Array[]): Uint8Array {
    if (channels.length === 0) return new Uint8Array(0)
    const frameCount = channels[0]?.length ?? 0
    if (frameCount === 0) return new Uint8Array(0)
    for (const channel of channels) {
      if (channel.length !== frameCount) throw new TypeError('audio channel lengths must match')
    }
    this.inputSamples += frameCount

    const mono = new Float32Array(frameCount)
    for (const channel of channels) {
      for (let index = 0; index < frameCount; index += 1) {
        mono[index] = (mono[index] ?? 0) + (channel[index] ?? 0) / channels.length
      }
    }

    const joined = new Float32Array(this.pending.length + mono.length)
    joined.set(this.pending)
    joined.set(mono, this.pending.length)
    const ratio = this.sourceRate / this.targetRate
    const output: number[] = []
    while (this.position + 1 < joined.length) {
      const leftIndex = Math.floor(this.position)
      const fraction = this.position - leftIndex
      const left = joined[leftIndex] ?? 0
      const right = joined[leftIndex + 1] ?? left
      output.push(left + (right - left) * fraction)
      this.position += ratio
    }

    const consumed = Math.min(Math.floor(this.position), joined.length)
    this.pending = joined.slice(consumed)
    this.position -= consumed
    this.outputSamples += output.length
    return encodePcm16(output)
  }

  /** Flush the final sample without manufacturing an unbounded tail. */
  finish(): Uint8Array {
    if (this.pending.length === 0 || this.position >= this.pending.length) {
      this.pending = new Float32Array(0)
      this.position = 0
      this.inputSamples = 0
      this.outputSamples = 0
      return new Uint8Array(0)
    }
    const ratio = this.sourceRate / this.targetRate
    const output: number[] = []
    const targetSamples = Math.ceil(this.inputSamples * this.targetRate / this.sourceRate)
    const remainingSamples = Math.max(0, targetSamples - this.outputSamples)
    const last = this.pending[this.pending.length - 1] ?? 0
    while (this.position < this.pending.length && output.length < remainingSamples) {
      const leftIndex = Math.floor(this.position)
      const fraction = this.position - leftIndex
      const left = this.pending[leftIndex] ?? last
      const right = this.pending[leftIndex + 1] ?? last
      output.push(left + (right - left) * fraction)
      this.position += ratio
    }
    this.pending = new Float32Array(0)
    this.position = 0
    this.inputSamples = 0
    this.outputSamples = 0
    return encodePcm16(output)
  }
}

/** Browser microphone capture with bounded PCM framing and owned cleanup. */
export class BrowserPcmCapture implements VoiceAudioCapture {
  private readonly frameBytes: number
  private readonly maxTurnBytes: number
  private readonly mediaDevices: Pick<MediaDevices, 'getUserMedia'>
  private readonly createAudioContext: () => AudioContext
  private readonly createProcessor: CaptureProcessorFactory
  private generation = 0
  private resources: CaptureResources | undefined
  private pending: PendingCapture | undefined
  private encoder: StreamingPcm16Encoder | undefined
  private frame = new Uint8Array(0)
  private frameLength = 0
  private acceptedBytes = 0
  private limitReached = false

  constructor(private readonly options: BrowserPcmCaptureOptions) {
    this.frameBytes = options.frameBytes ?? CAPTURE_PCM16_FRAME_BYTES
    this.maxTurnBytes = options.maxTurnBytes ?? MAX_INPUT_PCM16_TURN_BYTES
    if (!Number.isSafeInteger(this.frameBytes)
      || this.frameBytes <= 0
      || this.frameBytes > MAX_INPUT_PCM16_CHUNK_BYTES
      || this.frameBytes % 2 !== 0) {
      throw new TypeError('capture frame size exceeds the PCM16 chunk boundary')
    }
    if (!Number.isSafeInteger(this.maxTurnBytes)
      || this.maxTurnBytes <= 0
      || this.maxTurnBytes > MAX_INPUT_PCM16_TURN_BYTES
      || this.maxTurnBytes % 2 !== 0) {
      throw new TypeError('capture turn size exceeds the PCM16 turn boundary')
    }
    this.mediaDevices = options.mediaDevices ?? browserMediaDevices()
    this.createAudioContext = options.createAudioContext ?? browserAudioContext
    this.createProcessor = options.createProcessor ?? createAudioWorkletProcessor
  }

  async start(): Promise<void> {
    if (this.resources !== undefined || this.pending !== undefined) return
    const generation = ++this.generation
    this.frame = new Uint8Array(this.frameBytes)
    this.frameLength = 0
    this.acceptedBytes = 0
    this.limitReached = false

    let pending: PendingCapture | undefined
    let processor: CaptureProcessor | undefined
    try {
      const context = this.createAudioContext()
      const staged: PendingCapture = { generation, context, stream: undefined, source: undefined }
      pending = staged
      this.pending = staged
      // Both calls begin in the explicit button gesture. Awaiting permission first
      // can otherwise lose the browser's audio-playback activation window.
      const resume = context.state === 'suspended' ? context.resume() : Promise.resolve()
      const media = this.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      }).then(stream => {
        if (this.pending !== staged || generation !== this.generation) {
          stopTracks(stream)
        } else {
          staged.stream = stream
        }
        return stream
      })
      const [stream] = await Promise.all([media, resume.then(() => undefined)])
      if (this.pending !== staged || generation !== this.generation) {
        await releasePendingCapture(staged)
        return
      }

      const source = context.createMediaStreamSource(stream)
      staged.source = source
      processor = await this.createProcessor(
        context,
        channels => { this.process(channels) },
        () => {
          this.stop(false)
          this.options.onError(new Error('microphone audio processing failed'))
        },
      )
      if (this.pending !== staged || generation !== this.generation) {
        processor.dispose()
        await releasePendingCapture(staged)
        return
      }
      source.connect(processor.node)
      this.encoder = new StreamingPcm16Encoder(context.sampleRate)
      this.resources = { context, stream, source, processor }
      staged.stream = undefined
      staged.source = undefined
      this.pending = undefined
    } catch (error) {
      processor?.dispose()
      if (this.pending === pending) this.pending = undefined
      const isCurrent = generation === this.generation
      if (isCurrent) {
        ++this.generation
        this.resources = undefined
        this.encoder = undefined
      }
      if (pending !== undefined) await releasePendingCapture(pending)
      if (!isCurrent) return
      throw captureStartError(error)
    }
  }

  stop(flush = true): void {
    ++this.generation
    let flushError: unknown
    try {
      const encoder = this.encoder
      if (flush && encoder !== undefined && !this.limitReached) {
        this.enqueue(encoder.finish())
        this.flushFrame()
      }
    } catch (error) {
      flushError = error
    } finally {
      this.encoder = undefined
      const resources = this.resources
      this.resources = undefined
      if (resources !== undefined) releaseResources(resources)
      const pending = this.pending
      this.pending = undefined
      if (pending !== undefined && pending.context !== resources?.context) {
        void releasePendingCapture(pending)
      }
    }
    if (flushError !== undefined) throw new Error('microphone audio processing failed')
  }

  private process(channels: readonly Float32Array[]): void {
    const encoder = this.encoder
    if (encoder === undefined || this.resources === undefined) return
    try {
      this.enqueue(encoder.push(channels))
    } catch {
      this.stop(false)
      this.options.onError(new Error('microphone audio processing failed'))
    }
  }

  private enqueue(bytes: Uint8Array): void {
    let offset = 0
    while (offset < bytes.byteLength && !this.limitReached) {
      const remainingTurnBytes = this.maxTurnBytes - this.acceptedBytes
      if (remainingTurnBytes <= 0) {
        this.reachLimit()
        return
      }
      const writable = Math.min(
        bytes.byteLength - offset,
        this.frameBytes - this.frameLength,
        remainingTurnBytes,
      )
      this.frame.set(bytes.subarray(offset, offset + writable), this.frameLength)
      this.frameLength += writable
      this.acceptedBytes += writable
      offset += writable
      if (this.frameLength === this.frameBytes) this.flushFrame()
      if (this.acceptedBytes === this.maxTurnBytes) this.reachLimit()
    }
  }

  private flushFrame(): void {
    if (this.frameLength === 0) return
    const owned = this.frame.slice(0, this.frameLength)
    this.frameLength = 0
    this.options.onChunk(owned)
  }

  private reachLimit(): void {
    if (this.limitReached) return
    this.limitReached = true
    this.flushFrame()
    this.stop(false)
    this.options.onLimit()
  }
}

function encodePcm16(samples: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0))
    const pcm = sample < 0 ? Math.round(sample * 32_768) : Math.round(sample * 32_767)
    view.setInt16(index * 2, pcm, true)
  }
  return bytes
}

function browserMediaDevices(): Pick<MediaDevices, 'getUserMedia'> {
  const mediaDevices = globalThis.navigator?.mediaDevices
  if (mediaDevices === undefined || typeof mediaDevices.getUserMedia !== 'function') {
    return {
      getUserMedia: () => Promise.reject(new Error('microphone capture is unavailable in this browser')),
    }
  }
  return mediaDevices
}

function browserAudioContext(): AudioContext {
  const AudioContextConstructor = globalThis.AudioContext
    ?? (globalThis as typeof globalThis & { readonly webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (AudioContextConstructor === undefined) {
    throw new Error('browser audio is unavailable')
  }
  return new AudioContextConstructor()
}

async function createAudioWorkletProcessor(
  context: AudioContext,
  onSamples: (channels: readonly Float32Array[]) => void,
  onError: () => void,
): Promise<CaptureProcessor> {
  if (context.audioWorklet === undefined || typeof globalThis.AudioWorkletNode !== 'function') {
    throw new Error('browser audio worklets are unavailable')
  }
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }))
  try {
    await context.audioWorklet.addModule(moduleUrl)
  } finally {
    URL.revokeObjectURL(moduleUrl)
  }
  const node = new AudioWorkletNode(context, WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 0,
    channelCount: 1,
    channelCountMode: 'explicit',
  })
  node.port.onmessage = event => {
    if (event.data instanceof Float32Array) onSamples([event.data])
    else onError()
  }
  node.port.onmessageerror = onError
  node.onprocessorerror = onError
  return {
    node,
    dispose() {
      node.port.onmessage = null
      node.port.onmessageerror = null
      node.onprocessorerror = null
      try { node.port.close() } catch {}
      try { node.disconnect() } catch {}
    },
  }
}

function captureStartError(error: unknown): Error {
  const name = typeof error === 'object' && error !== null && 'name' in error
    ? String((error as { readonly name: unknown }).name)
    : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new Error('microphone permission was denied')
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return new Error('no microphone is available')
  }
  if (error instanceof Error
    && (error.message === 'microphone capture is unavailable in this browser'
      || error.message === 'browser audio is unavailable')) return error
  return new Error('microphone capture could not start')
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    try { track.stop() } catch {}
  }
}

function releaseResources(resources: CaptureResources): void {
  try { resources.source.disconnect() } catch {}
  resources.processor.dispose()
  stopTracks(resources.stream)
  void closeContext(resources.context)
}

async function releasePendingCapture(pending: PendingCapture): Promise<void> {
  const source = pending.source
  pending.source = undefined
  try { source?.disconnect() } catch {}
  const stream = pending.stream
  pending.stream = undefined
  if (stream !== undefined) stopTracks(stream)
  await closeContext(pending.context)
}

async function closeContext(context: AudioContext): Promise<void> {
  if (context.state === 'closed') return
  try { await context.close() } catch {}
}
