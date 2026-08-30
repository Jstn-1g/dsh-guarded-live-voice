import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = fileURLToPath(new URL('../../scripts/check-generated.mjs', import.meta.url))

const git = (cwd: string, args: string[]) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stderr).toBe(0)
}

const runGate = (cwd: string) => spawnSync(process.execPath, [SCRIPT], {
  cwd,
  encoding: 'utf8',
  windowsHide: true,
})

describe('generated artifact freshness gate', () => {
  it('compares tracked and untracked lib output with the Git index', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-live-voice-generated-'))
    try {
      git(cwd, ['init', '--quiet'])
      await mkdir(join(cwd, 'lib'))
      await mkdir(join(cwd, 'src'))
      await writeFile(join(cwd, 'lib', 'index.js'), 'export const value = 1\n')
      await writeFile(join(cwd, 'src', 'index.ts'), 'export const value = 1\n')
      git(cwd, ['add', '--', 'lib/index.js', 'src/index.ts'])

      const current = runGate(cwd)
      expect(current.status, current.stderr).toBe(0)
      expect(current.stdout).toContain('generated artifact check passed')

      await writeFile(join(cwd, 'src', 'index.ts'), 'export const value = 2\n')
      await writeFile(join(cwd, 'lib', 'index.js'), 'export const value = 2\n')
      git(cwd, ['add', '--', 'lib/index.js'])

      const mismatchedInput = runGate(cwd)
      expect(mismatchedInput.status).toBe(1)
      expect(mismatchedInput.stderr).toContain('Build inputs do not match the Git index')
      expect(mismatchedInput.stderr).toContain('- src/index.ts')

      await writeFile(join(cwd, 'src', 'new.ts'), 'export const added = true\n')
      expect(runGate(cwd).stderr).toContain('- src/new.ts')
      git(cwd, ['add', '--', 'src'])
      expect(runGate(cwd).status).toBe(0)

      await writeFile(join(cwd, '.gitignore'), 'lib/ignored.js\n')
      git(cwd, ['add', '--', '.gitignore'])
      await writeFile(join(cwd, 'lib', 'index.js'), 'export const value = 3\n')
      await writeFile(join(cwd, 'lib', 'extra.js'), 'export const extra = true\n')
      await writeFile(join(cwd, 'lib', 'ignored.js'), 'export const ignored = true\n')

      const stale = runGate(cwd)
      expect(stale.status).toBe(1)
      expect(stale.stderr).toContain('- lib/extra.js')
      expect(stale.stderr).toContain('- lib/ignored.js')
      expect(stale.stderr).toContain('- lib/index.js')
      expect(stale.stderr).toMatch(
        /Run pnpm run build, review lib\/, and stage the exact generated outputs/u,
      )

      await rm(join(cwd, 'lib', 'ignored.js'))
      git(cwd, ['add', '--', 'lib'])
      expect(runGate(cwd).status).toBe(0)

      await rm(join(cwd, 'lib', 'extra.js'))
      expect(runGate(cwd).stderr).toContain('- lib/extra.js')
      git(cwd, ['add', '--update', '--', 'lib'])
      expect(runGate(cwd).status).toBe(0)
    }
    finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('runs the freshness gate after the build in pnpm check', async () => {
    const manifest = JSON.parse(await readFile(
      new URL('../../package.json', import.meta.url),
      'utf8',
    )) as { scripts?: Record<string, string> }
    const scripts = manifest.scripts ?? {}

    expect(scripts['check:generated']).toBe('node scripts/check-generated.mjs')
    expect(scripts['check:scripts']).toContain('node --check scripts/check-generated.mjs')
    expect(scripts.check).toContain('pnpm run build && pnpm run check:generated')
  })
})
