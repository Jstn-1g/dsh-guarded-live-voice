import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('preview package metadata', () => {
  it('declares the DSH Live Voice browser face without claiming full duplex', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      description?: string
      exports?: Record<string, unknown>
      dsh?: { client?: { platform?: string; inject?: string[]; immediately?: unknown; external?: unknown } }
    }
    expect(manifest.description).toBe(
      'Safety-first DeepSeek Harness live voice preview with exact-session consent and one bounded manual audio turn',
    )
    expect(manifest.description).not.toMatch(/full.duplex|continuous conversation|production.ready/iu)
    expect(manifest.exports?.['./client']).toEqual({
      types: './lib/types/client/index.d.ts',
      default: './lib/client.js',
    })
    expect(manifest.dsh?.client).toEqual({
      platform: 'web',
      inject: [
        '@deepseek-ai/dsh-client-runtime',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
    })
    expect(manifest.dsh?.client?.immediately).toBeUndefined()
    expect(manifest.dsh?.client?.external).toBeUndefined()
  })
})
