import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOW = new URL('../../.github/workflows/alpha3-auth-proof.yml', import.meta.url)
const PLUGIN_COMMIT = '4a5959c7bc6177f039880350e7914f59bfda7486'
const HARNESS_COMMIT = 'dd6322d604e00eec1ba5e0c8541159906a21094a'
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
    fileCount: 220,
    sha256: '9ea788d128d4f5a12cde2b8893d581e9a27fcf4cc5bf88e6f6247d97e1cc510a',
  },
  dshCommit: HARNESS_COMMIT,
  dshTag: 'dsh-v0.1.2-alpha.3',
  dshVersion: '0.1.2-alpha.3',
  dshWebIndexSha256: '444492712f6d5f5c6a0e6741ebd2db04b929d88a269c768102f28b50e6384ab6',
  dshWorktreeDirty: false,
  launchTokenExchanged: true,
  liveCredential: false,
  liveProvider: false,
  officialDshWebProfile: true,
  os: { platform: 'linux', release: '6.11.0-generic' },
  runtime: { node: 'v24.12.0', pnpm: '11.7.0' },
  packagedDesktop: false,
  physicalMicrophone: false,
  physicalSpeaker: false,
  pluginCommit: PLUGIN_COMMIT,
  pluginTarballSha256: '4af65a550449346dd1b2b521c15e40a75196bb5ef5a42b953858e0014f3c9dc9',
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
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-voice-alpha3-receipt-'))
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
      EXPECTED_PLUGIN_COMMIT: PLUGIN_COMMIT,
      GITHUB_STEP_SUMMARY: summaryPath,
    },
    input: extractValidator(source),
  })
  const receipt = await readFile(receiptPath, 'utf8').catch(() => undefined)
  const summary = await readFile(summaryPath, 'utf8').catch(() => undefined)
  await rm(directory, { recursive: true, force: true })
  return { receipt, result, summary }
}

describe('exact-alpha.3 current-main authenticated Web proof workflow', () => {
  it('uses read-only manual execution and immutable upstream inputs', async () => {
    const source = await readFile(WORKFLOW, 'utf8')

    expect(source).toMatch(/^on:\r?\n {2}workflow_dispatch:\r?$/mu)
    expect(source).not.toMatch(/^ {2}(?:push|pull_request):/mu)
    expect(source).toMatch(/^permissions:\r?\n {2}contents: read\r?\n\r?\njobs:/mu)
    expect(source).not.toContain('${{ secrets.')
    expect(source).not.toContain('v0.3.0-preview.5')
    expect(source).toContain('EXPECTED_PLUGIN_COMMIT: ${{ github.sha }}')
    expect(source).toContain('repository: deepseek-ai/deepseek-harness')
    expect(source).toContain(`ref: ${HARNESS_COMMIT} # dsh-v0.1.2-alpha.3`)
    expect(source.match(/persist-credentials: false/gu)).toHaveLength(2)

    const actions = [...source.matchAll(/^\s*uses:\s*([^#\s]+)(?:\s+#.*)?$/gmu)]
      .map(match => match[1])
    expect(actions).toHaveLength(5)
    for (const action of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u)
    }
  })

  it('runs frozen checks and only the exact alpha.3 smoke', async () => {
    const source = await readFile(WORKFLOW, 'utf8')

    expect(source.match(/run: pnpm install --frozen-lockfile/gu)).toHaveLength(2)
    expect(source).toContain('run: pnpm run check')
    expect(source).toContain('- name: Build the exact official Harness profile')
    expect(source).toMatch(/working-directory: harness\s+run: pnpm run build:official/u)
    expect(source).toContain('DSH_HARNESS_ROOT: ${{ github.workspace }}/harness')
    expect(source).toContain("DSH_VOICE_SMOKE_INSTALL_ONLINE: '1'")
    expect(source).toContain('pnpm run smoke:harness:alpha3-auth | tee "$raw"')
    expect(source.indexOf('run: pnpm run build:official')).toBeLessThan(
      source.indexOf('pnpm run smoke:harness:alpha3-auth | tee "$raw"'),
    )
    expect(source).not.toContain('pnpm run smoke:harness:alpha2-auth | tee "$raw"')
    expect(source).not.toContain('2>&1')
  })

  it('accepts only the exact bounded receipt and public summary', async () => {
    const source = await readFile(WORKFLOW, 'utf8')
    const { receipt, result, summary } = await runValidator(source, [
      '$ node scripts/smoke-harness-alpha3-auth.mjs',
      JSON.stringify(RECEIPT),
    ])

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(receipt ?? '')).toEqual(RECEIPT)
    expect(summary).toContain('Exact-alpha.3 current-main authenticated Web proof: PASS')
    expect(summary).toContain('immutable Preview.5 is not rebound')
    expect(summary).toContain('Not proven: live or credential-backed Qwen')
    expect(summary).toContain(JSON.stringify(RECEIPT, null, 2))
    expect(source).toContain('Upload the sanitized alpha.3 receipt only')
    expect(source).toContain('archive: false')
    expect(source).toContain('retention-days: 30')
    expect(source).not.toMatch(/^\s*if:\s*always\(\)/mu)
    expect(source).not.toMatch(/^\s*path:\s*.*(?:raw|stdout|\.log)/mu)
  })

  it('rejects widened, malformed, private, or mismatched receipts', async () => {
    const source = await readFile(WORKFLOW, 'utf8')
    const banner = '$ node scripts/smoke-harness-alpha3-auth.mjs'
    const cases = [
      [banner, JSON.stringify({ ...RECEIPT, sessionId: 'must-not-publish' })],
      [banner, JSON.stringify({ ...RECEIPT, liveProvider: true })],
      [banner, JSON.stringify({ ...RECEIPT, pluginCommit: '0'.repeat(40) })],
      [banner, JSON.stringify({
        ...RECEIPT,
        dshClientArtifacts: { fileCount: 219, sha256: RECEIPT.dshClientArtifacts.sha256 },
      })],
      [banner, JSON.stringify({ ...RECEIPT, pluginTarballSha256: 'g'.repeat(64) })],
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
})
