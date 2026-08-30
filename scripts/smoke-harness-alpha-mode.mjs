export function shouldRunAlphaAuth({
  alphaAuthRequested,
  harnessVersion,
  runBrowserBfcache,
  supportedAlphaVersion,
}) {
  return alphaAuthRequested || (
    runBrowserBfcache && harnessVersion === supportedAlphaVersion
  )
}
