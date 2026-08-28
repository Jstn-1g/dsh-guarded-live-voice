/** PCM16 mono input expected by Qwen realtime. */
export const INPUT_PCM_SAMPLE_RATE = 16_000
/** PCM16 mono output produced by Qwen realtime. */
export const OUTPUT_PCM_SAMPLE_RATE = 24_000
export const PCM16_BYTES_PER_SAMPLE = 2
export const MAX_INPUT_PCM16_CHUNK_BYTES = 32 * 1024
export const MAX_INPUT_PCM16_TURN_BYTES = 30 * INPUT_PCM_SAMPLE_RATE * PCM16_BYTES_PER_SAMPLE
export const MAX_OUTPUT_PCM16_CHUNK_BYTES = 64 * 1024
export const MAX_OUTPUT_PCM16_TURN_BYTES = 60 * OUTPUT_PCM_SAMPLE_RATE * PCM16_BYTES_PER_SAMPLE
export const MAX_VOICE_TRANSCRIPT_LENGTH = 4_096
/** Maximum queued bulk audio on either browser or provider WebSocket. */
export const MAX_VOICE_SOCKET_BUFFERED_BYTES = 512 * 1024
/** Capture emits at most 100 ms of 16 kHz mono PCM16 in one browser frame. */
export const CAPTURE_PCM16_FRAME_BYTES = INPUT_PCM_SAMPLE_RATE * PCM16_BYTES_PER_SAMPLE / 10
/** Do not schedule more than five seconds of provider audio ahead of playback. */
export const MAX_PLAYBACK_QUEUE_SECONDS = 5
/** Bound live Web Audio source/event objects even if provider audio is pathologically fragmented. */
export const MAX_PLAYBACK_QUEUE_SOURCES = 256
