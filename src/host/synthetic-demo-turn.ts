import {
  MAX_INPUT_PCM16_CHUNK_BYTES,
  MAX_INPUT_PCM16_TURN_BYTES,
  MAX_OUTPUT_PCM16_CHUNK_BYTES,
  OUTPUT_PCM_SAMPLE_RATE,
  PCM16_BYTES_PER_SAMPLE,
} from '../shared/audio.js'
import { GuardedVoiceError } from '../shared/errors.js'
import type {
  ManualTurnProviderEvent,
  ManualTurnProviderSession,
} from './provider.js'

export const SYNTHETIC_DEMO_PROVIDER = 'synthetic-demo' as const
export const SYNTHETIC_DEMO_MODEL = 'dsh-live-voice-synthetic-demo-v1' as const
export const SYNTHETIC_DEMO_USER_TRANSCRIPT = 'Synthetic demo request: place this sample transcript in the DSH draft.'
export const SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT = 'Synthetic demo response: the local consent-bound turn completed without contacting an external provider.'

const CHIME_DURATION_MS = 100
const CHIME_CYCLE_SAMPLES = 48
const CHIME_QUARTER_CYCLE_SAMPLES = CHIME_CYCLE_SAMPLES / 4
const CHIME_FADE_SAMPLES = 240
const CHIME_TRIANGLE_SCALE = 100

type CloseReason = Awaited<ManualTurnProviderSession['closed']>
type DemoState = 'input' | 'response' | 'done' | 'closed'

export interface OpenSyntheticDemoTurnOptions {
  readonly signal: AbortSignal
  /** Test seam for deterministic delivery; production uses a microtask. */
  readonly defer?: (callback: () => void) => void
}

/** Build one short, low-amplitude, byte-stable PCM16 mono/24 kHz demo chime. */
function buildDemoChime(): Uint8Array {
  const sampleCount = OUTPUT_PCM_SAMPLE_RATE * CHIME_DURATION_MS / 1_000
  const bytes = new Uint8Array(sampleCount * PCM16_BYTES_PER_SAMPLE)
  const view = new DataView(bytes.buffer)
  for (let index = 0; index < sampleCount; index += 1) {
    const phase = index % CHIME_CYCLE_SAMPLES
    const triangle = phase < CHIME_QUARTER_CYCLE_SAMPLES
      ? phase
      : phase < CHIME_QUARTER_CYCLE_SAMPLES * 3
        ? CHIME_QUARTER_CYCLE_SAMPLES * 2 - phase
        : phase - CHIME_CYCLE_SAMPLES
    const envelope = Math.min(index, sampleCount - 1 - index, CHIME_FADE_SAMPLES)
    const sample = Math.trunc(triangle * CHIME_TRIANGLE_SCALE * envelope / CHIME_FADE_SAMPLES)
    view.setInt16(index * PCM16_BYTES_PER_SAMPLE, sample, true)
  }
  if (bytes.byteLength === 0
    || bytes.byteLength > MAX_OUTPUT_PCM16_CHUNK_BYTES
    || bytes.byteLength % PCM16_BYTES_PER_SAMPLE !== 0) {
    throw new Error('synthetic demo chime exceeds the output boundary')
  }
  return bytes
}

const DEMO_CHIME = buildDemoChime()

/**
 * Open one in-process, credential-free demonstration turn.
 *
 * Input bytes are validated and counted only; they are never retained, decoded,
 * transcribed, or echoed. One explicit commit emits fixed, clearly synthetic
 * transcripts, one bounded deterministic chime, and a completed terminal event.
 */
export async function openSyntheticDemoTurn(
  options: OpenSyntheticDemoTurnOptions,
): Promise<ManualTurnProviderSession> {
  if (options.signal.aborted) {
    throw new GuardedVoiceError('invalid-state', 'synthetic demo turn was cancelled')
  }

  const defer = options.defer ?? queueMicrotask
  const listeners = new Set<(event: ManualTurnProviderEvent) => void>()
  let state: DemoState = 'input'
  let inputBytes = 0
  let resolveClosed: (reason: CloseReason) => void = () => {}
  const closed = new Promise<CloseReason>((resolve) => { resolveClosed = resolve })

  const finishLocal = (): void => {
    if (state === 'closed') return
    state = 'closed'
    options.signal.removeEventListener('abort', onAbort)
    listeners.clear()
    resolveClosed('local')
  }

  function onAbort(): void {
    finishLocal()
  }

  const emit = (event: ManualTurnProviderEvent): boolean => {
    if (state !== 'response') return false
    for (const listener of [...listeners]) listener(event)
    return state === 'response'
  }

  const session: ManualTurnProviderSession = {
    authorization: {
      provider: SYNTHETIC_DEMO_PROVIDER,
      model: SYNTHETIC_DEMO_MODEL,
    },
    closed,
    appendPcm16(chunk) {
      if (state !== 'input') {
        throw new GuardedVoiceError('invalid-state', 'synthetic demo turn is not accepting audio')
      }
      if (chunk.byteLength === 0
        || chunk.byteLength > MAX_INPUT_PCM16_CHUNK_BYTES
        || chunk.byteLength % PCM16_BYTES_PER_SAMPLE !== 0) {
        throw new GuardedVoiceError('invalid-message', 'synthetic demo PCM16 input chunk is invalid')
      }
      if (inputBytes + chunk.byteLength > MAX_INPUT_PCM16_TURN_BYTES) {
        throw new GuardedVoiceError('invalid-message', 'synthetic demo PCM16 input exceeds the turn limit')
      }
      // Deliberately retain only the count. The caller continues to own `chunk`.
      inputBytes += chunk.byteLength
    },
    commit() {
      if (state !== 'input') {
        throw new GuardedVoiceError('invalid-state', 'synthetic demo turn can be committed only once')
      }
      if (inputBytes === 0) {
        throw new GuardedVoiceError('invalid-state', 'synthetic demo turn has no audio to commit')
      }
      state = 'response'
      defer(() => {
        if (!emit({
          type: 'transcript',
          role: 'user',
          text: SYNTHETIC_DEMO_USER_TRANSCRIPT,
          final: true,
        })) return
        if (!emit({
          type: 'transcript',
          role: 'assistant',
          text: SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT,
          final: true,
        })) return
        if (!emit({ type: 'audio', pcm24: new Uint8Array(DEMO_CHIME) })) return
        if (state !== 'response') return
        state = 'done'
        for (const listener of [...listeners]) listener({ type: 'done', status: 'completed' })
      })
    },
    close: finishLocal,
    subscribe(listener) {
      if (state === 'closed') return () => {}
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  options.signal.addEventListener('abort', onAbort, { once: true })
  return session
}
