import {
  MAX_OUTPUT_PCM16_CHUNK_BYTES,
  MAX_PLAYBACK_QUEUE_SECONDS,
  MAX_PLAYBACK_QUEUE_SOURCES,
  OUTPUT_PCM_SAMPLE_RATE,
} from '../shared/audio.js'
import type { VoiceAudioSink } from './controller.js'

export interface BrowserPcmPlaybackOptions {
  readonly createAudioContext?: () => AudioContext
  readonly maxQueueSeconds?: number
  readonly maxQueueSources?: number
}

/** Ordered, bounded PCM16 playback. It creates audio only from a user gesture. */
export class BrowserPcmPlaybackSink implements VoiceAudioSink {
  private readonly createAudioContext: () => AudioContext
  private readonly maxQueueSeconds: number
  private readonly maxQueueSources: number
  private context: AudioContext | undefined
  private nextStartAt = 0
  private generation = 0
  private readonly sources = new Set<AudioBufferSourceNode>()

  constructor(options: BrowserPcmPlaybackOptions = {}) {
    this.createAudioContext = options.createAudioContext ?? browserAudioContext
    this.maxQueueSeconds = options.maxQueueSeconds ?? MAX_PLAYBACK_QUEUE_SECONDS
    this.maxQueueSources = options.maxQueueSources ?? MAX_PLAYBACK_QUEUE_SOURCES
    if (!Number.isFinite(this.maxQueueSeconds) || this.maxQueueSeconds <= 0) {
      throw new TypeError('playback queue boundary must be positive')
    }
    if (!Number.isSafeInteger(this.maxQueueSources) || this.maxQueueSources <= 0) {
      throw new TypeError('playback source boundary must be a positive safe integer')
    }
  }

  async prepare(): Promise<void> {
    if (this.context !== undefined) {
      if (this.context.state === 'suspended') await this.resume(this.context)
      return
    }
    const generation = this.generation
    let context: AudioContext
    try {
      context = this.createAudioContext()
    } catch {
      throw new Error('audio playback could not start')
    }
    try {
      this.context = context
      this.nextStartAt = context.currentTime
      if (context.state === 'suspended') await context.resume()
    } catch {
      if (this.context === context) this.context = undefined
      void closeContext(context)
      throw new Error('audio playback could not start')
    }
    if (generation !== this.generation || this.context !== context) {
      if (this.context === context) this.context = undefined
      void closeContext(context)
    }
  }

  write(pcm24: Uint8Array): void {
    const context = this.context
    if (context === undefined || context.state === 'closed') {
      throw new Error('audio playback was not prepared by a user gesture')
    }
    if (pcm24.byteLength === 0
      || pcm24.byteLength > MAX_OUTPUT_PCM16_CHUNK_BYTES
      || pcm24.byteLength % 2 !== 0) {
      throw new Error('audio playback received invalid PCM16 output')
    }

    const frameCount = pcm24.byteLength / 2
    const duration = frameCount / OUTPUT_PCM_SAMPLE_RATE
    const startsAt = Math.max(context.currentTime, this.nextStartAt)
    if (this.sources.size >= this.maxQueueSources
      || startsAt + duration - context.currentTime > this.maxQueueSeconds) {
      throw new Error('audio playback backpressure limit reached')
    }

    const samples = new Float32Array(frameCount)
    const view = new DataView(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength)
    for (let index = 0; index < frameCount; index += 1) {
      const pcm = view.getInt16(index * 2, true)
      samples[index] = pcm < 0 ? pcm / 32_768 : pcm / 32_767
    }
    let source: AudioBufferSourceNode | undefined
    try {
      const buffer = context.createBuffer(1, frameCount, OUTPUT_PCM_SAMPLE_RATE)
      buffer.copyToChannel(samples, 0)
      source = context.createBufferSource()
      const generation = this.generation
      source.buffer = buffer
      source.connect(context.destination)
      source.onended = () => {
        if (generation === this.generation && source !== undefined) this.sources.delete(source)
        try { source?.disconnect() } catch {}
      }
      source.start(startsAt)
    } catch {
      if (source !== undefined) source.onended = null
      try { source?.disconnect() } catch {}
      throw new Error('audio playback scheduling failed')
    }
    this.sources.add(source)
    this.nextStartAt = startsAt + duration
  }

  reset(): void {
    ++this.generation
    for (const source of this.sources) {
      source.onended = null
      try { source.stop() } catch {}
      try { source.disconnect() } catch {}
    }
    this.sources.clear()
    this.nextStartAt = 0
    const context = this.context
    this.context = undefined
    if (context !== undefined) void closeContext(context)
  }

  private async resume(context: AudioContext): Promise<void> {
    try {
      await context.resume()
    } catch {
      throw new Error('audio playback could not start')
    }
  }
}

function browserAudioContext(): AudioContext {
  const AudioContextConstructor = globalThis.AudioContext
    ?? (globalThis as typeof globalThis & { readonly webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (AudioContextConstructor === undefined) throw new Error('browser audio is unavailable')
  return new AudioContextConstructor()
}

async function closeContext(context: AudioContext): Promise<void> {
  if (context.state === 'closed') return
  try { await context.close() } catch {}
}
