import type { VoiceAudioCapture, VoiceAudioCaptureHandlers } from './controller.js';
export interface CaptureProcessor {
    readonly node: AudioNode;
    dispose(): void;
}
export type CaptureProcessorFactory = (context: AudioContext, onSamples: (channels: readonly Float32Array[]) => void, onError: () => void) => Promise<CaptureProcessor>;
export interface BrowserPcmCaptureOptions extends VoiceAudioCaptureHandlers {
    readonly mediaDevices?: Pick<MediaDevices, 'getUserMedia'>;
    readonly createAudioContext?: () => AudioContext;
    readonly createProcessor?: CaptureProcessorFactory;
    readonly frameBytes?: number;
    readonly maxTurnBytes?: number;
}
/**
 * Stateful linear resampling preserves phase across browser audio callbacks.
 * The encoder accepts channel planes, downmixes them, and emits little-endian
 * mono PCM16 at the requested target rate.
 */
export declare class StreamingPcm16Encoder {
    private readonly sourceRate;
    private readonly targetRate;
    private pending;
    private position;
    private inputSamples;
    private outputSamples;
    constructor(sourceRate: number, targetRate?: number);
    push(channels: readonly Float32Array[]): Uint8Array;
    /** Flush the final sample without manufacturing an unbounded tail. */
    finish(): Uint8Array;
}
/** Browser microphone capture with bounded PCM framing and owned cleanup. */
export declare class BrowserPcmCapture implements VoiceAudioCapture {
    private readonly options;
    private readonly frameBytes;
    private readonly maxTurnBytes;
    private readonly mediaDevices;
    private readonly createAudioContext;
    private readonly createProcessor;
    private generation;
    private resources;
    private pending;
    private encoder;
    private frame;
    private frameLength;
    private acceptedBytes;
    private limitReached;
    constructor(options: BrowserPcmCaptureOptions);
    start(): Promise<void>;
    stop(flush?: boolean): void;
    private process;
    private enqueue;
    private flushFrame;
    private reachLimit;
}
