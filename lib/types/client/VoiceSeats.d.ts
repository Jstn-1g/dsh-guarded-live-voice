import { type ReactNode } from 'react';
import type { VoiceControlProps, VoicePanelProps } from './contract.js';
/** Session-scoped compact control with deterministic unmount cleanup. */
export declare function VoiceControlSeat(props: VoiceControlProps): ReactNode;
/** Session-scoped disclosure panel with deterministic unmount cleanup. */
export declare function VoicePanelSeat(props: VoicePanelProps): ReactNode;
