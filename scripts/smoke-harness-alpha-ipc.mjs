import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const EXPECTED_ALPHA_COMMIT = 'cd5ef8148158c3a752a658978873241fdf8e2bbc'
const EXPECTED_ALPHA_VERSION = '0.1.2-alpha.1'
const FRESH_DEPENDENCY_PROVENANCE = 'fresh-frozen-lockfile'
const RECEIPT_PREFIX = 'DSH_LIVE_VOICE_ALPHA_IPC_RECEIPT='
const scriptRoot = dirname(fileURLToPath(import.meta.url))
const pluginRoot = resolve(scriptRoot, '..')
const harnessRoot = resolveHarnessRoot(process.env.DSH_HARNESS_ROOT)
const targetRelative = `packages/api/gateway/tests/dsh-live-voice-alpha-ipc.${process.pid}.${randomUUID()}.synthetic.spec.ts`
const target = join(harnessRoot, targetRelative)
const template = join(scriptRoot, 'fixtures', 'alpha-ipc.synthetic.spec.ts')
const fixtureRoot = join(scriptRoot, 'fixtures', 'alpha-ipc-typert')

const alphaBuiltEntrypointsSha256 = assertExactAlpha()
assertGitRoot(pluginRoot, 'DSH Live Voice')
assertExistingOwnedPath(template, pluginRoot, 'IPC proof template')
assertExistingOwnedPath(fixtureRoot, pluginRoot, 'Typert fixture root')
assertNewOwnedPath(target, harnessRoot, 'temporary exact-alpha spec')
if (existsSync(target)) throw new Error(`refusing to replace existing upstream file: ${targetRelative}`)
const before = gitStatus()
if (before !== '') throw new Error('exact-alpha checkout must be clean before the IPC-equivalent smoke')
const pluginRevision = git(pluginRoot, ['rev-parse', 'HEAD']).trim()
const pluginStatus = git(pluginRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
const pluginDirty = pluginStatus !== ''
const allowDirty = process.env.DSH_LIVE_VOICE_ALLOW_DIRTY_IPC_SMOKE === '1'
if (pluginDirty && !allowDirty) {
  throw new Error('DSH Live Voice checkout must be clean; set DSH_LIVE_VOICE_ALLOW_DIRTY_IPC_SMOKE=1 only for local iteration')
}
const requestedProvenance = process.env.DSH_LIVE_VOICE_DEPENDENCY_PROVENANCE
if (requestedProvenance !== undefined && requestedProvenance !== FRESH_DEPENDENCY_PROVENANCE) {
  throw new Error('unsupported DSH_LIVE_VOICE_DEPENDENCY_PROVENANCE value')
}
const dependencyProvenance = requestedProvenance === FRESH_DEPENDENCY_PROVENANCE
  && process.env.GITHUB_ACTIONS === 'true'
  && process.env.CI === 'true'
  ? FRESH_DEPENDENCY_PROVENANCE
  : 'local-unverified'
const importBase = normalizeSpecifier(relative(dirname(target), join(pluginRoot, 'src')))
const source = renderTemplate(readFileSync(template, 'utf8'), importBase)
const taskTempRoot = realpathSync(tmpdir())

let result
let executionError
let isolated
let isolatedDshHome
const cleanupErrors = []
try {
  isolated = mkdtempSync(join(taskTempRoot, 'dsh-live-voice-alpha-ipc-'))
  isolated = realpathSync(isolated)
  assertStrictDescendant(isolated, taskTempRoot, 'isolated IPC smoke directory')
  isolatedDshHome = join(isolated, 'dsh-home')
  mkdirSync(isolatedDshHome)
  writeFileSync(target, source, { encoding: 'utf8', flag: 'wx' })
  const vitest = join(harnessRoot, 'node_modules', 'vitest', 'vitest.mjs')
  if (!existsSync(vitest)) throw new Error('exact Harness checkout has no linked Vitest entry')
  result = spawnSync(process.execPath, [
    vitest, 'run', targetRelative, '--config', 'vitest.config.ts', '--reporter=verbose',
  ], {
    cwd: harnessRoot,
    encoding: 'utf8',
    env: childEnvironment({
      DSH_LIVE_VOICE_IPC_FIXTURE_ROOT: fixtureRoot,
      DSH_LIVE_VOICE_EXPECTED_ALPHA_COMMIT: EXPECTED_ALPHA_COMMIT,
      DSH_LIVE_VOICE_ALPHA_BUILT_ENTRYPOINTS_SHA256: alphaBuiltEntrypointsSha256,
      DSH_LIVE_VOICE_REVISION: pluginRevision,
      DSH_LIVE_VOICE_PLUGIN_DIRTY: String(pluginDirty),
      DSH_LIVE_VOICE_DEPENDENCY_PROVENANCE: dependencyProvenance,
    }, isolated, isolatedDshHome),
    maxBuffer: 32 * 1024 * 1024,
    timeout: 180_000,
    killSignal: 'SIGTERM',
  })
} catch (error) {
  executionError = error
} finally {
  try {
    if (existsSync(target)) unlinkSync(target)
  } catch (error) {
    cleanupErrors.push(error)
  }
  try {
    if (isolated !== undefined && existsSync(isolated)) {
      assertStrictDescendant(realpathSync(isolated), taskTempRoot, 'isolated IPC smoke cleanup directory')
      rmSync(isolated, { recursive: true, force: true })
    }
  } catch (error) {
    cleanupErrors.push(error)
  }
}

try {
  const after = gitStatus()
  if (after !== '') cleanupErrors.push(new Error('exact-alpha smoke did not restore the upstream checkout to a clean status'))
} catch (error) {
  cleanupErrors.push(error)
}
if (executionError !== undefined) {
  throwWithCleanup(executionError, cleanupErrors)
}
if (result?.error !== undefined) {
  throwWithCleanup(result.error, cleanupErrors)
}
if (result?.status !== 0) {
  if (result?.stdout !== undefined) process.stdout.write(withoutReceipt(result.stdout))
  if (result?.stderr !== undefined) process.stderr.write(result.stderr)
  throwWithCleanup(
    new Error(`exact-alpha IPC-equivalent smoke failed with exit code ${String(result?.status)}`),
    cleanupErrors,
  )
}
if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'exact-alpha IPC-equivalent smoke cleanup failed')
const receipt = parseReceipt(result.stdout)
const expectedPublishable = !pluginDirty && dependencyProvenance === FRESH_DEPENDENCY_PROVENANCE
if (receipt.exactAlphaCommit !== EXPECTED_ALPHA_COMMIT
  || receipt.exactAlphaBuiltEntrypointsSha256 !== alphaBuiltEntrypointsSha256
  || receipt.pluginRevision !== pluginRevision
  || receipt.pluginDirty !== pluginDirty
  || receipt.dependencyProvenance !== dependencyProvenance
  || receipt.publishable !== expectedPublishable
  || receipt.workerTunnelNullOriginBlocked !== true
  || receipt.strictDescriptors !== 6
  || receipt.globalFetchCalls !== 0
  || receipt.webSocketConstructions !== 0
  || receipt.credentialBackedProvider !== false
  || receipt.liveProvider !== false
  || receipt.physicalAudio !== false
  || receipt.audibleLatency !== false
  || receipt.electron !== false
  || receipt.tauri !== false
  || receipt.packagedDesktop !== false
  || receipt.officialSeamConfirmation !== false
  || receipt.streamCancellationAbortObserved !== true
  || receipt.addressedVoiceStreamTeardownObserved !== true) {
  throw new Error('exact-alpha IPC-equivalent smoke receipt does not match the verified source/provenance state')
}
process.stdout.write(result.stdout)
if (result.stderr !== '') process.stderr.write(result.stderr)

