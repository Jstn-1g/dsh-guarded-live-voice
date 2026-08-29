import type { Context as ClientContext } from '@deepseek-ai/cordis';
import { type VoiceKey } from './locales.js';
declare module '@deepseek-ai/dsh-client-ui-slots' {
    interface LocaleNamespaceMap {
        /** DSH Live Voice disclosure and setup copy. */
        guardedVoice: VoiceKey;
    }
}
/** Browser services required by the two DSH Live Voice slot contributions. */
export declare const inject: string[];
/** Mount the user-visible, exact-session disclosure flow. */
export declare function apply(ctx: ClientContext): void;
