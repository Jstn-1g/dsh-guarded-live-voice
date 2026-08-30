export interface HarnessAlphaModeOptions {
  alphaAuthRequested: boolean
  harnessVersion: string
  runBrowserBfcache: boolean
  supportedAlphaVersion: string
}

export function shouldRunAlphaAuth(options: HarnessAlphaModeOptions): boolean