function resolveHarnessRoot(input) {
  if (input === undefined || input.trim() === '') {
    throw new Error('DSH_HARNESS_ROOT must point to an exact deepseek-harness checkout')
  }
  if (!isAbsolute(input)) throw new Error('DSH_HARNESS_ROOT must be an absolute path')
  return resolve(input)
}

function assertExactAlpha() {
  assertGitRoot(harnessRoot, 'exact-alpha Harness')
  if (!existsSync(join(harnessRoot, 'pnpm-lock.yaml'))) throw new Error('DSH_HARNESS_ROOT is not a Harness workspace')
  const commit = git(harnessRoot, ['rev-parse', 'HEAD']).trim()
  if (commit !== EXPECTED_ALPHA_COMMIT) {
    throw new Error(`expected exact dsh-v0.1.2-alpha.1 commit ${EXPECTED_ALPHA_COMMIT}, got ${commit}`)
  }
  for (const packagePath of [
    'packages/client/connection/package.json',
    'packages/api/gateway/package.json',
    'packages/core/session/package.json',
    'packages/experimental/webworker-runtime/package.json',
  ]) {
    const manifest = JSON.parse(readFileSync(join(harnessRoot, packagePath), 'utf8'))
    if (manifest.version !== EXPECTED_ALPHA_VERSION) {
      throw new Error(`${packagePath} is ${String(manifest.version)}, expected ${EXPECTED_ALPHA_VERSION}`)
    }
  }
  if (!existsSync(join(harnessRoot, 'node_modules', '.pnpm'))) {
    throw new Error('exact Harness checkout dependencies are not installed; run pnpm install there first')
  }
  const builtEntrypoints = [
    'packages/client/connection/lib/index.js',
    'packages/client/connection/lib/client.js',
    'packages/api/gateway/lib/index.js',
    'packages/api/gateway/lib/client.js',
    'packages/host/webserver/lib/index.js',
    'packages/core/session/lib/index.js',
    'packages/typert/protocol/lib/index.js',
    'packages/typert/registry/lib/index.js',
    'vendor/cordis/lib/index.js',
  ]
  const digest = createHash('sha256')
  for (const relativePath of builtEntrypoints) {
    const absolutePath = join(harnessRoot, relativePath)
    if (!existsSync(absolutePath)) {
      throw new Error(`exact Harness built entrypoint is missing: ${relativePath}; run pnpm run build:lib there first`)
    }
    digest.update(relativePath)
    digest.update('\0')
    digest.update(readFileSync(absolutePath))
    digest.update('\0')
  }
  return digest.digest('hex')
}

