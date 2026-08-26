import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('milestone package metadata', () => {
  it('declares the lazy browser face without claiming live audio', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      description?: string
      exports?: Record<string, unknown>
      dsh?: { client?: { platform?: string; inject?: string[]; immediately?: unknown; external?: unknown } }
    }
    expect(manifest.description).toBe(
      'Guarded DeepSeek Harness voice foundation with exact-session disclosure and proposal-only authority',
    )
    expect(manifest.description).not.toMatch(/live audio|full.duplex|production.ready/iu)
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
