import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOW = new URL('../../.github/workflows/alpha-auth-proof.yml', import.meta.url)
const README = new URL('../../README.md', import.meta.url)
const PLUGIN_COMMIT = '10bd8bf504cf17fb24523f2c18e9f8a586a41167'
const HARNESS_COMMIT = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'
const RECEIPT = {
  rootStatus: 200,
  clientStatus: 200,
  upgradeOnlyStatus: 404,
  workspaceBound: true,
  sessionBound: true,
  disclosureAccepted: true,
  providerReady: true,
  providerInputBytes: 4,
  providerOutputBytes: 4,
  finalUserTranscript: true,
  finalAssistantTranscript: true,
  turnStatus: 'completed',
  providerSocketDisposed: true,
  alphaRpcEndpoints: ['workspace/create', 'session/create'],
  alphaRpcResponsesCorrelated: true,
  authenticatedRootStatus: 200,
  cookieIssued: true,
  credentialBackedQwen: false,
  dshBuiltFromCleanSource: true,
  dshClientArtifacts: {
    fileCount: 218,
    sha256: 'fbf4e03147b1b951a3fe22bc3adcbba6d99cb09f2310d1e1bdcecc52dffa1e39',
  },
  dshCommit: HARNESS_COMMIT,
  dshTag: 'dsh-v0.1.2-alpha.1',
  dshVersion: '0.1.2-alpha.1',
  dshWebIndexSha256: '0dd16b20a6b1a3a749dea850e6de66296c67e76440e13aaad3136e7c786c8661',
  dshWorktreeDirty: false,
  launchTokenExchanged: true,
  liveCredential: false,
  liveProvider: false,
  officialDshWebProfile: true,
  os: { platform: 'linux', release: '6.17.0-1022-azure' },
  runtime: { node: 'v24.12.0', pnpm: '11.7.0' },
  packagedDesktop: false,
  physicalMicrophone: false,
  physicalSpeaker: false,
  pluginCommit: PLUGIN_COMMIT,
  pluginTarballSha256: 'e48344f569af7c68d5435061115ef27e53e6ce278b917f02c03e4519b2b34991',
  pluginWorktreeDirty: false,
  providerEvents: [
    'session.update',
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
    'response.create',
  ],
  sourceBuiltOfficialAlpha: true,
  unauthenticatedVoiceUpgradeStatus: 401,
}

function extractValidator(source: string): string {
  const match = source.match(
    /DSH_VOICE_RAW_OUTPUT="\$raw" node --input-type=module <<'NODE'\r?\n([\s\S]*?)\r?\n {10}NODE/u,
  )
  if (match?.[1] === undefined) throw new Error('workflow validator was not found')
  return match[1].replace(/^ {10}/gmu, '')
}

