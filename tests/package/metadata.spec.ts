import { readFile } from 'node:fs/promises'
import { satisfies } from 'semver'
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
        '@deepseek-ai/dsh-client-ui-renderer',
        '@deepseek-ai/dsh-client-locale',
        '@deepseek-ai/dsh-client-ui-conversation',
      ],
    })
    expect(manifest.dsh?.client?.immediately).toBeUndefined()
    expect(manifest.dsh?.client?.external).toBeUndefined()
  })

  it('uses the renderer owner and admits the source-verified alpha package graph', async () => {
    const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8')) as {
      dsh?: { client?: { inject?: string[] } }
      engines?: { node?: string }
      peerDependencies?: Record<string, string>
    }
    const peers = manifest.peerDependencies ?? {}
    expect(manifest.engines?.node).toBe('^22.19.0 || >=24.12.0')
    expect(satisfies('22.22.2', manifest.engines?.node ?? '')).toBe(true)
    expect(satisfies('24.11.1', manifest.engines?.node ?? '')).toBe(false)
    expect(satisfies('24.19.0', manifest.engines?.node ?? '')).toBe(true)
    expect(manifest.dsh?.client?.inject).not.toContain('@deepseek-ai/dsh-client-runtime')
    expect(peers).not.toHaveProperty('@deepseek-ai/dsh-client-runtime')
    expect(peers['@deepseek-ai/dsh-client-ui-renderer']).toBe('^0.1.1-rc.1 || 0.1.2-alpha.1')
    for (const [name, range] of Object.entries(peers)) {
      if (name.startsWith('@deepseek-ai/dsh-')) {
        expect(range, name).toBe('^0.1.1-rc.1 || 0.1.2-alpha.1')
        expect(satisfies('0.1.1-rc.2', range), `${name} accepts current rc`).toBe(true)
        expect(satisfies('0.1.2-alpha.1', range), `${name} accepts verified alpha`).toBe(true)
        expect(satisfies('0.1.2-alpha.2', range), `${name} rejects unverified later alpha`).toBe(false)
      }
    }
  })
})
