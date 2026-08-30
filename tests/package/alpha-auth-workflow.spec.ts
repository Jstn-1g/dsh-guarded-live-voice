import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const WORKFLOW = new URL('../../.github/workflows/alpha-auth-proof.yml', import.meta.url)
const PLUGIN_COMMIT = '10bd8bf504cf17fb24523f2c18e9f8a586a41167'
const HARNESS_COMMIT = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'

describe('exact-alpha authenticated Web proof workflow', () => {
  it('is a read-only manual reproduction of immutable public inputs', async () => {
    const source = await readFile(WORKFLOW, 'utf8')

    expect(source).toMatch(/^on:\r?\n {2}workflow_dispatch:\r?$/mu)
    expect(source).not.toMatch(/^ {2}(?:push|pull_request):/mu)
    expect(source).toMatch(/^permissions:\r?\n {2}contents: read\r?\n\r?\njobs:/mu)
    expect(source).not.toContain('${{ secrets.')

    expect(source).toContain('repository: Jstn-1g/dsh-live-voice')
    expect(source).toContain(`ref: ${PLUGIN_COMMIT} # v0.3.0-preview.3`)
    expect(source).toContain('repository: deepseek-ai/deepseek-harness')
    expect(source).toContain(`ref: ${HARNESS_COMMIT} # dsh-v0.1.2-alpha.1`)
    expect(source).toContain('fetch-depth: 0')
    expect(source.match(/persist-credentials: false/gu)).toHaveLength(2)

    const actions = [...source.matchAll(/^\s*uses:\s*([^#\s]+)(?:\s+#.*)?$/gmu)]
      .map(match => match[1])
    expect(actions).toHaveLength(4)
    for (const action of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u)
    }
  })

  it('runs frozen checks and explicitly permits the public packed-plugin install', async () => {
    const source = await readFile(WORKFLOW, 'utf8')

    expect(source.match(/run: pnpm install --frozen-lockfile/gu)).toHaveLength(2)
    expect(source).toContain('run: pnpm run check')
    expect(source).toContain('run: pnpm run build:official')
    expect(source).toContain('DSH_HARNESS_ROOT: ${{ github.workspace }}/harness')
    expect(source).toContain("DSH_VOICE_SMOKE_INSTALL_ONLINE: '1'")
    expect(source).toContain('run: pnpm run smoke:harness:alpha-auth')
  })
})
