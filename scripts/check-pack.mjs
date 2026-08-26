import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

const hostExports = await import(new URL('../lib/index.js', import.meta.url).href)
for (const internalName of [
  'DEFAULT_QWEN_READY_TIMEOUT_MS',
  'MAX_QWEN_CREDENTIAL_BYTES',
  'MAX_QWEN_READY_TIMEOUT_MS',
  'openQwenSession',
]) {
  assert.equal(
    Object.hasOwn(hostExports, internalName),
    false,
    `host package root must not expose internal provider transport export ${internalName}`,
  )
}

const clientArtifact = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
assert.doesNotMatch(clientArtifact, /[A-Za-z]:[\\/]/u, 'client artifact must not expose an absolute Windows path')
const packageRoot = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/u, '')
for (const form of new Set([
  packageRoot,
  packageRoot.replaceAll('\\', '/'),
  JSON.stringify(packageRoot).slice(1, -1),
])) {
  assert.equal(clientArtifact.includes(form), false, 'client artifact must not expose its build root')
}
assert.equal(clientArtifact.includes('sourceMappingURL='), false, 'client artifact must not point at an excluded source map')
const styles = []
let registration
const document = {
  querySelector(selector) {
    return styles.find(style => selector === `style[data-plugin-css=${JSON.stringify(style.dataset.pluginCss)}]`) ?? null
  },
  createElement(name) {
    assert.equal(name, 'style')
    return { dataset: {}, textContent: '' }
  },
  head: {
    appendChild(style) { styles.push(style) },
  },
}
const socketConstruction = []
runInNewContext(clientArtifact, {
  console,
  document,
  TextEncoder,
  URL,
  WebSocket: class {
    constructor(url) {
      socketConstruction.push(url)
      throw new Error('client bundle must not open a socket while materializing')
    }
  },
  window: {
    __ModuleLoader__: {
      load(value) { registration = value },
    },
  },
})
assert.equal(styles.length, 0, 'client wrapper must have no style side effect before materialization')
assert.equal(registration?.id, 'dsh-guarded-live-voice', 'client wrapper id must equal the package name')
assert.equal(typeof registration?.factory, 'function', 'client wrapper must register one factory')
const moduleRequests = []
const loadFace = () => registration.factory((specifier) => {
  moduleRequests.push(specifier)
  assert.equal(specifier, 'react/jsx-runtime', `unexpected client module-table request: ${specifier}`)
  return { jsx: () => null, jsxs: () => null }
})
assert.deepEqual(Object.keys(loadFace()).sort(), ['apply', 'inject'])
assert.equal(styles.length, 1, 'materialization must inject one tagged stylesheet')
assert.equal(styles[0].dataset.plugin, 'dsh-guarded-live-voice')
assert.equal(styles[0].dataset.pluginCss, 'dsh-guarded-live-voice/voice.module.css')
assert.ok(styles[0].textContent.length > 0, 'injected stylesheet must not be empty')
assert.deepEqual(Object.keys(loadFace()).sort(), ['apply', 'inject'])
assert.equal(styles.length, 1, 're-materialization must deduplicate the tagged stylesheet')
assert.deepEqual([...new Set(moduleRequests)], ['react/jsx-runtime'])
assert.deepEqual(socketConstruction, [], 'materialization must not touch the voice transport')

const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : 'npm'
const args = process.platform === 'win32'
  ? ['/d', '/s', '/c', 'npm pack --dry-run --ignore-scripts --json']
  : ['pack', '--dry-run', '--ignore-scripts', '--json']
const output = execFileSync(executable, args, {
  encoding: 'utf8',
})
const [report] = JSON.parse(output)
const names = new Set(report.files.map(file => file.path))
const required = [
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'cordis.patch.yml',
  'lib/index.js',
  'lib/index.d.ts',
  'lib/client.js',
  'lib/types/client/index.d.ts',
  'package.json',
]
const missing = required.filter(name => !names.has(name))
if (missing.length > 0) {
  throw new Error(`packed artifact is missing: ${missing.join(', ')}`)
}
const forbidden = [...names].filter(name =>
  name.startsWith('tests/')
  || name.startsWith('src/')
  || name === '.env'
  || name === 'lib/client.js.map')
if (forbidden.length > 0) {
  throw new Error(`packed artifact includes forbidden files: ${forbidden.join(', ')}`)
}
process.stdout.write(`pack check passed (${report.files.length} files, ${report.unpackedSize} bytes)\n`)
