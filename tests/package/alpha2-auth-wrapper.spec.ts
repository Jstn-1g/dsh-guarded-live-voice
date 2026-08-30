import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const wrapper = readFileSync(
  new URL('../../scripts/smoke-harness-alpha2-auth.mjs', import.meta.url),
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

  it('pins the exact released alpha.2 identity without widening future alpha targets', () => {
    expect(smoke).toContain("['0.1.2-alpha.2', {")
    expect(smoke).toContain("commit: '0a53fb55bea101816fa226bb964ae2bed71c343b'")
    expect(smoke).toContain("tag: 'dsh-v0.1.2-alpha.2'")
    expect(smoke).not.toContain('0.1.2-alpha.3')
  })
})
