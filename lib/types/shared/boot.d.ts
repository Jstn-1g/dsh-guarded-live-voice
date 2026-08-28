export declare const CLIENT_BOOT_GLOBAL: "__DSH_GUARDED_LIVE_VOICE__";
export declare const CLIENT_BOOT_VERSION: 1;
export interface GuardedVoiceClientBoot {
    readonly v: typeof CLIENT_BOOT_VERSION;
    readonly route: string;
}
/** Validate the non-secret Host-to-browser route descriptor. */
export declare function parseGuardedVoiceClientBoot(value: unknown): GuardedVoiceClientBoot;
