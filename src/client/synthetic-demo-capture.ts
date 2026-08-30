import type {
  VoiceAudioCapture,
  VoiceAudioCaptureHandlers,
} from './controller.js'

const DEMO_INPUT_SAMPLE_RATE = 16_000
const DEMO_INPUT_DURATION_MS = 100
const DEMO_INPUT_FREQUENCY_HZ = 440
const DEMO_INPUT_AMPLITUDE = 4_096

function syntheticInputPcm16(): Uint8Array {
  const samples = Math.floor(DEMO_INPUT_SAMPLE_RATE * DEMO_INPUT_DURATION_MS / 1_000)
  const bytes = new Uint8Array(samples * 2)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < samples; index += 1) {
    const sample = Math.round(
      Math.sin(2 * Math.PI * DEMO_INPUT_FREQUENCY_HZ * index / DEMO_INPUT_SAMPLE_RATE)
      * DEMO_INPUT_AMPLITUDE,
    )
    view.setInt16(index * 2, sample, true)
  }
  return bytes
}

/**
 * Explicit test-only capture source for the local synthetic provider.
 * It never requests a MediaStream or reads a physical microphone.
 */
export class SyntheticDemoCapture implements VoiceAudioCapture {
  private started = false
  private stopped = false

  constructor(private readonly handlers: VoiceAudioCaptureHandlers) {}

  start(): Promise<void> {
    if (this.started || this.stopped) {
      return Promise.reject(new Error('synthetic demo capture cannot be restarted'))
    }
    this.started = true
    this.handlers.onChunk(syntheticInputPcm16())
    return Promise.resolve()
  }

  stop(): void {
    this.stopped = true
  }
}
