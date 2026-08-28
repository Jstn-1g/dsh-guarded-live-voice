/**
 * Disposable, fake-only composition smoke for the packed voice plugin.
 *
 * This is deliberately not shipped. It installs the current tarball through
 * the official DSH CLI, mounts it with the official Web bundle, and drives one
 * real workspace/session/gateway turn against a deterministic loopback peer.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'

const PROFILE = 'dsh-live-voice-fake-qwen-smoke'
const PLUGIN_NAME = 'dsh-live-voice'
const ROUTE = '/guarded-voice'
const MODEL = 'qwen-audio-3.0-realtime-plus'
const WORKSPACE_SLUG = 'voice-smoke'
const FAKE_CREDENTIAL = 'deterministic-fake-qwen-token'
const EXPECTED_AUDIO = Buffer.from([1, 0, 2, 0])
const EXPECTED_USER_TRANSCRIPT = 'deterministic user transcript'
const EXPECTED_ASSISTANT_TRANSCRIPT = 'deterministic assistant transcript'
const allowInstallNetwork = process.env.DSH_VOICE_SMOKE_INSTALL_ONLINE === '1'
const PROCESS_TIMEOUT_MS = 180_000
const READY_TIMEOUT_MS = 180_000
// Official Harness profile startup can continue warming services after the HTTP
// listener is ready on loaded Windows hosts. Keep the voice turn bounded while
// allowing those first profile RPCs to settle.
const TURN_TIMEOUT_MS = 60_000
const STOP_TIMEOUT_MS = 10_000
const OUTPUT_LIMIT = 64 * 1024
const SAFE_INHERITED_ENV_NAME = /^(?:appdata|commonprogramfiles(?:\(x86\)|w6432)?|comspec|force_color|lang|lc_all|localappdata|no_color|number_of_processors|os|path|pathext|processor_architecture|programdata|programfiles(?:\(x86\))?|programw6432|systemdrive|systemroot|temp|term|tmp|tmpdir|windir)$/iu

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harnessValue = process.env.DSH_HARNESS_ROOT
if (harnessValue === undefined || harnessValue.trim() === '') {
  throw new Error('DSH_HARNESS_ROOT must name a built official DeepSeek Harness checkout')
}
const harnessRoot = resolve(harnessValue)
const cliBin = join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts')
const webIndex = join(harnessRoot, 'apps', 'web', 'dist', 'index.html')
const packageManagerEntry = process.env.npm_execpath
if (packageManagerEntry === undefined || packageManagerEntry.trim() === '') {
  throw new Error('run this smoke through pnpm so npm_execpath is available')
}

const activeChildren = new Set()
let gatewaySocket
let fakeProvider
let temporaryRoot

function controlledEnvironment(overrides = {}) {
  const safe = {}
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || !SAFE_INHERITED_ENV_NAME.test(name)) continue
    safe[name.toUpperCase()] = value
  }
  return { ...safe, ...overrides }
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(timeoutMs)} ms`)), timeoutMs)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

function boundedCapture(stream, observe = () => {}) {
  let value = ''
  stream?.setEncoding('utf8')
  stream?.on('data', chunk => {
    value = `${value}${String(chunk)}`.slice(-OUTPUT_LIMIT)
    observe(value)
  })
  return () => value
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  try {
    await withTimeout(exited, STOP_TIMEOUT_MS, 'child shutdown')
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await withTimeout(once(child, 'exit'), STOP_TIMEOUT_MS, 'forced child shutdown').catch(() => {})
  }
}

async function runChild(command, args, { cwd, env, label, timeoutMs = PROCESS_TIMEOUT_MS }) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  activeChildren.add(child)
  const readStdout = boundedCapture(child.stdout)
  const readStderr = boundedCapture(child.stderr)
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    child.once('error', rejectCompletion)
    child.once('exit', (code, signal) => resolveCompletion({ code, signal }))
  })
  try {
    const result = await withTimeout(completion, timeoutMs, label)
    if (result.code !== 0) {
      const diagnostic = [readStdout(), readStderr()].filter(Boolean).join('\n').trim()
      throw new Error(`${label} exited unsuccessfully (${result.code ?? result.signal ?? 'unknown'})${diagnostic === '' ? '' : `\n${diagnostic}`}`)
    }
  } catch (error) {
    await stopChild(child)
    throw error
  } finally {
    activeChildren.delete(child)
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50))
  }
  throw new Error(`${label} timed out after ${String(timeoutMs)} ms`)
}

async function fileExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function createFakeProvider() {
  const httpServer = createServer()
  const webSocketServer = new WebSocketServer({ noServer: true })
  const providerEvents = []
  let acceptedConnections = 0
  let inputBytes = 0
  let outputBytes = 0
  let turnCompleted = false
  let rejectFailure
  const failure = new Promise((_, reject) => { rejectFailure = reject })
  void failure.catch(() => {})

  const fail = error => {
    rejectFailure(error instanceof Error ? error : new Error('fake provider failed'))
    for (const client of webSocketServer.clients) client.terminate()
  }

  const sessionEvent = type => JSON.stringify({
    type,
    session: {
      id: 'fake-provider-session-1',
      model: MODEL,
      object: 'realtime.session',
      ...(type === 'session.updated' ? {
        modalities: ['text', 'audio'],
        input_audio_format: 'pcm',
        output_audio_format: 'pcm',
        turn_detection: null,
      } : {}),
    },
  })

  httpServer.on('upgrade', (request, socket, head) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'ws://127.0.0.1')
      assert.equal(requestUrl.pathname, '/api-ws/v1/realtime')
      assert.equal(requestUrl.searchParams.get('model'), MODEL)
      assert.equal(
        request.headers.authorization === `Bearer ${FAKE_CREDENTIAL}`,
        true,
        'fake provider received unexpected authorization',
      )
      acceptedConnections += 1
      assert.equal(acceptedConnections, 1)
      webSocketServer.handleUpgrade(request, socket, head, ws => {
        webSocketServer.emit('connection', ws, request)
      })
    } catch {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
      socket.destroy()
      fail(new Error('fake provider rejected an unexpected upgrade request'))
    }
  })

  webSocketServer.on('connection', socket => {
    let sawUpdate = false
    let sawAudio = false
    let sawCommit = false
    socket.send(sessionEvent('session.created'))
    socket.on('message', raw => {
      try {
        const event = JSON.parse(raw.toString())
        providerEvents.push(event.type)
        if (event.type === 'session.update') {
          assert.deepEqual(event.session, {
            modalities: ['text', 'audio'],
            input_audio_format: 'pcm',
            output_audio_format: 'pcm',
            turn_detection: null,
          })
          sawUpdate = true
          socket.send(sessionEvent('session.updated'))
          return
        }
        if (event.type === 'input_audio_buffer.append') {
          assert.equal(sawUpdate, true)
          const audio = Buffer.from(event.audio, 'base64')
          assert.equal(audio.byteLength, EXPECTED_AUDIO.byteLength, 'provider input byte count differed')
          assert.equal(Buffer.compare(audio, EXPECTED_AUDIO), 0, 'provider input bytes differed')
          inputBytes += audio.byteLength
          sawAudio = true
          return
        }
        if (event.type === 'input_audio_buffer.commit') {
          assert.equal(sawAudio, true)
          sawCommit = true
          return
        }
        if (event.type === 'response.create') {
          assert.equal(sawCommit, true)
          assert.deepEqual(event.response, { modalities: ['text', 'audio'] })
          socket.send(JSON.stringify({
            type: 'input_audio_buffer.committed',
            item_id: 'fake-user-1',
            previous_item_id: null,
          }))
          socket.send(JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'fake-user-1',
            content_index: 0,
            transcript: EXPECTED_USER_TRANSCRIPT,
          }))
          socket.send(JSON.stringify({
            type: 'response.created',
            response: {
              id: 'fake-response-1',
              object: 'realtime.response',
              status: 'in_progress',
              modalities: ['text', 'audio'],
              output: [],
            },
          }))
          socket.send(JSON.stringify({
            type: 'response.audio_transcript.done',
            response_id: 'fake-response-1',
            item_id: 'fake-assistant-1',
            output_index: 0,
            content_index: 0,
            transcript: EXPECTED_ASSISTANT_TRANSCRIPT,
          }))
          socket.send(JSON.stringify({
            type: 'response.audio.delta',
            response_id: 'fake-response-1',
            item_id: 'fake-assistant-1',
            output_index: 0,
            content_index: 0,
            delta: EXPECTED_AUDIO.toString('base64'),
          }))
          outputBytes += EXPECTED_AUDIO.byteLength
          socket.send(JSON.stringify({
            type: 'response.audio.done',
            response_id: 'fake-response-1',
            item_id: 'fake-assistant-1',
            output_index: 0,
            content_index: 0,
          }))
          socket.send(JSON.stringify({
            type: 'response.done',
            response: {
              id: 'fake-response-1',
              object: 'realtime.response',
              status: 'completed',
              modalities: ['text', 'audio'],
              output: [{
                id: 'fake-assistant-1',
                object: 'realtime.item',
                type: 'message',
                status: 'completed',
                role: 'assistant',
                content: [{ type: 'audio', transcript: EXPECTED_ASSISTANT_TRANSCRIPT }],
              }],
            },
          }))
          turnCompleted = true
          return
        }
        throw new Error('fake provider received an unexpected event type')
      } catch (error) {
        fail(error)
      }
    })
    socket.on('error', fail)
  })

  return {
    failure,
    get acceptedConnections() { return acceptedConnections },
    get providerEvents() { return [...providerEvents] },
    get inputBytes() { return inputBytes },
    get outputBytes() { return outputBytes },
    get turnCompleted() { return turnCompleted },
    get clientCount() { return webSocketServer.clients.size },
    async listen() {
      await new Promise((resolveListen, rejectListen) => {
        httpServer.once('error', rejectListen)
        httpServer.listen(0, '127.0.0.1', resolveListen)
      })
      const address = httpServer.address()
      assert.ok(address !== null && typeof address !== 'string')
      return `ws://127.0.0.1:${String(address.port)}`
    },
    async close() {
      for (const client of webSocketServer.clients) client.terminate()
      await new Promise(resolveClose => webSocketServer.close(() => resolveClose()))
      if (httpServer.listening) {
        await new Promise(resolveClose => httpServer.close(() => resolveClose()))
      }
    },
  }
}

async function rpc(baseUrl, method, payload, sequence) {
  const response = await withTimeout(fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: `dsh-live-voice-smoke-${String(sequence)}`,
      method,
      payload,
    }),
  }), TURN_TIMEOUT_MS, `${method} RPC`)
  assert.equal(response.ok, true, `${method} RPC returned HTTP ${String(response.status)}`)
  const body = await response.json()
  assert.equal(body.result?.ok, true, `${method} RPC failed`)
  return body.result.value
}

async function driveGateway(baseUrl, sessionId, workspaceId) {
  const url = new URL(ROUTE, baseUrl)
  url.protocol = 'ws:'
  const controls = []
  let outputBytes = 0
  let sawUserTranscript = false
  let sawAssistantTranscript = false
  let disclosureAccepted = false
  let providerReady = false
  let turnStatus

  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    let completed = false
    const finish = (error) => {
      if (completed) return
      completed = true
      if (error === undefined) resolveCompletion()
      else rejectCompletion(error)
    }
    gatewaySocket = new WebSocket(url, { origin: baseUrl })
    gatewaySocket.on('open', () => {
      gatewaySocket.send(JSON.stringify({ v: 1, type: 'bind', sessionId }))
    })
    gatewaySocket.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          const output = Buffer.from(data)
          assert.equal(output.byteLength, EXPECTED_AUDIO.byteLength, 'gateway output byte count differed')
          assert.equal(Buffer.compare(output, EXPECTED_AUDIO), 0, 'gateway output bytes differed')
          outputBytes += output.byteLength
          return
        }
        const event = JSON.parse(data.toString())
        controls.push(event.type)
        if (event.type === 'consent.required') {
          assert.equal(fakeProvider.acceptedConnections, 0, 'provider connected before disclosure acceptance')
          assert.equal(event.sessionId, sessionId)
          assert.equal(event.workspaceId, workspaceId)
          assert.equal(event.disclosure?.exportedContext, 'none')
          assert.equal(event.disclosure?.executionAuthority, 'none')
          disclosureAccepted = true
          gatewaySocket.send(JSON.stringify({ v: 1, type: 'consent.accept', challenge: event.challenge }))
          return
        }
        if (event.type === 'ready') {
          assert.equal(event.model, MODEL)
          assert.equal(event.authority, 'proposal-only')
          providerReady = true
          gatewaySocket.send(EXPECTED_AUDIO)
          gatewaySocket.send(JSON.stringify({ v: 1, type: 'turn.commit' }))
          return
        }
        if (event.type === 'transcript') {
          if (event.role === 'user') {
            assert.equal(event.text === EXPECTED_USER_TRANSCRIPT, true, 'user transcript differed')
            assert.equal(event.final, true)
            sawUserTranscript = true
          } else if (event.role === 'assistant') {
            assert.equal(event.text === EXPECTED_ASSISTANT_TRANSCRIPT, true, 'assistant transcript differed')
            assert.equal(event.final, true)
            sawAssistantTranscript = true
          } else {
            throw new Error('gateway returned an unexpected transcript role')
          }
          return
        }
        if (event.type === 'turn.done') {
          turnStatus = event.status
          gatewaySocket.close(1000, 'smoke complete')
          return
        }
        if (event.type === 'error') throw new Error(`gateway returned error code ${String(event.code)}`)
        throw new Error('gateway returned an unexpected control event')
      } catch (error) {
        finish(error)
      }
    })
    gatewaySocket.on('close', () => {
      if (turnStatus === 'completed') finish()
      else finish(new Error('gateway closed before completed turn'))
    })
    gatewaySocket.on('error', finish)
  })

  await withTimeout(Promise.race([completion, fakeProvider.failure]), TURN_TIMEOUT_MS, 'voice gateway turn')
  assert.deepEqual(controls, [
    'consent.required',
    'ready',
    'transcript',
    'transcript',
    'turn.done',
  ])
  assert.equal(outputBytes, EXPECTED_AUDIO.byteLength)
  assert.equal(sawUserTranscript, true)
  assert.equal(sawAssistantTranscript, true)
  assert.equal(disclosureAccepted, true)
  assert.equal(providerReady, true)
  assert.equal(turnStatus, 'completed')
  return {
    disclosureAccepted,
    providerReady,
    outputBytes,
    finalUserTranscript: sawUserTranscript,
    finalAssistantTranscript: sawAssistantTranscript,
    turnStatus,
  }
}

async function startHarness(args, environment) {
  const child = spawn(process.execPath, args, {
    cwd: temporaryRoot,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  activeChildren.add(child)
  let resolveReady
  let rejectReady
  const ready = new Promise((resolveReadiness, rejectReadiness) => {
    resolveReady = resolveReadiness
    rejectReady = rejectReadiness
  })
  boundedCapture(child.stdout, output => {
    const match = /http:\/\/127\.0\.0\.1:\d+/u.exec(output)
    if (match !== null) resolveReady(match[0])
  })
  boundedCapture(child.stderr)
  child.once('error', rejectReady)
  child.once('exit', (code, signal) => {
    rejectReady(new Error(`Harness exited before readiness (${code ?? signal ?? 'unknown'})`))
  })
  try {
    const baseUrl = await withTimeout(ready, READY_TIMEOUT_MS, 'Harness readiness')
    return { child, baseUrl }
  } catch (error) {
    await stopChild(child)
    activeChildren.delete(child)
    throw error
  }
}

async function main() {
  await access(cliBin)
  await access(webIndex)
  const harnessRequire = createRequire(join(harnessRoot, 'package.json'))
  const tsxImport = pathToFileURL(harnessRequire.resolve('tsx/esm')).href
  const realWsEntry = createRequire(import.meta.url).resolve('ws')

  temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-voice-fake-qwen-smoke-'))
  const packDir = join(temporaryRoot, 'pack')
  const dshHome = join(temporaryRoot, '.dsh')
  const workspaceDir = join(temporaryRoot, 'workspace')
  const markerPath = join(temporaryRoot, 'ws-shim-loaded')
  const userConfig = join(temporaryRoot, 'empty-npmrc')
  await Promise.all([
    mkdir(packDir, { recursive: true }),
    mkdir(workspaceDir, { recursive: true }),
    writeFile(userConfig, '', 'utf8'),
  ])

  const baseEnvironment = controlledEnvironment({
    DSH_HOME: dshHome,
    DSH_AGENTS_HOME: join(temporaryRoot, 'agents'),
    DSH_TELEMETRY_DISABLED: '1',
    DSH_PERMISSION_MODE: 'read-only',
    HOME: temporaryRoot,
    USERPROFILE: temporaryRoot,
    TSX_TSCONFIG_PATH: join(harnessRoot, 'tsconfig.json'),
    npm_config_userconfig: userConfig,
    NPM_CONFIG_USERCONFIG: userConfig,
  })

  await runChild(process.execPath, [
    packageManagerEntry,
    'pack',
    '--pack-destination',
    packDir,
  ], {
    cwd: pluginRoot,
    env: baseEnvironment,
    label: 'plugin pack',
  })
  const tarballs = (await readdir(packDir)).filter(name => name.endsWith('.tgz'))
  assert.equal(tarballs.length, 1, 'plugin pack must produce exactly one tarball')
  const tarball = join(packDir, tarballs[0])

  await runChild(process.execPath, [
    '--import',
    tsxImport,
    cliBin,
    'plugin',
    '--profile',
    PROFILE,
    'add',
    ...(allowInstallNetwork ? [] : ['--offline']),
    tarball,
  ], {
    cwd: temporaryRoot,
    env: baseEnvironment,
    label: 'official CLI packed-plugin install',
  })

  const profileDir = join(dshHome, 'profiles', PROFILE)
  const profileManifestPath = join(profileDir, 'package.json')
  const profileManifest = JSON.parse(await readFile(profileManifestPath, 'utf8'))
  const bundles = profileManifest.dsh?.profile?.bundles
  assert.ok(Array.isArray(bundles), 'official CLI did not create a profile bundle list')
  assert.equal(bundles.includes(PLUGIN_NAME), true, 'official CLI did not activate the packed plugin bundle')
  if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
    bundles.splice(bundles.indexOf(PLUGIN_NAME), 0, '@deepseek-ai/dsh-web-app')
  }
  assert.ok(bundles.indexOf('@deepseek-ai/dsh-web-app') < bundles.indexOf(PLUGIN_NAME))
  await writeFile(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`, 'utf8')
  const installedPluginPackage = createRequire(profileManifestPath).resolve(`${PLUGIN_NAME}/package.json`)
  const installedPluginUrlPrefix = pathToFileURL(`${dirname(installedPluginPackage)}${sep}`).href
  await writeFile(join(profileDir, 'cordis.patch.yml'), `\
- id: guarded-live-voice
  name: dsh-live-voice
  config:
    credentialRef: DSH_VOICE_FAKE_KEY
    route: ${ROUTE}
    model: ${MODEL}
    dashscopeWorkspaceId: ${WORKSPACE_SLUG}
    trustedHosts: localhost,127.0.0.1,[::1]
    consentTtlMs: 60000
    maxConnections: 1
`, 'utf8')

  const registerPath = join(temporaryRoot, 'register.mjs')
  const loaderPath = join(temporaryRoot, 'redirect-loader.mjs')
  const shimPath = join(temporaryRoot, 'ws-shim.mjs')
  await writeFile(registerPath, `\
import { register } from 'node:module'
register(new URL('./redirect-loader.mjs', import.meta.url), import.meta.url)
`, 'utf8')
  await writeFile(loaderPath, `\
const SHIM = new URL('./ws-shim.mjs', import.meta.url).href
const PLUGIN_ROOT = ${JSON.stringify(installedPluginUrlPrefix)}
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'ws' && context.parentURL?.startsWith(PLUGIN_ROOT)) {
    return { url: SHIM, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
`, 'utf8')
  await writeFile(shimPath, `\
import { writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const ws = createRequire(import.meta.url)(${JSON.stringify(realWsEntry)})
const RealWebSocket = ws.WebSocket
const WebSocketServer = ws.WebSocketServer

const marker = process.env.DSH_VOICE_FAKE_QWEN_MARKER
if (marker === undefined) throw new Error('fake-Qwen marker is not configured')
writeFileSync(marker, 'loaded', { encoding: 'utf8', flag: 'wx' })

function redirectedAddress(address) {
  const original = new URL(String(address))
  if (original.protocol !== 'wss:'
    || original.hostname !== '${WORKSPACE_SLUG}.cn-beijing.maas.aliyuncs.com'
    || original.pathname !== '/api-ws/v1/realtime'
    || original.searchParams.get('model') !== '${MODEL}') {
    throw new Error('fake-Qwen smoke blocked an unexpected provider target')
  }
  const target = new URL(process.env.DSH_VOICE_FAKE_QWEN_URL ?? '')
  if (target.protocol !== 'ws:' || target.hostname !== '127.0.0.1') {
    throw new Error('fake-Qwen smoke target must be IPv4 loopback WebSocket')
  }
  target.pathname = original.pathname
  target.search = original.search
  return target
}

export class WebSocket extends RealWebSocket {
  constructor(address, protocols, options) {
    const redirected = redirectedAddress(address)
    if (options === undefined) super(redirected, protocols)
    else super(redirected, protocols, options)
  }
}

export { WebSocketServer }
`, 'utf8')

  fakeProvider = createFakeProvider()
  const fakeProviderUrl = await fakeProvider.listen()
  const harnessEnvironment = {
    ...baseEnvironment,
    NODE_OPTIONS: `--import=${pathToFileURL(registerPath).href}`,
    DSH_VOICE_FAKE_KEY: FAKE_CREDENTIAL,
    DSH_VOICE_FAKE_QWEN_URL: fakeProviderUrl,
    DSH_VOICE_FAKE_QWEN_MARKER: markerPath,
  }
  const harness = await startHarness([
    '--import',
    tsxImport,
    cliBin,
    '--profile',
    PROFILE,
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--no-open',
  ], harnessEnvironment)

  await waitFor(() => fileExists(markerPath), TURN_TIMEOUT_MS, 'fail-closed provider shim activation')
  assert.equal(fakeProvider.acceptedConnections, 0, 'provider connected before any gateway consent')

  const rootResponse = await withTimeout(fetch(harness.baseUrl), TURN_TIMEOUT_MS, 'root request')
  const root = await rootResponse.text()
  assert.equal(rootResponse.status, 200)
  assert.equal(root.includes(`globalThis["__DSH_GUARDED_LIVE_VOICE__"] = {"v":1,"route":"${ROUTE}"}`), true)

  const clientResponse = await withTimeout(
    fetch(`${harness.baseUrl}/plugins/${PLUGIN_NAME}/client.js`),
    TURN_TIMEOUT_MS,
    'plugin client request',
  )
  const client = await clientResponse.text()
  assert.equal(clientResponse.status, 200)
  assert.equal(
    /\bid:\s*["']dsh-live-voice["']/u.test(client),
    true,
    'served client bundle lacked the exact wrapper id',
  )

  const upgradeOnlyResponse = await withTimeout(
    fetch(`${harness.baseUrl}${ROUTE}`),
    TURN_TIMEOUT_MS,
    'plain HTTP gateway request',
  )
  assert.equal(upgradeOnlyResponse.status, 404)

  const workspace = await rpc(harness.baseUrl, 'workspace.create', { path: workspaceDir }, 1)
  const workspaceId = workspace.workspace.workspaceId
  const session = await rpc(harness.baseUrl, 'session.create', { workspaceId }, 2)
  const gateway = await driveGateway(harness.baseUrl, session.sessionId, workspaceId)

  assert.deepEqual(fakeProvider.providerEvents, [
    'session.update',
    'input_audio_buffer.append',
    'input_audio_buffer.commit',
    'response.create',
  ])
  assert.equal(fakeProvider.turnCompleted, true)
  assert.equal(fakeProvider.inputBytes, EXPECTED_AUDIO.byteLength)
  assert.equal(fakeProvider.outputBytes, EXPECTED_AUDIO.byteLength)
  await waitFor(() => fakeProvider.clientCount === 0, TURN_TIMEOUT_MS, 'provider socket disposal')

  process.stdout.write(`${JSON.stringify({
    rootStatus: rootResponse.status,
    clientStatus: clientResponse.status,
    upgradeOnlyStatus: upgradeOnlyResponse.status,
    workspaceBound: true,
    sessionBound: true,
    disclosureAccepted: gateway.disclosureAccepted,
    providerReady: gateway.providerReady,
    providerInputBytes: fakeProvider.inputBytes,
    providerOutputBytes: gateway.outputBytes,
    finalUserTranscript: gateway.finalUserTranscript,
    finalAssistantTranscript: gateway.finalAssistantTranscript,
    turnStatus: gateway.turnStatus,
    providerSocketDisposed: true,
  })}\n`)
}

try {
  await main()
} finally {
  if (gatewaySocket !== undefined && gatewaySocket.readyState !== WebSocket.CLOSED) {
    gatewaySocket.terminate()
  }
  for (const child of activeChildren) await stopChild(child)
  activeChildren.clear()
  if (fakeProvider !== undefined) await fakeProvider.close().catch(() => {})
  if (temporaryRoot !== undefined) {
    await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}