function assertGitRoot(root, label) {
  const expected = realpathSync(root)
  const actual = realpathSync(resolve(git(root, ['rev-parse', '--show-toplevel']).trim()))
  if (!samePath(actual, expected)) throw new Error(`${label} path is not its Git worktree root`)
}

function assertExistingOwnedPath(candidate, owner, label) {
  if (!existsSync(candidate)) throw new Error(`${label} does not exist`)
  assertStrictDescendant(realpathSync(candidate), realpathSync(owner), label)
}

function assertNewOwnedPath(candidate, owner, label) {
  assertStrictDescendant(resolve(candidate), realpathSync(owner), label)
  assertStrictDescendant(realpathSync(dirname(candidate)), realpathSync(owner), `${label} parent`)
}

function assertStrictDescendant(candidate, owner, label) {
  const remainder = relative(owner, candidate)
  if (remainder === '' || remainder === '..' || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${label} must resolve strictly inside its owning worktree`)
  }
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLocaleLowerCase('en-US') === right.toLocaleLowerCase('en-US')
    : left === right
}

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    env: commandEnvironment(),
  })
}

function gitStatus() {
  return git(harnessRoot, ['status', '--porcelain=v1', '--untracked-files=all'])
}

function normalizeSpecifier(path) {
  const normalized = path.replaceAll('\\', '/')
  return normalized.startsWith('.') ? normalized : `./${normalized}`
}

function renderTemplate(source, importBase) {
  const modules = [
    'host/authority.ts',
    'host/consent.ts',
    'host/manual-turn.ts',
    'host/provider.ts',
    'host/session-manager.ts',
    'shared/errors.ts',
    'shared/audio.ts',
  ]
  let rendered = source
  for (const module of modules) {
    rendered = rendered.replaceAll(
      `'__VOICE_IMPORT_BASE__/${module}'`,
      JSON.stringify(`${importBase}/${module}`),
    )
  }
  if (rendered.includes('__VOICE_IMPORT_BASE__')) throw new Error('IPC fixture contains an unresolved import marker')
  return rendered
}

function childEnvironment(probe, isolatedRoot, isolatedDshHome) {
  const env = { ...commandEnvironment(), ...probe }
  env.CI = '1'
  env.NO_COLOR = '1'
  env.TEMP = isolatedRoot
  env.TMP = isolatedRoot
  env.HOME = isolatedRoot
  env.USERPROFILE = isolatedRoot
  env.DSH_HOME = isolatedDshHome
  return env
}

function commandEnvironment() {
  const env = {}
  for (const name of ['PATH', 'Path', 'SystemRoot', 'ComSpec', 'PATHEXT', 'WINDIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  return env
}

function withoutReceipt(output) {
  return output.split(/(?<=\n)/u).filter(line => !line.includes(RECEIPT_PREFIX)).join('')
}

function parseReceipt(output) {
  const rows = output.split(/\r?\n/u)
    .map(line => line.trim())
    .filter(line => line.startsWith(RECEIPT_PREFIX))
  if (rows.length !== 1) {
    throw new Error(`exact-alpha IPC-equivalent smoke must emit exactly one sanitized receipt, got ${String(rows.length)}`)
  }
  let value
  try {
    value = JSON.parse(rows[0].slice(RECEIPT_PREFIX.length))
  } catch (error) {
    throw new Error('exact-alpha IPC-equivalent smoke emitted malformed receipt JSON', { cause: error })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('exact-alpha IPC-equivalent smoke receipt must be a JSON object')
  }
  return value
}

function throwWithCleanup(primary, errors) {
  if (errors.length === 0) throw primary
  throw new AggregateError(
    [primary, ...errors],
    `exact-alpha IPC-equivalent smoke failed; ${String(errors.length)} cleanup failure(s) followed`,
    { cause: primary },
  )
}
