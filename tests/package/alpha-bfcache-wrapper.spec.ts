import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { shouldRunAlphaAuth } from '../../scripts/smoke-harness-alpha-mode.mjs'

const wrapper = readFileSync(
  new URL('../../scripts/smoke-harness-browser-bfcache.mjs', import.meta.url),
  'utf8',
)

describe('official Harness BFCache smoke authentication', () => {
  it('enables BFCache without forcing the exact-alpha-only mode', () => {
    const bfcacheFlag = "process.env.DSH_VOICE_SMOKE_BROWSER_BFCACHE = '1'"
    const smokeImport = "await import('./smoke-harness-fake-qwen.mjs')"

    expect(wrapper).toContain(bfcacheFlag)
    expect(wrapper).not.toContain('DSH_VOICE_SMOKE_ALPHA_AUTH')
    expect(wrapper).toContain(smokeImport)
    expect(wrapper.indexOf(bfcacheFlag)).toBeLessThan(wrapper.indexOf(smokeImport))
  })

  it.each([
    {
      alphaAuthRequested: false,
      expected: false,
      harnessVersion: '0.1.1-rc.2',
      label: 'keeps the supported rc BFCache path unauthenticated',
      runBrowserBfcache: true,
    },
    {
      alphaAuthRequested: false,
      expected: true,
      harnessVersion: '0.1.2-alpha.1',
      label: 'selects authentication for the exact supported alpha BFCache path',
      runBrowserBfcache: true,
    },
    {
      alphaAuthRequested: false,
      expected: false,
      harnessVersion: '0.1.2-alpha.2',
      label: 'does not infer compatibility for a later alpha',
      runBrowserBfcache: true,
    },
    {
      alphaAuthRequested: true,
      expected: true,
      harnessVersion: '0.1.1-rc.2',
      label: 'keeps the exact-alpha auth smoke fail-closed when a token is missing',
      runBrowserBfcache: false,
    },
    {
      alphaAuthRequested: false,
      expected: false,
      harnessVersion: '0.1.2-alpha.1',
      label: 'does not enable alpha auth for the default fake-provider smoke',
      runBrowserBfcache: false,
    },
  ])('$label', ({ alphaAuthRequested, expected, harnessVersion, runBrowserBfcache }) => {
    expect(shouldRunAlphaAuth({
      alphaAuthRequested,
      harnessVersion,
      runBrowserBfcache,
      supportedAlphaVersion: '0.1.2-alpha.1',
    })).toBe(expected)
  })
})