async function runValidator(source: string, rows: readonly string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-voice-receipt-'))
  const rawPath = join(directory, 'raw.txt')
  const receiptPath = join(directory, 'receipt.json')
  const summaryPath = join(directory, 'summary.md')
  await writeFile(rawPath, `${rows.join('\n')}\n`, 'utf8')

  const result = spawnSync(process.execPath, ['--input-type=module'], {
    cwd: directory,
    encoding: 'utf8',
    env: {
      ...process.env,
      DSH_VOICE_RAW_OUTPUT: rawPath,
      DSH_VOICE_RECEIPT: receiptPath,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
    input: extractValidator(source),
  })
  const receipt = await readFile(receiptPath, 'utf8').catch(() => undefined)
  const summary = await readFile(summaryPath, 'utf8').catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
  return { receipt, result, summary }
}

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
    expect(actions).toHaveLength(5)
    for (const action of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u)
    }
    expect(actions).toContain(
      'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a',
    )
  })

  it('runs frozen checks and explicitly permits the public packed-plugin install', async () => {
    const source = await readFile(WORKFLOW, 'utf8')

    expect(source.match(/run: pnpm install --frozen-lockfile/gu)).toHaveLength(2)
    expect(source).toContain('run: pnpm run check')
    expect(source).toContain('run: pnpm run build:official')
    expect(source).toContain('DSH_HARNESS_ROOT: ${{ github.workspace }}/harness')
    expect(source).toContain("DSH_VOICE_SMOKE_INSTALL_ONLINE: '1'")
    expect(source).toContain('set -euo pipefail')
    expect(source).toContain('pnpm run smoke:harness:alpha-auth | tee "$raw"')
    expect(source).not.toContain('2>&1')
  })

  it('publishes only a validated single-file receipt with explicit limits', async () => {
    const source = await readFile(WORKFLOW, 'utf8')

    expect(source).toContain("trap 'rm -f -- \"$raw\"' EXIT")
    expect(source).toContain('alpha-auth smoke must end with exactly one JSON receipt')
    expect(source).toContain('alpha-auth receipt contained an unexpected field')
    expect(source).toContain("credentialBackedQwen: false")
    expect(source).toContain("packagedDesktop: false")
    expect(source).toContain('process.env.GITHUB_STEP_SUMMARY')
    expect(source).toContain('Sanitized JSON receipt')
    expect(source).toContain('Upload the sanitized receipt only')
    expect(source).toContain('path: ${{ runner.temp }}/dsh-live-voice-alpha-auth-receipt.json')
    expect(source).toContain('archive: false')
    expect(source).toContain('if-no-files-found: error')
    expect(source).toContain('retention-days: 30')
    expect(source).not.toMatch(/^\s*if:\s*always\(\)/mu)
    expect(source).not.toMatch(/^\s*path:\s*.*(?:raw|stdout|\.log)/mu)
  })

  it('accepts the exact sanitized receipt and renders the bounded summary', async () => {
    const source = await readFile(WORKFLOW, 'utf8')
    const { receipt, result, summary } = await runValidator(source, [
      '$ node scripts/smoke-harness-alpha-auth.mjs',
      JSON.stringify(RECEIPT),
    ])

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(receipt ?? '')).toEqual(RECEIPT)
    expect(summary).toContain('Exact-alpha authenticated Web proof: PASS')
    expect(summary).toContain('source-built authenticated Web profile')
    expect(summary).toContain('Not proven: live or credential-backed Qwen')
    expect(summary).toContain(JSON.stringify(RECEIPT, null, 2))
  })

  it('rejects unsafe, widened, malformed, or unexpected receipts', async () => {
    const source = await readFile(WORKFLOW, 'utf8')
    const banner = '$ node scripts/smoke-harness-alpha-auth.mjs'
    const cases = [
      [banner, JSON.stringify({ ...RECEIPT, sessionId: 'must-not-publish' })],
      [banner, JSON.stringify({ ...RECEIPT, liveProvider: true })],
      [banner, JSON.stringify({ ...RECEIPT, pluginCommit: '0'.repeat(40) })],
      [banner, JSON.stringify({ ...RECEIPT, os: { platform: 'linux', release: '\n```' } })],
      [banner, '{malformed'],
      [banner, JSON.stringify(RECEIPT), JSON.stringify(RECEIPT)],
    ]

    for (const rows of cases) {
      const { receipt, result, summary } = await runValidator(source, rows)
      expect(result.status).not.toBe(0)
      expect(receipt).toBeUndefined()
      expect(summary).toBeUndefined()
    }
  })

  it('is discoverable from the primary no-secret tester path', async () => {
    const readme = await readFile(README, 'utf8')
    const prose = readme.replace(/\s+/gu, ' ')

    expect(readme).toContain('[No-secret tester task](https://github.com/Jstn-1g/dsh-live-voice/issues/19)')
    expect(readme).toContain('[`Exact-alpha authenticated Web proof`](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/alpha-auth-proof.yml)')
    expect(prose).toContain('it requests no secrets, so do not add any')
    expect(prose).toContain('successful run exposes the validated receipt in its public job summary and as one downloadable JSON file')
    expect(prose).toContain('A run owned by this repository is maintainer repeatability evidence, not the independent reproduction requested by that issue')
  })
})
