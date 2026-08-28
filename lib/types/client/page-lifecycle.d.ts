interface PageLifecycleTarget {
    addEventListener(type: 'pagehide', listener: () => void): void;
    removeEventListener(type: 'pagehide', listener: () => void): void;
}
/** Release browser-owned resources before this document leaves its lifecycle. */
export declare function bindPageLifecycleCleanup(target: PageLifecycleTarget, pagehideCleanup: () => void, pluginCleanup: () => void): () => void;
export {};
