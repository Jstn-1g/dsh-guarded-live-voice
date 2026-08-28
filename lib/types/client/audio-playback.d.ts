import type { VoiceAudioSink } from './controller.js';
export interface BrowserPcmPlaybackOptions {
    readonly createAudioContext?: () => AudioContext;
    readonly maxQueueSeconds?: number;
    readonly maxQueueSources?: number;
}
/** Ordered, bounded PCM16 playback. It creates audio only from a user gesture. */
export declare class BrowserPcmPlaybackSink implements VoiceAudioSink {
    private readonly createAudioContext;
    private readonly maxQueueSeconds;
    private readonly maxQueueSources;
    private context;
    private nextStartAt;
    private generation;
    private readonly sources;
    constructor(options?: BrowserPcmPlaybackOptions);
    prepare(): Promise<void>;
    write(pcm24: Uint8Array): void;
    reset(): void;
    private resume;
}
