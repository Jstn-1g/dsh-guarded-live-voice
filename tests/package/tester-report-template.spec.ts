import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const TEMPLATE = new URL('../../.github/ISSUE_TEMPLATE/tester-report.yml', import.meta.url)

const field = (source: string, id: string): string => {
  const marker = `    id: ${id}\n`
  const start = source.indexOf(marker)
  expect(start, `${id} exists`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n  - type:', start + marker.length)
  return source.slice(start, end < 0 ? undefined : end)
}

describe('preview tester report contract', () => {
  it('requires exact artifact, environment, lifecycle, and provider-boundary evidence', async () => {
    const source = (await readFile(TEMPLATE, 'utf8')).replace(/\r\n/gu, '\n')
    const required = [
      'scope',
      'artifact-kind',
      'voice-version',
      'harness-version',
      'artifact-identity',
      'environment',
      'procedure',
      'state-transitions',
      'provider-boundary',
      'outcome',
      'observations',
    ]

    for (const id of required) {
      expect(field(source, id), `${id} is required`).toMatch(/\n    validations:\n      required: true(?:\n|$)/u)
    }

    expect(field(source, 'artifact-kind')).toContain('Source-built DSH Web profile')
    expect(field(source, 'artifact-kind')).toContain('Served-Web packaged shell')
    expect(field(source, 'artifact-kind')).toContain('file:// + IPC packaged shell')
    expect(field(source, 'artifact-identity')).toContain('sanitized install command')
    expect(field(source, 'artifact-identity')).not.toMatch(/source path/iu)
    expect(field(source, 'state-transitions')).toContain('Not applicable')

    const provider = field(source, 'provider-boundary')
    expect(provider).toContain('allowlist check of outbound request field names and types')
    for (const forbidden of [
      'DSH history',
      'files',
      'Workspace or system instructions',
      'tool schemas',
      'memory',
      'arbitrary text',
    ]) {
      expect(provider, forbidden).toContain(forbidden)
    }
    expect(provider).toContain('never paste values or a provider payload')
  })

  it('keeps secret and identifying evidence out of public reports', async () => {
    const source = (await readFile(TEMPLATE, 'utf8')).replace(/\r\n/gu, '\n')
    const privacy = field(source, 'boundaries')

    expect(privacy).toContain('credentials, recordings, private transcripts, workspace content')
    expect(privacy).toContain('Session IDs, challenges, launch tokens, cookies, raw provider payloads')
    expect(privacy.match(/required: true/gu)).toHaveLength(3)
  })
})
