interface PageLifecycleTarget {
  addEventListener(type: 'pagehide', listener: () => void): void
  removeEventListener(type: 'pagehide', listener: () => void): void
}

/** Release browser-owned resources before this document leaves its lifecycle. */
export function bindPageLifecycleCleanup(
  target: PageLifecycleTarget,
  pagehideCleanup: () => void,
  pluginCleanup: () => void,
): () => void {
  let disposed = false
  const cleanupPage = () => {
    if (disposed) return
    pagehideCleanup()
  }
  target.addEventListener('pagehide', cleanupPage)
  return () => {
    if (disposed) return
    disposed = true
    target.removeEventListener('pagehide', cleanupPage)
    pluginCleanup()
  }
}
