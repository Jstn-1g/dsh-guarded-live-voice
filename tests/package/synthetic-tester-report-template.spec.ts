import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const TEMPLATE = new URL(
  '../../.github/ISSUE_TEMPLATE/synthetic-tester-report.yml',
  import.meta.url,
)
const README = new URL('../../README.md', import.meta.url)

const field = (source: string, id: string): string => {
  const marker = `    id: ${id}\n`
  const start = source.indexOf(marker)
  expect(start, `${id} exists`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n  - type:', start + marker.length)
  return source.slice(start, end < 0 ? undefined : end)
}

describe('two-minute synthetic tester report contract', () => {
  it('preflights pnpm and links directly to the focused form', async () => {
    const source = (await readFile(README, 'utf8')).replace(/\r\n/gu, '\n')
    const start = source.indexOf('## Two-minute synthetic test')
    const end = source.indexOf('\n## ', start + 3)
    const quickstart = source.slice(start, end)
    const preflight = quickstart.indexOf('pnpm --version')
    const install = quickstart.indexOf(
      'dsh plugin --profile web add github:Jstn-1g/dsh-live-voice#v0.3.0-preview.5',
    )

    expect(quickstart).toContain('pnpm on `PATH`')
    expect(preflight).toBeGreaterThanOrEqual(0)
    expect(install).toBeGreaterThan(preflight)
    expect(quickstart).toContain('issues/new?template=synthetic-tester-report.yml')
  })

  it('binds a self-run report to an exact environment and conversion stage', async () => {
    const source = (await readFile(TEMPLATE, 'utf8')).replace(/\r\n/gu, '\n')

    for (const id of [
      'voice-version',
      'harness-version',
      'browser-version',
      'windows-version',
      'furthest-stage',
      'stopping-point',
      'outcome',
    ]) {
      expect(field(source, id), `${id} is required`).toMatch(
        /\n    validations:\n      required: true(?:\n|$)/u,
      )
    }

    expect(field(source, 'voice-version')).toContain('value: v0.3.0-preview.5')
    expect(field(source, 'harness-version')).toContain('Run dsh --version')

    const stage = field(source, 'furthest-stage')
    expect(stage).toContain('Install command not started')
    expect(stage).toContain('Full test completed')

    const observed = field(source, 'observed')
    expect(observed).toContain('The install command completed.')
    expect(observed).toContain('Open DSH Live Voice appeared.')
    expect(observed).toContain('Local deterministic synthetic demo')
    expect(observed).toContain('the short chime appeared.')
    expect(observed).toContain('did not submit it.')
    expect(observed).not.toContain('required: true')
  })

  it('requires first-hand, privacy-safe evidence without general gate fields', async () => {
    const source = (await readFile(TEMPLATE, 'utf8')).replace(/\r\n/gu, '\n')
    const attestations = field(source, 'attestations')

    expect(attestations).toContain('I personally ran this exact path')
    expect(attestations).toContain('not a download-only or second-hand report')
    expect(attestations).toContain('credentials, recordings, real transcripts')
    expect(attestations).toContain('Session IDs')
    expect(attestations).toContain('absolute local paths')
    expect(attestations.match(/required: true/gu)).toHaveLength(2)

    expect(source).not.toContain('provider-boundary')
    expect(source).not.toContain('artifact-identity')
    expect(source).not.toContain('state-transitions')
  })
})
