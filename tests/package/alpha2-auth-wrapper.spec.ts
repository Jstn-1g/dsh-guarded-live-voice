import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const wrapper = readFileSync(
  new URL('../../scripts/smoke-harness-alpha2-auth.mjs', import.meta.url),
  'utf8',
)
const alpha3Wrapper = readFileSync(
  new URL('../../scripts/smoke-harness-alpha3-auth.mjs', import.meta.url),
  'utf8',
)
const alpha3SyntheticWrapper = readFileSync(
  new URL('../../scripts/smoke-harness-alpha3-synthetic-demo.mjs', import.meta.url),
  'utf8',
)
const smoke = readFileSync(
  new URL('../../scripts/smoke-harness-fake-qwen.mjs', import.meta.url),
  'utf8',
)

describe('exact alpha.2 authenticated smoke wrapper', () => {
  it('selects alpha.2 before enabling authentication and loading the shared smoke', () => {
    const versionFlag = "process.env.DSH_VOICE_SMOKE_ALPHA_VERSION = '0.1.2-alpha.2'"
    const authFlag = "process.env.DSH_VOICE_SMOKE_ALPHA_AUTH = '1'"
    const smokeImport = "await import('./smoke-harness-fake-qwen.mjs')"

    expect(wrapper).toContain(versionFlag)
    expect(wrapper).toContain(authFlag)
    expect(wrapper).toContain(smokeImport)
    expect(wrapper.indexOf(versionFlag)).toBeLessThan(wrapper.indexOf(authFlag))
    expect(wrapper.indexOf(authFlag)).toBeLessThan(wrapper.indexOf(smokeImport))
  })

  it('retains the exact released alpha.2 identity alongside the verified alpha.3 target', () => {
    expect(smoke).toContain("['0.1.2-alpha.2', {")
    expect(smoke).toContain("commit: '0a53fb55bea101816fa226bb964ae2bed71c343b'")
    expect(smoke).toContain("tag: 'dsh-v0.1.2-alpha.2'")
    expect(smoke).toContain("['0.1.2-alpha.3', {")
    expect(smoke).toContain("commit: 'dd6322d604e00eec1ba5e0c8541159906a21094a'")
    expect(smoke).toContain("tag: 'dsh-v0.1.2-alpha.3'")
    expect(smoke).not.toContain('0.1.2-alpha.4')
  })

  it('selects exact alpha.3 before enabling each authenticated smoke mode', () => {
    const versionFlag = "process.env.DSH_VOICE_SMOKE_ALPHA_VERSION = '0.1.2-alpha.3'"
    const authFlag = "process.env.DSH_VOICE_SMOKE_ALPHA_AUTH = '1'"
    const syntheticFlag = "process.env.DSH_VOICE_SMOKE_SYNTHETIC_DEMO = '1'"
    const smokeImport = "await import('./smoke-harness-fake-qwen.mjs')"

    expect(alpha3Wrapper).toContain(versionFlag)
    expect(alpha3Wrapper).toContain(authFlag)
    expect(alpha3Wrapper).toContain(smokeImport)
    expect(alpha3Wrapper.indexOf(versionFlag)).toBeLessThan(alpha3Wrapper.indexOf(authFlag))
    expect(alpha3Wrapper.indexOf(authFlag)).toBeLessThan(alpha3Wrapper.indexOf(smokeImport))

    expect(alpha3SyntheticWrapper).toContain(versionFlag)
    expect(alpha3SyntheticWrapper).toContain(authFlag)
    expect(alpha3SyntheticWrapper).toContain(syntheticFlag)
    expect(alpha3SyntheticWrapper.indexOf(versionFlag)).toBeLessThan(alpha3SyntheticWrapper.indexOf(authFlag))
    expect(alpha3SyntheticWrapper.indexOf(authFlag)).toBeLessThan(alpha3SyntheticWrapper.indexOf(syntheticFlag))
    expect(alpha3SyntheticWrapper.indexOf(syntheticFlag)).toBeLessThan(alpha3SyntheticWrapper.indexOf(smokeImport))
  })
})
