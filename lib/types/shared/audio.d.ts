/** PCM16 mono input expected by Qwen realtime. */
export declare const INPUT_PCM_SAMPLE_RATE = 16000;
/** PCM16 mono output produced by Qwen realtime. */
export declare const OUTPUT_PCM_SAMPLE_RATE = 24000;
export declare const PCM16_BYTES_PER_SAMPLE = 2;
export declare const MAX_INPUT_PCM16_CHUNK_BYTES: number;
export declare const MAX_INPUT_PCM16_TURN_BYTES: number;
export declare const MAX_OUTPUT_PCM16_CHUNK_BYTES: number;
export declare const MAX_OUTPUT_PCM16_TURN_BYTES: number;
export declare const MAX_VOICE_TRANSCRIPT_LENGTH = 4096;
/** Maximum queued bulk audio on either browser or provider WebSocket. */
export declare const MAX_VOICE_SOCKET_BUFFERED_BYTES: number;
/** Capture emits at most 100 ms of 16 kHz mono PCM16 in one browser frame. */
export declare const CAPTURE_PCM16_FRAME_BYTES: number;
/** Do not schedule more than five seconds of provider audio ahead of playback. */
export declare const MAX_PLAYBACK_QUEUE_SECONDS = 5;
/** Bound live Web Audio source/event objects even if provider audio is pathologically fragmented. */
export declare const MAX_PLAYBACK_QUEUE_SOURCES = 256;
