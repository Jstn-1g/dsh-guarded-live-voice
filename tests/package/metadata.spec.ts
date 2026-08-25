import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('milestone package metadata', () => {
  it('describes only the implemented host foundation and declares no client', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      description?: string
      dsh?: { client?: unknown }
    }
    expect(manifest.description).toBe(
      'Host-side protocol and authority foundation for a planned DeepSeek Harness voice plugin',
    )
    expect(manifest.dsh?.client).toBeUndefined()
  })
})
