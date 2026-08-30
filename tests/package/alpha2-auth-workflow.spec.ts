import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const WORKFLOW = new URL('../../.github/workflows/alpha2-auth-proof.yml', import.meta.url)
const README = new URL('../../README.md', import.meta.url)
const TESTING = new URL('../../TESTING.md', import.meta.url)
const PLUGIN_COMMIT = 'db9059ffdc10faceb33434c72fb329203bf9835a'
const HARNESS_COMMIT = '0a53fb55bea101816fa226bb964ae2bed71c343b'
const WSL_CLIENT_SHA = '2323648b998b9a899ab972ab5ad80c9cf7f87d0ff81c9c9a1dcd0ae6d5eed340'
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
    sha256: '95960c93ea46130e04dbd4d9e73427c45bcc1ff1f813de58a44747f5cb6443a1',
  },
  dshCommit: HARNESS_COMMIT,
  dshTag: 'dsh-v0.1.2-alpha.2',
  dshVersion: '0.1.2-alpha.2',
  dshWebIndexSha256: 'd666c73f848b9c4a72501750750194231fa97bdb507f17b8b3bf692fac1eaab9',
  dshWorktreeDirty: false,
  launchTokenExchanged: true,
  liveCredential: false,
  liveProvider: false,
  officialDshWebProfile: true,
  os: { platform: 'linux', release: '6.6.114.1-microsoft-standard-WSL2' },
  runtime: { node: 'v24.12.0', pnpm: '11.7.0' },
  packagedDesktop: false,
  physicalMicrophone: false,
  physicalSpeaker: false,
  pluginCommit: PLUGIN_COMMIT,
  pluginTarballSha256: 'acbe952d55866eb62d6583975ad1626b4800ed76c889a60368ece1d1053cb6bd',
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
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-voice-alpha2-receipt-'))
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

describe('exact-alpha.2 authenticated Web proof workflow', () => {
  it('is a read-only manual reproduction of immutable public inputs', async () => {
    const source = await readFile(WORKFLOW, 'utf8')

    expect(source).toMatch(/^on:\r?\n {2}workflow_dispatch:\r?$/mu)
    expect(source).not.toMatch(/^ {2}(?:push|pull_request):/mu)
    expect(source).toMatch(/^permissions:\r?\n {2}contents: read\r?\n\r?\njobs:/mu)
    expect(source).not.toContain('${{ secrets.')
    expect(source).toContain('repository: Jstn-1g/dsh-live-voice')
    expect(source).toContain(`ref: ${PLUGIN_COMMIT} # v0.3.0-preview.4`)
    expect(source).toContain('repository: deepseek-ai/deepseek-harness')
    expect(source).toContain(`ref: ${HARNESS_COMMIT} # dsh-v0.1.2-alpha.2`)
    expect(source.match(/persist-credentials: false/gu)).toHaveLength(2)

    const actions = [...source.matchAll(/^\s*uses:\s*([^#\s]+)(?:\s+#.*)?$/gmu)]
      .map(match => match[1])
    expect(actions).toHaveLength(5)
    for (const action of actions) {
      expect(action).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u)
    }
  })

  it('runs frozen checks and only the separately pinned alpha.2 smoke', async () => {
    const source = await readFile(WORKFLOW, 'utf8')

    expect(source.match(/run: pnpm install --frozen-lockfile/gu)).toHaveLength(2)
    expect(source).toContain('run: pnpm run check')
    expect(source).toContain('run: pnpm run build:official')
    expect(source).toContain('DSH_HARNESS_ROOT: ${{ github.workspace }}/harness')
    expect(source).toContain("DSH_VOICE_SMOKE_INSTALL_ONLINE: '1'")
    expect(source).toContain('pnpm run smoke:harness:alpha2-auth | tee "$raw"')
    expect(source).not.toContain('pnpm run smoke:harness:alpha-auth | tee "$raw"')
    expect(source).not.toContain('2>&1')
  })

  it('accepts the exact receipt and renders only the bounded summary', async () => {
    const source = await readFile(WORKFLOW, 'utf8')
    const { receipt, result, summary } = await runValidator(source, [
      '$ node scripts/smoke-harness-alpha2-auth.mjs',
      JSON.stringify(RECEIPT),
    ])

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(receipt ?? '')).toEqual(RECEIPT)
    expect(summary).toContain('Exact-alpha.2 authenticated Web proof: PASS')
    expect(summary).toContain('Not proven: live or credential-backed Qwen')
    expect(summary).toContain(JSON.stringify(RECEIPT, null, 2))
    expect(source).toContain('Upload the sanitized alpha.2 receipt only')
    expect(source).toContain(
      'path: ${{ runner.temp }}/dsh-live-voice-alpha2-auth-receipt.json',
    )
    expect(source).toContain('archive: false')
    expect(source).toContain('retention-days: 30')
    expect(source).not.toMatch(/^\s*if:\s*always\(\)/mu)
    expect(source).not.toMatch(/^\s*path:\s*.*(?:raw|stdout|\.log)/mu)
  })

  it('preserves a valid environment-scoped client digest', async () => {
    const source = await readFile(WORKFLOW, 'utf8')
    const environmentScoped = {
      ...RECEIPT,
      dshClientArtifacts: { fileCount: 220, sha256: WSL_CLIENT_SHA },
    }
    const { receipt, result, summary } = await runValidator(source, [
      '$ node scripts/smoke-harness-alpha2-auth.mjs',
      JSON.stringify(environmentScoped),
    ])

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(receipt ?? '')).toEqual(environmentScoped)
    expect(summary).toContain(WSL_CLIENT_SHA)
  })

  it('rejects unsafe, widened, malformed, or unexpected receipts', async () => {
    const source = await readFile(WORKFLOW, 'utf8')
    const banner = '$ node scripts/smoke-harness-alpha2-auth.mjs'
    const cases = [
      [banner, JSON.stringify({ ...RECEIPT, sessionId: 'must-not-publish' })],
      [banner, JSON.stringify({ ...RECEIPT, liveProvider: true })],
      [banner, JSON.stringify({ ...RECEIPT, pluginCommit: '0'.repeat(40) })],
      [banner, JSON.stringify({
        ...RECEIPT,
        dshClientArtifacts: { fileCount: 219, sha256: RECEIPT.dshClientArtifacts.sha256 },
      })],
      [banner, JSON.stringify({
        ...RECEIPT,
        dshClientArtifacts: { fileCount: 220, sha256: 'g'.repeat(64) },
      })],
      [banner, JSON.stringify({
        ...RECEIPT,
        dshClientArtifacts: { ...RECEIPT.dshClientArtifacts, path: '/private' },
      })],
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

  it('is the current discoverable no-secret proof without rebinding preview.3', async () => {
    const readme = await readFile(README, 'utf8')
    const testing = await readFile(TESTING, 'utf8')
    const readmeProse = readme.replace(/\s+/gu, ' ')

    expect(readme).toContain(
      '[`Exact-alpha.2 authenticated Web proof`](https://github.com/Jstn-1g/dsh-live-voice/actions/workflows/alpha2-auth-proof.yml)',
    )
    expect(readmeProse).toContain('remains pinned to immutable preview.3')
    expect(testing).toContain('alpha2-auth-proof.yml')
    expect(testing).toContain('alpha-auth-proof.yml')
    expect(testing).toContain('immutable preview.3')
  })
})
