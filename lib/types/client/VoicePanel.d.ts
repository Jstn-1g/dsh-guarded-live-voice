import type { VoicePanelProps } from './contract.js';
/** User-visible disclosure and setup result; it never receives the bearer challenge. */
export declare function VoicePanel({ sessionId, useVoice, startVoice, acceptDisclosure, stopVoice, beginVoiceCapture, finishVoiceCapture, getVoiceSnapshot, isComposerBindingCurrent, claimVoiceDraftHandoff, inputActions, input, t, }: VoicePanelProps): import("react").JSX.Element | null;
