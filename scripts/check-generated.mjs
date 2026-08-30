import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const BUILD_INPUTS = [
  'src',
  'package.json',
  'pnpm-lock.yaml',
  'tsconfig.json',
  'tsconfig.client.json',
  'tsconfig.client-types.json',
  'tsdown.config.ts',
  'scripts/clean.mjs',
]

const lines = value => value
  .split(/\r?\n/gu)
  .map(line => line.trim())
  .filter(Boolean)

const git = (cwd, args) => {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`
    throw new Error(`git ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout
}

export const generatedArtifactDrift = (cwd = process.cwd()) => {
  const tracked = lines(git(cwd, ['diff', '--no-ext-diff', '--name-only', '--', 'lib']))
  const untracked = lines(git(cwd, ['ls-files', '--others', '--', 'lib']))
  return [...new Set([...tracked, ...untracked])].sort()
}

export const assertGeneratedArtifactsCurrent = (cwd = process.cwd()) => {
  const inputTracked = lines(git(cwd, [
    'diff', '--no-ext-diff', '--name-only', '--', ...BUILD_INPUTS,
  ]))
  const inputUntracked = lines(git(cwd, [
    'ls-files', '--others', '--', ...BUILD_INPUTS,
  ]))
  const inputDrift = [...new Set([...inputTracked, ...inputUntracked])].sort()
  if (inputDrift.length > 0) {
    throw new Error([
      'Build inputs do not match the Git index:',
      ...inputDrift.map(file => `- ${file}`),
      'Stage or stash these files so lib is built from the exact candidate commit.',
    ].join('\n'))
  }

  const drift = generatedArtifactDrift(cwd)
  if (drift.length === 0) return
  throw new Error([
    'Generated artifacts do not match the Git index:',
    ...drift.map(file => `- ${file}`),
    'Run pnpm run build, review lib/, and stage the exact generated outputs.',
  ].join('\n'))
}

const invoked = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url

if (invoked) {
  try {
    assertGeneratedArtifactsCurrent()
    console.log('generated artifact check passed')
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
