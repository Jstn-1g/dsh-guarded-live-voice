import type { VoiceAudioCapture, VoiceAudioCaptureHandlers } from './controller.js';
/**
 * Explicit test-only capture source for the local synthetic provider.
 * It never requests a MediaStream or reads a physical microphone.
 */
export declare class SyntheticDemoCapture implements VoiceAudioCapture {
    private readonly handlers;
    private started;
    private stopped;
    constructor(handlers: VoiceAudioCaptureHandlers);
    start(): Promise<void>;
    stop(): void;
}
