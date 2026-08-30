/**
 * Disposable, provider-isolated composition smoke for the packed voice plugin.
 *
 * This is deliberately not shipped. It installs the current tarball through
 * the official DSH CLI, mounts it with the official Web bundle, and drives one
 * real workspace/session/gateway turn against either the bundled local
 * synthetic provider or a deterministic loopback Qwen peer.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
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
import { release, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { WebSocket, WebSocketServer } from 'ws'
import { shouldRunAlphaAuth } from './smoke-harness-alpha-mode.mjs'

const runBrowserBfcache = process.env.DSH_VOICE_SMOKE_BROWSER_BFCACHE === '1'
const alphaAuthRequested = process.env.DSH_VOICE_SMOKE_ALPHA_AUTH === '1'
const runSyntheticDemo = process.env.DSH_VOICE_SMOKE_SYNTHETIC_DEMO === '1'
const PLUGIN_NAME = 'dsh-live-voice'
const ROUTE = '/guarded-voice'
const MODEL = 'qwen-audio-3.0-realtime-plus'
const SYNTHETIC_DEMO_MODEL = 'dsh-live-voice-synthetic-demo-v1'
const SYNTHETIC_DEMO_USER_TRANSCRIPT = 'Synthetic demo request: place this sample transcript in the DSH draft.'
const SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT = 'Synthetic demo response: the local consent-bound turn completed without contacting an external provider.'
const SYNTHETIC_DEMO_CHIME_BYTES = 4_800
const SYNTHETIC_DEMO_CHIME_SHA256 = 'ef3d9ae9e285aaef41443f087dbf1a046ed32d50470394f1e492c86815811e57'
const SYNTHETIC_DEMO_DISCLOSURE = Object.freeze({
  audioDestination: 'Local deterministic synthetic demo',
  exportedContext: 'none',
  executionAuthority: 'none',
  providerRetention: 'none; no external provider connection',
  currentMilestone: 'one bounded synthetic demo turn after acceptance',
})
const WORKSPACE_SLUG = 'voice-smoke'
const ALPHA_TARGETS = new Map([
  ['0.1.2-alpha.1', {
    commit: 'cd5ef8148158c3a752a658978873241fdf8e2bbc',
    tag: 'dsh-v0.1.2-alpha.1',
  }],
  ['0.1.2-alpha.2', {
    commit: '0a53fb55bea101816fa226bb964ae2bed71c343b',
    tag: 'dsh-v0.1.2-alpha.2',
  }],
])
const EXPECTED_ALPHA_VERSION = process.env.DSH_VOICE_SMOKE_ALPHA_VERSION ?? '0.1.2-alpha.1'
const alphaTarget = ALPHA_TARGETS.get(EXPECTED_ALPHA_VERSION)
if (alphaTarget === undefined) {
  throw new Error(`unsupported exact Harness alpha target: ${EXPECTED_ALPHA_VERSION}`)
}
const EXPECTED_ALPHA_COMMIT = alphaTarget.commit
const EXPECTED_ALPHA_TAG = alphaTarget.tag
const FAKE_CREDENTIAL = 'deterministic-fake-qwen-token'
const EXPECTED_AUDIO = Buffer.from([1, 0, 2, 0])
const EXPECTED_USER_TRANSCRIPT = 'deterministic user transcript'
const EXPECTED_ASSISTANT_TRANSCRIPT = 'deterministic assistant transcript'
const allowInstallNetwork = process.env.DSH_VOICE_SMOKE_INSTALL_ONLINE === '1'
const PROCESS_TIMEOUT_MS = 180_000
const READY_TIMEOUT_MS = 300_000
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
const harnessVersion = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8')).version
const runAlphaAuth = shouldRunAlphaAuth({
  alphaAuthRequested,
  harnessVersion,
  runBrowserBfcache,
  supportedAlphaVersion: EXPECTED_ALPHA_VERSION,
})
if (runSyntheticDemo
  && (!runAlphaAuth || runBrowserBfcache || EXPECTED_ALPHA_VERSION !== '0.1.2-alpha.2')) {
  throw new Error('synthetic demo smoke requires exact authenticated Harness alpha.2 without BFCache mode')
}
const runOfficialSource = runBrowserBfcache || runAlphaAuth
const PROFILE = runOfficialSource ? 'web' : 'dsh-live-voice-fake-qwen-smoke'
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
const sensitiveValues = new Set([
  FAKE_CREDENTIAL,
  EXPECTED_USER_TRANSCRIPT,
  EXPECTED_ASSISTANT_TRANSCRIPT,
])

function rememberSensitive(value) {
  if (typeof value === 'string' && value !== '') sensitiveValues.add(value)
}

function redactSensitive(value) {
  let redacted = String(value)
    .replace(/([?&]token=)[A-Za-z0-9._~-]+/gu, '$1<redacted>')
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/giu, 'cookie: <redacted>')
    .replace(/\b(?:https?|wss?):\/\/127\.0\.0\.1:\d+[^\s)]*/gu, '<loopback-url>')
  for (const secret of sensitiveValues) redacted = redacted.replaceAll(secret, '<redacted>')
  return redacted
}

function advertisedPluginClientUrl(root, baseUrl) {
  const paths = [...root.matchAll(/\b(?:href|src)="([^"]*\/plugins\/\?\?[^"]+)"/gu)]
    .map(match => match[1]?.replaceAll('&amp;', '&'))
    .filter(path => path?.includes(`${PLUGIN_NAME}/client.js`) === true)
  assert.equal(paths.length, 1, 'official Web index did not advertise exactly one voice client bundle')
  const url = new URL(paths[0], baseUrl)
  assert.equal(url.origin, new URL(baseUrl).origin, 'official Web index advertised a cross-origin voice client bundle')
  assert.equal(url.username, '', 'official Web index advertised a credentialed voice client bundle URL')
  assert.equal(url.password, '', 'official Web index advertised a credentialed voice client bundle URL')
  return url
}

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
      throw new Error(`${label} exited unsuccessfully (${result.code ?? result.signal ?? 'unknown'})${diagnostic === '' ? '' : `\n${redactSensitive(diagnostic)}`}`)
    }
    return readStdout().trim()
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
  let failureError
  let rejectFailure
  const failure = new Promise((_, reject) => { rejectFailure = reject })
  void failure.catch(() => {})

  const fail = error => {
    failureError = error instanceof Error ? error : new Error('fake provider failed')
    rejectFailure(failureError)
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
      assert.equal(acceptedConnections <= (runBrowserBfcache ? 3 : 1), true)
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
          if (runBrowserBfcache) {
            assert.equal(audio.byteLength > 0, true, 'browser provider input was empty')
            assert.equal(audio.byteLength % 2, 0, 'browser provider input was not PCM16-aligned')
          } else {
            assert.equal(audio.byteLength, EXPECTED_AUDIO.byteLength, 'provider input byte count differed')
            assert.equal(Buffer.compare(audio, EXPECTED_AUDIO), 0, 'provider input bytes differed')
          }
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
    get failureError() { return failureError },
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

async function rpc(baseUrl, method, payload, sequence, authentication = {}) {
  const endpoint = authentication.alpha === true ? method.replaceAll('.', '/') : method
  const rpcId = `dsh-live-voice-smoke-${String(sequence)}`
  const response = await withTimeout(fetch(`${baseUrl}/api/${endpoint}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(authentication.cookie === undefined ? {} : { cookie: authentication.cookie }),
    },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method: endpoint,
      payload: authentication.alpha === true ? { args: { request: payload } } : payload,
    }),
  }), TURN_TIMEOUT_MS, `${endpoint} RPC`)
  assert.equal(response.ok, true, `${endpoint} RPC returned HTTP ${String(response.status)}`)
  const body = await response.json()
  if (authentication.alpha === true) {
    assert.equal(body.type, 'server-response', `${endpoint} RPC response type differed`)
    assert.equal(body.rpcId, rpcId, `${endpoint} RPC correlation differed`)
  }
  assert.equal(body.result?.ok, true, `${endpoint} RPC failed`)
  return body.result.value
}

async function driveGateway(baseUrl, sessionId, workspaceId, cookie) {
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
    gatewaySocket = new WebSocket(url, {
      origin: baseUrl,
      ...(cookie === undefined ? {} : { headers: { cookie } }),
    })
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

async function driveSyntheticDemoGateway(baseUrl, sessionId, workspaceId, cookie) {
  assert.ok(cookie !== undefined, 'synthetic demo alpha.2 gateway requires the authenticated Harness cookie')
  const url = new URL(ROUTE, baseUrl)
  url.protocol = 'ws:'
  const events = []
  let audioChunks = 0
  let outputBytes = 0
  let outputSha256
  let sawUserTranscript = false
  let sawAssistantTranscript = false
  let disclosureAccepted = false
  let providerReady = false
  let turnStatus
  let stopped = false
  let closeCode

  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    let completed = false
    const finish = (error) => {
      if (completed) return
      completed = true
      if (error === undefined) resolveCompletion()
      else rejectCompletion(error)
    }
    gatewaySocket = new WebSocket(url, {
      origin: baseUrl,
      headers: { cookie },
    })
    gatewaySocket.on('open', () => {
      gatewaySocket.send(JSON.stringify({ v: 1, type: 'bind', sessionId }))
    })
    gatewaySocket.on('message', (data, isBinary) => {
      try {
        if (isBinary) {
          events.push('audio')
          audioChunks += 1
          const output = Buffer.from(data)
          outputBytes += output.byteLength
          outputSha256 = createHash('sha256').update(output).digest('hex')
          assert.equal(output.byteLength, SYNTHETIC_DEMO_CHIME_BYTES, 'synthetic demo chime byte count differed')
          assert.equal(output.byteLength % 2, 0, 'synthetic demo chime was not PCM16-aligned')
          assert.equal(outputSha256, SYNTHETIC_DEMO_CHIME_SHA256, 'synthetic demo chime digest differed')
          return
        }
        const event = JSON.parse(data.toString())
        events.push(event.type)
        if (event.type === 'consent.required') {
          assert.equal(event.sessionId, sessionId)
          assert.equal(event.workspaceId, workspaceId)
          assert.equal(event.provider, 'synthetic-demo')
          assert.deepEqual(event.disclosure, SYNTHETIC_DEMO_DISCLOSURE)
          disclosureAccepted = true
          gatewaySocket.send(JSON.stringify({ v: 1, type: 'consent.accept', challenge: event.challenge }))
          return
        }
        if (event.type === 'ready') {
          assert.equal(event.sessionId, sessionId)
          assert.equal(event.workspaceId, workspaceId)
          assert.equal(event.provider, 'synthetic-demo')
          assert.equal(event.model, SYNTHETIC_DEMO_MODEL)
          assert.equal(event.authority, 'proposal-only')
          providerReady = true
          gatewaySocket.send(EXPECTED_AUDIO)
          gatewaySocket.send(JSON.stringify({ v: 1, type: 'turn.commit' }))
          return
        }
        if (event.type === 'transcript') {
          if (event.role === 'user') {
            assert.equal(event.text, SYNTHETIC_DEMO_USER_TRANSCRIPT)
            assert.equal(event.final, true)
            sawUserTranscript = true
          } else if (event.role === 'assistant') {
            assert.equal(event.text, SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT)
            assert.equal(event.final, true)
            sawAssistantTranscript = true
          } else {
            throw new Error('synthetic demo gateway returned an unexpected transcript role')
          }
          return
        }
        if (event.type === 'turn.done') {
          turnStatus = event.status
          gatewaySocket.send(JSON.stringify({ v: 1, type: 'stop' }))
          return
        }
        if (event.type === 'stopped') {
          stopped = true
          return
        }
        if (event.type === 'error') throw new Error(`synthetic demo gateway returned error code ${String(event.code)}`)
        throw new Error('synthetic demo gateway returned an unexpected control event')
      } catch (error) {
        finish(error)
      }
    })
    gatewaySocket.on('close', code => {
      closeCode = code
      if (turnStatus === 'completed' && stopped) finish()
      else finish(new Error('synthetic demo gateway closed before completed turn'))
    })
    gatewaySocket.on('error', finish)
  })

  await withTimeout(completion, TURN_TIMEOUT_MS, 'synthetic demo gateway turn')
  assert.deepEqual(events, [
    'consent.required',
    'ready',
    'transcript',
    'transcript',
    'audio',
    'turn.done',
    'stopped',
  ])
  assert.equal(audioChunks, 1)
  assert.equal(outputBytes, SYNTHETIC_DEMO_CHIME_BYTES)
  assert.equal(outputSha256, SYNTHETIC_DEMO_CHIME_SHA256)
  assert.equal(sawUserTranscript, true)
  assert.equal(sawAssistantTranscript, true)
  assert.equal(disclosureAccepted, true)
  assert.equal(providerReady, true)
  assert.equal(turnStatus, 'completed')
  assert.equal(stopped, true)
  assert.equal(closeCode, 1000)
  return {
    audioChunks,
    disclosureAccepted,
    finalAssistantTranscript: sawAssistantTranscript,
    finalUserTranscript: sawUserTranscript,
    gatewayConnectionDisposed: true,
    outputBytes,
    outputSha256,
    providerReady,
    providerTurnDisposed: true,
    turnStatus,
  }
}

async function driveOfficialBrowserBfcacheCase(baseUrl, sessionId, workspaceId, testCase, authentication) {
  const webRequire = createRequire(join(harnessRoot, 'apps', 'web', 'package.json'))
  const { chromium } = webRequire('playwright')
  const playwrightVersion = webRequire('playwright/package.json').version
  let awayCookieHeader
  const awayServer = createServer((request, response) => {
    awayCookieHeader = request.headers.cookie
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/html; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    }).end('<!doctype html><title>DSH BFCache traversal point</title><p>Return to DSH.</p>')
  })
  await new Promise((resolveListen, rejectListen) => {
    awayServer.once('error', rejectListen)
    // A host-only Harness cookie ignores ports. Use a distinct loopback host so
    // the controlled traversal server cannot receive the alpha auth secret.
    awayServer.listen(0, '127.0.0.2', resolveListen)
  })
  const awayAddress = awayServer.address()
  assert.ok(awayAddress !== null && typeof awayAddress !== 'string')
  const awayUrl = `http://127.0.0.2:${String(awayAddress.port)}`

  let browser
  try {
    browser = await chromium.launch({
      channel: 'chrome',
      headless: false,
      ignoreDefaultArgs: ['--disable-back-forward-cache'],
    })
    const context = await browser.newContext({ locale: 'en-US' })
    if (authentication.cookie !== undefined) {
      const { cookie } = authentication
      const separator = cookie.indexOf('=')
      assert.ok(separator > 0, 'alpha browser cookie is malformed')
      await context.addCookies([{
        name: cookie.slice(0, separator),
        value: cookie.slice(separator + 1),
        url: baseUrl,
        httpOnly: true,
        sameSite: 'Strict',
      }])
    }
    const page = await context.newPage()
    const targetOrigin = new URL(baseUrl).origin
    await page.addInitScript(({ caseName, expectedOrigin, seedSessionId }) => {
      if (location.origin !== expectedOrigin) return
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: seedSessionId }))
      const state = {
        audioFramesSent: 0,
        audioFramesSentAfterTeardown: 0,
        bootNonce: crypto.randomUUID(),
        case: caseName,
        fixtureAudioCloseCalls: 0,
        mediaRequests: 0,
        ownedAudioCloseCallsBeforeRestore: 0,
        ownedAudioStatesAfterRestore: [],
        pagehideCount: 0,
        pagehidePersisted: null,
        pageshowPersisted: [],
        phaseBeforeHide: null,
        pluginTimersAfterCleanup: null,
        restored: false,
        socketRecords: [],
        trackStopCallsBeforeRestore: 0,
        trackStatesAfterCleanup: [],
      }
      window.__dshVoiceOfficialBfcache = state
      window.__dshVoiceOfficialOwnedAudioContexts = []
      window.__dshVoiceOfficialTracks = []
      window.__dshVoiceOfficialTimerHandles = new Set()

      const nativeSetTimeout = window.setTimeout.bind(window)
      const nativeClearTimeout = window.clearTimeout.bind(window)
      window.setTimeout = (handler, delay, ...args) => {
        const stack = new Error().stack ?? ''
        if (!stack.includes('/plugins/dsh-live-voice/client.js')) {
          return nativeSetTimeout(handler, delay, ...args)
        }
        let timer
        const wrapped = typeof handler === 'function'
          ? (...callbackArgs) => {
              window.__dshVoiceOfficialTimerHandles.delete(timer)
              return handler(...callbackArgs)
            }
          : handler
        timer = nativeSetTimeout(wrapped, delay, ...args)
        window.__dshVoiceOfficialTimerHandles.add(timer)
        return timer
      }
      window.clearTimeout = timer => {
        window.__dshVoiceOfficialTimerHandles.delete(timer)
        return nativeClearTimeout(timer)
      }

      const NativeWebSocket = window.WebSocket
      class TrackedWebSocket extends NativeWebSocket {
        constructor(address, protocols) {
          if (protocols === undefined) super(address)
          else super(address, protocols)
          const path = new URL(this.url).pathname
          const kind = path === '/guarded-voice'
            ? 'voice'
            : path === '/api/remote.mux'
              ? 'remote.mux'
            : path === '/api/events.mux'
              ? 'events.mux'
              : path === '/api/events.host' ? 'events.host' : 'other'
          const record = {
            afterRestore: state.restored,
            binaryFrames: 0,
            challenges: [],
            closeCalls: [],
            closeEvents: [],
            controls: [],
            kind,
            openEvents: 0,
            path,
          }
          this.__dshVoiceSocketRecord = record
          state.socketRecords.push(record)
          this.addEventListener('open', () => { record.openEvents += 1 })
          this.addEventListener('close', event => {
            record.closeEvents.push({
              afterRestore: state.restored,
              code: event.code,
              reason: event.reason,
            })
          })
          this.addEventListener('message', event => {
            if (record.kind !== 'voice' || typeof event.data !== 'string') return
            try {
              const control = JSON.parse(event.data)
              if (control?.type === 'consent.required' && typeof control.challenge === 'string') {
                record.challenges.push(control.challenge)
              }
            } catch {}
          })
        }

        send(data) {
          const record = this.__dshVoiceSocketRecord
          if (record.kind === 'voice') {
            if (typeof data === 'string') {
              try { record.controls.push(JSON.parse(data)) } catch {}
            } else {
              record.binaryFrames += 1
              state.audioFramesSent += 1
              if (record.closeCalls.some(call => call.afterRestore === false)) {
                state.audioFramesSentAfterTeardown += 1
              }
            }
          }
          return super.send(data)
        }

        close(code, reason) {
          this.__dshVoiceSocketRecord.closeCalls.push({
            afterRestore: state.restored,
            code: code ?? null,
            reason: reason ?? '',
          })
          return super.close(code, reason)
        }
      }
      window.WebSocket = TrackedWebSocket

      const NativeAudioContext = window.AudioContext || window.webkitAudioContext
      if (NativeAudioContext === undefined) throw new Error('AudioContext is unavailable')
      const fixtureContexts = new WeakSet()
      const fixtureTracks = new WeakMap()
      const nativeClose = NativeAudioContext.prototype.close
      NativeAudioContext.prototype.close = function (...args) {
        if (fixtureContexts.has(this)) state.fixtureAudioCloseCalls += 1
        else if (!state.restored) state.ownedAudioCloseCallsBeforeRestore += 1
        return nativeClose.apply(this, args)
      }
      class TrackedAudioContext extends NativeAudioContext {
        constructor(...args) {
          super(...args)
          window.__dshVoiceOfficialOwnedAudioContexts.push(this)
        }
      }
      window.AudioContext = TrackedAudioContext
      if (window.webkitAudioContext !== undefined) window.webkitAudioContext = TrackedAudioContext

      const nativeTrackStop = MediaStreamTrack.prototype.stop
      MediaStreamTrack.prototype.stop = function (...args) {
        const source = fixtureTracks.get(this)
        if (source !== undefined) {
          fixtureTracks.delete(this)
          if (!state.restored) state.trackStopCallsBeforeRestore += 1
          try { source.oscillator.stop() } catch {}
          void source.context.close()
        }
        return nativeTrackStop.apply(this, args)
      }

      const mediaDevices = navigator.mediaDevices
      if (mediaDevices === undefined) throw new Error('MediaDevices is unavailable')
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          state.mediaRequests += 1
          const context = new NativeAudioContext()
          fixtureContexts.add(context)
          const oscillator = context.createOscillator()
          const destination = context.createMediaStreamDestination()
          oscillator.connect(destination)
          oscillator.start()
          await context.resume()
          for (const track of destination.stream.getTracks()) {
            fixtureTracks.set(track, { context, oscillator })
            window.__dshVoiceOfficialTracks.push(track)
          }
          return destination.stream
        },
      })

      addEventListener('pagehide', event => {
        state.pagehideCount += 1
        state.pagehidePersisted = event.persisted
        state.phaseBeforeHide = document.querySelector(
          'button[aria-label="Close DSH Live Voice"], button[aria-label="Open DSH Live Voice"]',
        )?.dataset.state ?? null
      })
      addEventListener('pageshow', event => {
        state.pageshowPersisted.push(event.persisted)
        if (event.persisted) state.restored = true
      })
    }, { caseName: testCase, expectedOrigin: targetOrigin, seedSessionId: sessionId })

    const cdp = await context.newCDPSession(page)
    await cdp.send('Page.enable')
    const bfcacheNotUsed = []
    cdp.on('Page.backForwardCacheNotUsed', event => { bfcacheNotUsed.push(event) })
    const navigationTypes = []
    cdp.on('Page.frameNavigated', event => {
      if (event.frame.parentId === undefined) navigationTypes.push(event.type ?? 'Navigation')
    })
    const pageErrors = []
    page.on('pageerror', error => { pageErrors.push(error.message) })

    await page.goto(baseUrl, { waitUntil: 'load', timeout: READY_TIMEOUT_MS })
    const voiceControl = page.getByRole('button', { name: 'Open DSH Live Voice' })
    await voiceControl.waitFor({ timeout: TURN_TIMEOUT_MS })
    const welcomeContinue = page.getByRole('dialog', { name: 'Internal Testing Notice' })
      .getByRole('button', { name: 'Continue', exact: true })
    await welcomeContinue.waitFor({ timeout: 10_000 }).catch(() => {})
    if (await welcomeContinue.isVisible()) await welcomeContinue.click()
    const configureLater = page.getByRole('dialog', { name: 'Add an API key to get started' })
      .getByRole('button', { name: 'Configure later', exact: true })
    await configureLater.waitFor({ timeout: 10_000 }).catch(() => {})
    if (await configureLater.isVisible()) await configureLater.click()

    const eventSocketKinds = runAlphaAuth ? ['remote.mux'] : ['events.mux', 'events.host']
    await page.waitForFunction((expectedKinds) => {
      const records = window.__dshVoiceOfficialBfcache?.socketRecords ?? []
      return expectedKinds.every(kind => (
        records.some(record => record.kind === kind && record.openEvents > 0)
      ))
    }, eventSocketKinds, { timeout: TURN_TIMEOUT_MS })
    await page.evaluate(() => {
      addEventListener('pagehide', () => {
        const state = window.__dshVoiceOfficialBfcache
        state.pluginTimersAfterCleanup = window.__dshVoiceOfficialTimerHandles.size
        state.trackStatesAfterCleanup = window.__dshVoiceOfficialTracks.map(track => track.readyState)
      })
    })
    const bootNonce = await page.evaluate(() => window.__dshVoiceOfficialBfcache.bootNonce)
    let originalDraft = null
    const composer = page.locator(
      '[data-composer-input][contenteditable="true"], [data-input-scroll] textarea',
    ).last()
    if (testCase === 'active') {
      originalDraft = 'Official BFCache draft sentinel'
      await composer.fill(originalDraft)
      await voiceControl.click()
      await page.getByRole('heading', { name: 'Before voice is enabled', level: 3 }).waitFor({
        timeout: TURN_TIMEOUT_MS,
      })
      await page.getByRole('button', { name: 'Continue setup', exact: true }).click()
      const recordControl = page.getByRole('button', { name: 'Start recording', exact: true })
      await recordControl.waitFor({ timeout: TURN_TIMEOUT_MS })
      await recordControl.click()
      await page.getByRole('status').filter({ hasText: 'Recording one bounded turn' }).waitFor({
        timeout: TURN_TIMEOUT_MS,
      })
      await page.waitForFunction(
        () => window.__dshVoiceOfficialBfcache?.audioFramesSent > 0,
        undefined,
        { timeout: TURN_TIMEOUT_MS },
      )
    } else {
      assert.equal(testCase, 'idle')
    }

    await page.goto(awayUrl, { waitUntil: 'load', timeout: TURN_TIMEOUT_MS })
    assert.equal(awayCookieHeader, undefined, 'BFCache traversal received the Harness auth cookie')
    let restoredSessionId
    if (testCase === 'active') {
      const restoredSession = await rpc(
        baseUrl,
        'session.create',
        { workspaceId },
        101,
        authentication,
      )
      restoredSessionId = restoredSession.sessionId
    }
    await page.goBack({ waitUntil: 'commit', timeout: TURN_TIMEOUT_MS })
    await voiceControl.waitFor({ timeout: TURN_TIMEOUT_MS })
    try {
      await page.waitForFunction((expectedKinds) => {
        const state = window.__dshVoiceOfficialBfcache
        if (state?.pageshowPersisted.at(-1) !== true) return false
        const records = state.socketRecords
        return expectedKinds.every(kind => records.some(record => (
          record.kind === kind && record.afterRestore && record.openEvents > 0
        )))
      }, eventSocketKinds, { timeout: TURN_TIMEOUT_MS })
    } catch (error) {
      const pageState = await page.evaluate(() => {
        const state = window.__dshVoiceOfficialBfcache
        return state === undefined
          ? null
          : {
              bootNonce: state.bootNonce,
              pagehidePersisted: state.pagehidePersisted,
              pageshowPersisted: state.pageshowPersisted,
              socketKinds: state.socketRecords.map(record => record.kind),
            }
      }).catch(() => null)
      const reasons = bfcacheNotUsed.map(event => ({
        explanations: event.notRestoredExplanations,
        tree: event.notRestoredExplanationsTree,
      }))
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${testCase} official DSH BFCache restore did not settle: ${message}\n${JSON.stringify({
          navigationTypes,
          pageState,
          reasons,
        })}`,
        { cause: error },
      )
    }

    await page.evaluate(() => {
      const state = window.__dshVoiceOfficialBfcache
      state.ownedAudioStatesAfterRestore = window.__dshVoiceOfficialOwnedAudioContexts
        .map(context => context.state)
      state.trackStatesAfterCleanup = window.__dshVoiceOfficialTracks.map(track => track.readyState)
    })
    const state = await page.evaluate(() => structuredClone(window.__dshVoiceOfficialBfcache))
    assert.equal(state.bootNonce, bootNonce, 'official DSH document reloaded instead of restoring')
    assert.equal(state.pagehidePersisted, true)
    assert.deepEqual(state.pageshowPersisted, [false, true])
    assert.equal(state.phaseBeforeHide, testCase === 'active' ? 'recording' : 'idle')
    assert.equal(
      navigationTypes.includes('BackForwardCacheRestore'),
      true,
      `official DSH did not emit a BFCache restore navigation: ${JSON.stringify(bfcacheNotUsed)}`,
    )
    assert.equal(bfcacheNotUsed.length, 0, 'official DSH emitted a BFCache-not-used diagnostic')
    assert.deepEqual(pageErrors, [])

    const voiceSockets = state.socketRecords.filter(record => record.kind === 'voice')
    for (const kind of eventSocketKinds) {
      const sockets = state.socketRecords.filter(record => record.kind === kind)
      assert.equal(sockets.some(record => !record.afterRestore && record.openEvents > 0), true)
      assert.equal(
        sockets.some(record => record.afterRestore && record.openEvents > 0),
        true,
        `official DSH ${kind} did not open a post-restore replacement`,
      )
    }

    let activeReceipt
    if (testCase === 'active') {
      assert.equal(state.mediaRequests, 1)
      assert.equal(state.audioFramesSent > 0, true, 'official DSH browser sent no synthetic audio')
      assert.equal(state.audioFramesSentAfterTeardown, 0)
      assert.equal(state.trackStopCallsBeforeRestore, 1)
      assert.deepEqual(state.trackStatesAfterCleanup, ['ended'])
      assert.equal(state.ownedAudioCloseCallsBeforeRestore, 2)
      assert.deepEqual(state.ownedAudioStatesAfterRestore, ['closed', 'closed'])
      assert.equal(state.pluginTimersAfterCleanup, 0)
      assert.equal(voiceSockets.length, 1, 'official DSH restore reopened a stale Voice socket')
      assert.deepEqual(voiceSockets[0].closeCalls, [
        { afterRestore: false, code: 1000, reason: 'stopped' },
      ])
      assert.equal(voiceSockets[0].closeEvents.length, 1)
      assert.deepEqual({
        code: voiceSockets[0].closeEvents[0].code,
        reason: voiceSockets[0].closeEvents[0].reason,
      }, {
        code: 1000,
        reason: 'stopped',
      })
      assert.equal(await composer.evaluate(element => (
        element instanceof HTMLTextAreaElement ? element.value : element.textContent
      )), originalDraft)

      const providerConnectionsBeforeSameSession = fakeProvider.acceptedConnections
      await voiceControl.click()
      await page.getByRole('heading', { name: 'Before voice is enabled', level: 3 }).waitFor({
        timeout: TURN_TIMEOUT_MS,
      })
      assert.equal(fakeProvider.acceptedConnections, providerConnectionsBeforeSameSession)
      await page.waitForFunction((expectedSessionId) => {
        const sockets = window.__dshVoiceOfficialBfcache.socketRecords
          .filter(record => record.kind === 'voice')
        const fresh = sockets.at(-1)
        return sockets.length === 2
          && fresh.challenges.length === 1
          && fresh.controls.some(control => (
            control?.type === 'bind' && control.sessionId === expectedSessionId
          ))
      }, sessionId, { timeout: TURN_TIMEOUT_MS })
      const sameSessionState = await page.evaluate(() => (
        structuredClone(window.__dshVoiceOfficialBfcache)
      ))
      const sameSessionVoice = sameSessionState.socketRecords
        .filter(record => record.kind === 'voice').at(-1)
      assert.notEqual(sameSessionVoice.challenges[0], voiceSockets[0].challenges[0])
      assert.equal(sameSessionVoice.binaryFrames, 0)
      await page.getByRole('button', { name: 'Close DSH Live Voice', exact: true }).first().click()
      await voiceControl.waitFor({ timeout: TURN_TIMEOUT_MS })
      await page.waitForFunction(() => {
        const sockets = window.__dshVoiceOfficialBfcache.socketRecords
          .filter(record => record.kind === 'voice')
        return sockets.length === 2
          && sockets[1].closeCalls.length === 1
          && sockets[1].closeEvents.length === 1
      }, undefined, { timeout: TURN_TIMEOUT_MS })

      assert.ok(restoredSessionId !== undefined)
      const providerConnectionsBeforeSpaSwitch = fakeProvider.acceptedConnections
      const audioFramesBeforeSpaSwitch = await page.evaluate(
        () => window.__dshVoiceOfficialBfcache.audioFramesSent,
      )
      await voiceControl.click()
      await page.getByRole('heading', { name: 'Before voice is enabled', level: 3 }).waitFor({
        timeout: TURN_TIMEOUT_MS,
      })
      await page.getByRole('button', { name: 'Continue setup', exact: true }).click()
      const spaRecordControl = page.getByRole('button', { name: 'Start recording', exact: true })
      await spaRecordControl.waitFor({ timeout: TURN_TIMEOUT_MS })
      await spaRecordControl.click()
      await page.getByRole('status').filter({ hasText: 'Recording one bounded turn' }).waitFor({
        timeout: TURN_TIMEOUT_MS,
      })
      await waitFor(
        () => fakeProvider.acceptedConnections === providerConnectionsBeforeSpaSwitch + 1,
        TURN_TIMEOUT_MS,
        'SPA-switch provider connection',
      )
      await page.waitForFunction(
        before => window.__dshVoiceOfficialBfcache.audioFramesSent > before,
        audioFramesBeforeSpaSwitch,
        { timeout: TURN_TIMEOUT_MS },
      )

      const workspaceRow = page.locator('[role="treeitem"][aria-expanded]').filter({ hasText: 'workspace' }).first()
      await workspaceRow.waitFor({ timeout: TURN_TIMEOUT_MS })
      await workspaceRow.hover()
      await page.getByRole('button', { name: 'New session in workspace', exact: true }).click()
      await page.waitForFunction((expectedSessionId) => {
        const current = localStorage.getItem('dsh.sessions.current')
        return current !== null && JSON.parse(current).sessionId === expectedSessionId
      }, restoredSessionId, { timeout: TURN_TIMEOUT_MS })
      await page.waitForFunction(() => {
        const records = window.__dshVoiceOfficialBfcache.socketRecords
          .filter(record => record.kind === 'voice')
        const switched = records.at(-1)
        const latestTrack = window.__dshVoiceOfficialTracks.at(-1)
        return records.length === 3
          && switched.closeCalls.length === 1
          && switched.closeEvents.length === 1
          && latestTrack?.readyState === 'ended'
      }, undefined, { timeout: TURN_TIMEOUT_MS })
      await voiceControl.waitFor({ timeout: TURN_TIMEOUT_MS })
      assert.equal(await voiceControl.isEnabled(), true, 'new Session voice control stayed occupied by old Session')
      assert.equal(await voiceControl.getAttribute('aria-label'), 'Open DSH Live Voice')
      assert.equal(
        await page.getByRole('heading', { name: 'Before voice is enabled', level: 3 }).count(),
        0,
        'old Session disclosure remained visible after SPA switch',
      )
      await waitFor(() => fakeProvider.clientCount === 0, TURN_TIMEOUT_MS, 'SPA-switch provider disposal')
      const spaState = await page.evaluate(() => structuredClone({
        audioFramesSent: window.__dshVoiceOfficialBfcache.audioFramesSent,
        mediaRequests: window.__dshVoiceOfficialBfcache.mediaRequests,
        pagehideCount: window.__dshVoiceOfficialBfcache.pagehideCount,
        socketRecords: window.__dshVoiceOfficialBfcache.socketRecords,
        trackStates: window.__dshVoiceOfficialTracks.map(track => track.readyState),
      }))
      await page.waitForTimeout(250)
      assert.equal(
        await page.evaluate(() => window.__dshVoiceOfficialBfcache.audioFramesSent),
        spaState.audioFramesSent,
        'hidden SPA Session continued sending microphone frames',
      )
      const spaVoice = spaState.socketRecords.filter(record => record.kind === 'voice').at(-1)
      assert.equal(spaState.pagehideCount, 1, 'SPA Session switch unexpectedly used document navigation')
      assert.equal(spaState.mediaRequests, 2)
      assert.equal(spaState.trackStates.at(-1), 'ended')
      assert.equal(spaVoice.binaryFrames > 0, true)
      assert.deepEqual(spaVoice.closeCalls, [
        { afterRestore: true, code: 1000, reason: 'stopped' },
      ])
      assert.deepEqual(spaVoice.closeEvents, [
        { afterRestore: true, code: 1000, reason: 'stopped' },
      ])
      assert.ok(spaVoice.controls.some(control => (
        control?.type === 'bind' && control.sessionId === sessionId
      )))

      const providerConnectionsBeforeFreshConsent = fakeProvider.acceptedConnections
      const providerInputBeforeFreshConsent = fakeProvider.inputBytes
      await voiceControl.click()
      await page.getByRole('heading', { name: 'Before voice is enabled', level: 3 }).waitFor({
        timeout: TURN_TIMEOUT_MS,
      })
      assert.equal(fakeProvider.acceptedConnections, providerConnectionsBeforeFreshConsent)
      await page.waitForFunction((expectedSessionId) => {
        const sockets = window.__dshVoiceOfficialBfcache.socketRecords
          .filter(record => record.kind === 'voice')
        const fresh = sockets.at(-1)
          return sockets.length === 4
          && fresh.challenges.length === 1
          && fresh.controls.some(control => (
            control?.type === 'bind' && control.sessionId === expectedSessionId
          ))
      }, restoredSessionId, { timeout: TURN_TIMEOUT_MS })
      const beforeFreshConsent = await page.evaluate(() => (
        structuredClone(window.__dshVoiceOfficialBfcache)
      ))
      const freshVoiceBeforeConsent = beforeFreshConsent.socketRecords
        .filter(record => record.kind === 'voice').at(-1)
      assert.notEqual(freshVoiceBeforeConsent.challenges[0], voiceSockets[0].challenges[0])
      assert.notEqual(freshVoiceBeforeConsent.challenges[0], sameSessionVoice.challenges[0])
      assert.notEqual(freshVoiceBeforeConsent.challenges[0], spaVoice.challenges[0])
      assert.equal(freshVoiceBeforeConsent.binaryFrames, 0)

      await page.getByRole('button', { name: 'Continue setup', exact: true }).click()
      await page.getByRole('button', { name: 'Start recording', exact: true }).waitFor({
        timeout: TURN_TIMEOUT_MS,
      })
      await waitFor(
        () => fakeProvider.acceptedConnections === providerConnectionsBeforeFreshConsent + 1,
        TURN_TIMEOUT_MS,
        'fresh disclosure provider connection',
      )
      assert.equal(fakeProvider.inputBytes, providerInputBeforeFreshConsent)
      await page.getByRole('button', { name: 'Close DSH Live Voice', exact: true }).first().click()
      await voiceControl.waitFor({ timeout: TURN_TIMEOUT_MS })
      await waitFor(() => fakeProvider.clientCount === 0, TURN_TIMEOUT_MS, 'fresh provider disposal')
      const finalState = await page.evaluate(() => structuredClone(window.__dshVoiceOfficialBfcache))
      const finalVoiceSockets = finalState.socketRecords.filter(record => record.kind === 'voice')
      assert.equal(finalVoiceSockets.length, 4)
      assert.deepEqual(finalVoiceSockets[1].closeCalls, [
        { afterRestore: true, code: 1000, reason: 'stopped' },
      ])
      assert.deepEqual(finalVoiceSockets[1].closeEvents, [
        { afterRestore: true, code: 1000, reason: 'stopped' },
      ])
      assert.deepEqual(finalVoiceSockets[2].closeCalls, [
        { afterRestore: true, code: 1000, reason: 'stopped' },
      ])
      assert.deepEqual(finalVoiceSockets[2].closeEvents, [
        { afterRestore: true, code: 1000, reason: 'stopped' },
      ])
      assert.equal(finalVoiceSockets[3].binaryFrames, 0)
      assert.deepEqual(finalVoiceSockets[3].closeCalls, [
        { afterRestore: true, code: 1000, reason: 'stopped' },
      ])
      activeReceipt = {
        audioFramesSent: finalState.audioFramesSent,
        freshChallengeUnique: true,
        freshDisclosureRequired: true,
        freshSessionBound: true,
        ownedAudioContextsCloseRequested: state.ownedAudioCloseCallsBeforeRestore,
        originalComposerDraftPreserved: true,
        postBfcacheTeardownBrowserAudioSends: state.audioFramesSentAfterTeardown,
        sameSessionChallengeUnique: true,
        sameSessionFreshDisclosureRequired: true,
        spaSessionSwitchNoPagehide: true,
        spaSessionSwitchProviderDisposed: true,
        spaSessionSwitchRemountedIdleControl: true,
        spaSessionSwitchStoppedCapture: true,
        spaSessionSwitchStoppedVoiceSocket: true,
        syntheticTrackStopped: true,
        timersAfterCleanup: state.pluginTimersAfterCleanup,
        voiceSocketClose: voiceSockets[0].closeCalls[0],
      }
    } else {
      assert.equal(state.mediaRequests, 0)
      assert.equal(state.audioFramesSent, 0)
      assert.equal(state.trackStopCallsBeforeRestore, 0)
      assert.deepEqual(state.trackStatesAfterCleanup, [])
      assert.equal(state.ownedAudioCloseCallsBeforeRestore, 0)
      assert.deepEqual(state.ownedAudioStatesAfterRestore, [])
      assert.equal(state.pluginTimersAfterCleanup, 0)
      assert.equal(voiceSockets.length, 0)
      assert.equal(fakeProvider.acceptedConnections, 0)
    }

    await context.close()
    return {
      browserVersion: browser.version(),
      case: testCase,
      dshEventStreamsReconnected: true,
      navigationTypes,
      notRestoredReasonCount: bfcacheNotUsed.length,
      pagehidePersisted: state.pagehidePersisted,
      pageshowPersisted: state.pageshowPersisted,
      playwrightVersion,
      ...(activeReceipt === undefined ? { remainedIdle: true } : activeReceipt),
    }
  } finally {
    if (browser !== undefined) await browser.close().catch(() => {})
    if (awayServer.listening) {
      const closed = once(awayServer, 'close')
      awayServer.close()
      awayServer.closeAllConnections()
      await withTimeout(closed, STOP_TIMEOUT_MS, 'BFCache traversal server shutdown').catch(() => {})
    }
  }
}

async function driveOfficialBrowserBfcache(baseUrl, sessionId, workspaceId, authentication) {
  const idle = await driveOfficialBrowserBfcacheCase(
    baseUrl, sessionId, workspaceId, 'idle', authentication,
  )
  const active = await driveOfficialBrowserBfcacheCase(
    baseUrl, sessionId, workspaceId, 'active', authentication,
  )
  assert.equal(idle.browserVersion, active.browserVersion)
  assert.equal(idle.playwrightVersion, active.playwrightVersion)
  return {
    active,
    browserVersion: active.browserVersion,
    idle,
    playwrightVersion: active.playwrightVersion,
  }
}

async function rejectedVoiceUpgradeStatus(baseUrl) {
  const url = new URL(ROUTE, baseUrl)
  url.protocol = 'ws:'
  const status = new Promise((resolveStatus, rejectStatus) => {
    const socket = new WebSocket(url, { origin: baseUrl })
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      if (error === undefined) resolveStatus(value)
      else rejectStatus(error)
    }
    socket.once('unexpected-response', (_request, response) => {
      const statusCode = response.statusCode
      response.resume()
      socket.terminate()
      finish(undefined, statusCode)
    })
    socket.once('open', () => {
      socket.terminate()
      finish(new Error('unauthenticated voice WebSocket unexpectedly opened'))
    })
    socket.once('error', error => finish(error))
    socket.once('close', () => finish(new Error('unauthenticated voice WebSocket closed without a response status')))
  })
  return withTimeout(status, TURN_TIMEOUT_MS, 'unauthenticated voice WebSocket rejection')
}

async function authenticateAlphaHarness(harness) {
  assert.ok(harness.launchUrl !== undefined, 'alpha auth smoke requires a tokenized Harness launch URL')
  const launch = new URL(harness.launchUrl)
  const launchToken = launch.searchParams.get('token')
  assert.ok(launchToken !== null && launchToken !== '')
  rememberSensitive(launchToken)

  const unauthenticatedVoiceUpgradeStatus = await rejectedVoiceUpgradeStatus(harness.baseUrl)
  assert.equal(unauthenticatedVoiceUpgradeStatus, 401)
  if (fakeProvider !== undefined) assert.equal(fakeProvider.acceptedConnections, 0)

  const exchange = await withTimeout(fetch(harness.launchUrl, { redirect: 'manual' }), TURN_TIMEOUT_MS, 'launch-token exchange')
  const location = exchange.headers.get('location')
  const setCookie = exchange.headers.get('set-cookie')
  const exchangeBody = await exchange.text()
  assert.equal(exchange.status, 303)
  assert.equal(location, '/')
  assert.ok(setCookie !== null)
  rememberSensitive(setCookie)
  const cookie = setCookie.split(';', 1)[0]
  rememberSensitive(cookie)
  assert.match(setCookie, /(?:^|;)\s*HttpOnly(?:;|$)/iu)
  assert.match(setCookie, /(?:^|;)\s*SameSite=Strict(?:;|$)/iu)
  assert.equal(
    /^[^=;\s]+=[A-Za-z0-9._~-]+$/u.test(cookie),
    true,
    'issued browser cookie has an invalid wire format',
  )
  assert.equal(location?.includes(launchToken), false)
  assert.equal(exchangeBody.includes(launchToken), false)
  assert.equal(exchangeBody.includes(cookie), false)
  return {
    alpha: true,
    cookie,
    cookieIssued: true,
    launchTokenExchanged: true,
    unauthenticatedVoiceUpgradeStatus,
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
  const readStdout = boundedCapture(child.stdout, output => {
    const match = /http:\/\/127\.0\.0\.1:\d+(?:\/\?token=[A-Za-z0-9._~-]+)?/u.exec(output)
    if (match !== null) {
      const launchUrl = match[0]
      const parsed = new URL(launchUrl)
      resolveReady({
        baseUrl: parsed.origin,
        launchUrl: parsed.searchParams.has('token') ? launchUrl : undefined,
      })
    }
  })
  const readStderr = boundedCapture(child.stderr)
  child.once('error', rejectReady)
  child.once('exit', (code, signal) => {
    rejectReady(new Error(`Harness exited before readiness (${code ?? signal ?? 'unknown'})`))
  })
  try {
    const endpoint = await withTimeout(ready, READY_TIMEOUT_MS, 'Harness readiness')
    return { child, ...endpoint }
  } catch (error) {
    await stopChild(child)
    activeChildren.delete(child)
    const diagnostic = redactSensitive([readStdout(), readStderr()].filter(Boolean).join('\n').trim())
    if (diagnostic === '') throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${message}\n${diagnostic}`, { cause: error })
  }
}

async function main() {
  await access(cliBin)
  const harnessRequire = createRequire(join(harnessRoot, 'package.json'))
  const tsxImport = pathToFileURL(harnessRequire.resolve('tsx/esm')).href

  temporaryRoot = await mkdtemp(join(tmpdir(), 'dsh-voice-fake-qwen-smoke-'))
  rememberSensitive(temporaryRoot)
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
  const packageManagerVersion = await runChild(process.execPath, [packageManagerEntry, '--version'], {
    cwd: pluginRoot,
    env: baseEnvironment,
    label: 'pnpm runtime identity',
  })
  let dshClientArtifacts
  let dshCommit
  let dshTag
  let dshVersion
  let dshWebIndexSha256
  let dshWorktreeDirty
  let pluginCommit
  let pluginWorktreeDirty
  if (runBrowserBfcache) {
    const tscEntry = harnessRequire.resolve('typescript/bin/tsc')
    const tsdownPackagePath = harnessRequire.resolve('tsdown/package.json')
    const tsdownPackage = JSON.parse(await readFile(tsdownPackagePath, 'utf8'))
    const tsdownEntry = resolve(dirname(tsdownPackagePath), tsdownPackage.bin.tsdown)
    const webRequire = createRequire(join(harnessRoot, 'apps', 'web', 'package.json'))
    const vitePackagePath = webRequire.resolve('vite/package.json')
    const vitePackage = JSON.parse(await readFile(vitePackagePath, 'utf8'))
    const viteEntry = resolve(dirname(vitePackagePath), vitePackage.bin.vite)
    dshVersion = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8')).version
    dshCommit = await runChild('git', ['rev-parse', 'HEAD'], {
      cwd: harnessRoot,
      env: baseEnvironment,
      label: 'Harness git identity',
    })
    dshWorktreeDirty = (await runChild('git', ['status', '--porcelain'], {
      cwd: harnessRoot,
      env: baseEnvironment,
      label: 'Harness worktree identity',
    })) !== ''
    assert.equal(dshWorktreeDirty, false, 'official browser smoke requires a clean Harness source tree')
    const officialBuildEnvironment = {
      ...baseEnvironment,
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: dshCommit.slice(0, 7).toLowerCase(),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: dshVersion,
    }
    await runChild(process.execPath, [tscEntry, '-b', 'tsconfig.host.json'], {
      cwd: harnessRoot,
      env: officialBuildEnvironment,
      label: 'exact official Harness Host TypeScript build',
      timeoutMs: 600_000,
    })
    await runChild(process.execPath, [tsdownEntry, '--env.DSH_BUILD_FACE', 'host'], {
      cwd: harnessRoot,
      env: officialBuildEnvironment,
      label: 'exact official Harness Host bundle build',
      timeoutMs: 600_000,
    })
    await runChild(process.execPath, [tscEntry, '-b', 'tsconfig.client.json'], {
      cwd: harnessRoot,
      env: officialBuildEnvironment,
      label: 'exact official Harness Client TypeScript build',
      timeoutMs: 600_000,
    })
    await runChild(process.execPath, [tsdownEntry, '--env.DSH_BUILD_FACE', 'client'], {
      cwd: harnessRoot,
      env: officialBuildEnvironment,
      label: 'exact official Harness Client bundle build',
      timeoutMs: 600_000,
    })
    await runChild(process.execPath, [viteEntry, 'build'], {
      cwd: join(harnessRoot, 'apps', 'web'),
      env: officialBuildEnvironment,
      label: 'exact official Harness Web bundle build',
      timeoutMs: 600_000,
    })
    const buildRecordModuleUrl = pathToFileURL(join(
      harnessRoot,
      'scripts',
      'client-build-environment.ts',
    )).href
    const writeBuildRecord = [
      `import { writeClientBuildRecord } from ${JSON.stringify(buildRecordModuleUrl)}`,
      `writeClientBuildRecord(${JSON.stringify(harnessRoot)}, Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith('DSH_CLIENT_'))))`,
    ].join(';')
    await runChild(process.execPath, [
      '--import',
      tsxImport,
      '--input-type=module',
      '--eval',
      writeBuildRecord,
    ], {
      cwd: harnessRoot,
      env: officialBuildEnvironment,
      label: 'exact official Harness client build receipt',
    })
    const buildRecord = JSON.parse(await readFile(join(
      harnessRoot,
      '.dsh-build',
      'client-build-environment.json',
    ), 'utf8'))
    assert.deepEqual(buildRecord.environment, {
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: dshCommit.slice(0, 7).toLowerCase(),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: dshVersion,
    })
    assert.equal(Number.isSafeInteger(buildRecord.artifacts?.fileCount), true)
    assert.equal(buildRecord.artifacts.fileCount > 0, true)
    assert.match(buildRecord.artifacts.sha256, /^[0-9a-f]{64}$/u)
    dshClientArtifacts = buildRecord.artifacts
    assert.equal((await runChild('git', ['status', '--porcelain'], {
      cwd: harnessRoot,
      env: baseEnvironment,
      label: 'post-build Harness worktree identity',
    })) === '', true, 'official Harness build changed tracked source')
    dshWebIndexSha256 = createHash('sha256')
      .update(await readFile(webIndex))
      .digest('hex')
    pluginCommit = await runChild('git', ['rev-parse', 'HEAD'], {
      cwd: pluginRoot,
      env: baseEnvironment,
      label: 'plugin git identity',
    })
    pluginWorktreeDirty = (await runChild('git', ['status', '--porcelain'], {
      cwd: pluginRoot,
      env: baseEnvironment,
      label: 'plugin worktree identity',
    })) !== ''
  }
  if (runAlphaAuth) {
    dshVersion = JSON.parse(await readFile(join(harnessRoot, 'package.json'), 'utf8')).version
    dshCommit = await runChild('git', ['rev-parse', 'HEAD'], {
      cwd: harnessRoot,
      env: baseEnvironment,
      label: 'Harness git identity',
    })
    dshTag = await runChild('git', ['describe', '--tags', '--exact-match', 'HEAD'], {
      cwd: harnessRoot,
      env: baseEnvironment,
      label: 'Harness exact tag identity',
    })
    assert.equal(dshVersion, EXPECTED_ALPHA_VERSION, 'alpha auth smoke requires the exact Harness version')
    assert.equal(dshCommit, EXPECTED_ALPHA_COMMIT, 'alpha auth smoke requires the exact Harness commit')
    assert.equal(dshTag, EXPECTED_ALPHA_TAG, 'alpha auth smoke requires the exact Harness tag')
    dshWorktreeDirty = (await runChild('git', ['status', '--porcelain'], {
      cwd: harnessRoot,
      env: baseEnvironment,
      label: 'Harness worktree identity',
    })) !== ''
    assert.equal(dshWorktreeDirty, false, 'official alpha auth smoke requires a clean Harness source tree')
    const buildRecordModuleUrl = pathToFileURL(join(
      harnessRoot,
      'scripts',
      'client-build-environment.ts',
    )).href
    const verifyBuildRecord = [
      `import { officialClientBuildEnvironment, readClientBuildRecord } from ${JSON.stringify(buildRecordModuleUrl)}`,
      `const root = ${JSON.stringify(harnessRoot)}`,
      'const record = readClientBuildRecord(root, officialClientBuildEnvironment(root))',
      'process.stdout.write(JSON.stringify(record))',
    ].join(';')
    const buildRecord = JSON.parse(await runChild(process.execPath, [
      '--import',
      tsxImport,
      '--input-type=module',
      '--eval',
      verifyBuildRecord,
    ], {
      cwd: harnessRoot,
      env: baseEnvironment,
      label: 'exact official Harness alpha client build verification',
    }))
    assert.deepEqual(buildRecord.environment, {
      DSH_CLIENT_BUILD_PROFILE: 'official',
      DSH_CLIENT_COMMIT_HASH: dshCommit.slice(0, 7).toLowerCase(),
      DSH_CLIENT_TITLE: 'DeepSeek Harness',
      DSH_CLIENT_VERSION: dshVersion,
    })
    assert.equal(Number.isSafeInteger(buildRecord.artifacts?.fileCount), true)
    assert.equal(buildRecord.artifacts.fileCount > 0, true)
    assert.match(buildRecord.artifacts.sha256, /^[0-9a-f]{64}$/u)
    dshClientArtifacts = buildRecord.artifacts
    dshWebIndexSha256 = createHash('sha256')
      .update(await readFile(webIndex))
      .digest('hex')
    pluginCommit = await runChild('git', ['rev-parse', 'HEAD'], {
      cwd: pluginRoot,
      env: baseEnvironment,
      label: 'plugin git identity',
    })
    pluginWorktreeDirty = (await runChild('git', ['status', '--porcelain'], {
      cwd: pluginRoot,
      env: baseEnvironment,
      label: 'plugin worktree identity',
    })) !== ''
  }
  await access(webIndex)

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
  const pluginTarballSha256 = runOfficialSource
    ? createHash('sha256').update(await readFile(tarball)).digest('hex')
    : undefined

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
  if (runOfficialSource) {
    assert.deepEqual(bundles.slice(0, 2), [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
    ], 'official CLI did not initialize the shipped Web profile template')
  } else if (!bundles.includes('@deepseek-ai/dsh-web-app')) {
    bundles.splice(bundles.indexOf(PLUGIN_NAME), 0, '@deepseek-ai/dsh-web-app')
  }
  assert.ok(bundles.indexOf('@deepseek-ai/dsh-web-app') < bundles.indexOf(PLUGIN_NAME))
  await writeFile(profileManifestPath, `${JSON.stringify(profileManifest, null, 2)}\n`, 'utf8')
  const installedPluginPackage = createRequire(profileManifestPath).resolve(`${PLUGIN_NAME}/package.json`)
  const installedPluginDir = dirname(installedPluginPackage)
  if (runSyntheticDemo) {
    const installedBundlePatch = await readFile(join(installedPluginDir, 'cordis.patch.yml'), 'utf8')
    assert.equal(
      installedBundlePatch,
      await readFile(join(pluginRoot, 'cordis.patch.yml'), 'utf8'),
      'installed synthetic demo bundle patch differed from the packed source',
    )
    assert.match(installedBundlePatch, /(?:^|\n)\s*provider:\s*synthetic-demo\s*(?:\n|$)/u)
    assert.doesNotMatch(installedBundlePatch, /credentialRef|dashscopeWorkspaceId|\bmodel:/u)
    const profilePatch = await readFile(join(profileDir, 'cordis.patch.yml'), 'utf8')
    assert.match(profilePatch, /(?:^|\n)\[\]\s*$/u, 'synthetic demo smoke must retain the empty profile override')
  } else {
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
  }

  let harnessEnvironment = baseEnvironment
  if (!runSyntheticDemo) {
    const realWsEntry = createRequire(import.meta.url).resolve('ws')
    const installedPluginUrlPrefix = pathToFileURL(`${installedPluginDir}${sep}`).href
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
    harnessEnvironment = {
      ...baseEnvironment,
      NODE_OPTIONS: `--import=${pathToFileURL(registerPath).href}`,
      DSH_VOICE_FAKE_KEY: FAKE_CREDENTIAL,
      DSH_VOICE_FAKE_QWEN_URL: fakeProviderUrl,
      DSH_VOICE_FAKE_QWEN_MARKER: markerPath,
    }
  }
  if (runSyntheticDemo) {
    assert.equal(harnessEnvironment, baseEnvironment, 'synthetic demo Harness environment was unexpectedly overridden')
    assert.equal(fakeProvider, undefined, 'synthetic demo smoke must not create a fake provider server')
    assert.equal(await fileExists(markerPath), false, 'synthetic demo smoke unexpectedly created a provider shim marker')
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

  if (!runSyntheticDemo) {
    await waitFor(() => fileExists(markerPath), TURN_TIMEOUT_MS, 'fail-closed provider shim activation')
    assert.equal(fakeProvider.acceptedConnections, 0, 'provider connected before any gateway consent')
  }

  if (!runAlphaAuth) {
    assert.equal(harness.launchUrl, undefined, 'tokenized Harness launch requires the alpha auth smoke')
  }
  const authentication = runAlphaAuth ? await authenticateAlphaHarness(harness) : {}
  const requestHeaders = authentication.cookie === undefined ? {} : { cookie: authentication.cookie }
  const rootResponse = await withTimeout(fetch(harness.baseUrl, {
    headers: requestHeaders,
  }), TURN_TIMEOUT_MS, 'root request')
  const root = await rootResponse.text()
  assert.equal(rootResponse.status, 200)
  assert.equal(root.includes(`globalThis["__DSH_GUARDED_LIVE_VOICE__"] = {"v":1,"route":"${ROUTE}"}`), true)

  const clientUrl = runAlphaAuth
    ? advertisedPluginClientUrl(root, harness.baseUrl)
    : new URL(`/plugins/${PLUGIN_NAME}/client.js`, harness.baseUrl)
  const clientResponse = await withTimeout(
    fetch(clientUrl, { headers: requestHeaders }),
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
    fetch(`${harness.baseUrl}${ROUTE}`, { headers: requestHeaders }),
    TURN_TIMEOUT_MS,
    'plain HTTP gateway request',
  )
  assert.equal(upgradeOnlyResponse.status, 404)

  const workspace = await rpc(harness.baseUrl, 'workspace.create', { path: workspaceDir }, 1, authentication)
  const workspaceId = workspace.workspace.workspaceId
  rememberSensitive(String(workspaceId))
  const session = await rpc(harness.baseUrl, 'session.create', { workspaceId }, 2, authentication)
  rememberSensitive(String(session.sessionId))

  if (runSyntheticDemo) {
    const gateway = await driveSyntheticDemoGateway(
      harness.baseUrl,
      session.sessionId,
      workspaceId,
      authentication.cookie,
    )
    process.stdout.write(`${JSON.stringify({
      rootStatus: rootResponse.status,
      clientStatus: clientResponse.status,
      upgradeOnlyStatus: upgradeOnlyResponse.status,
      workspaceBound: true,
      sessionBound: true,
      provider: 'synthetic-demo',
      model: SYNTHETIC_DEMO_MODEL,
      bundledProviderConfig: true,
      profileProviderOverride: false,
      disclosureAccepted: gateway.disclosureAccepted,
      providerReady: gateway.providerReady,
      providerInputBytes: EXPECTED_AUDIO.byteLength,
      providerOutputBytes: gateway.outputBytes,
      providerOutputChunks: gateway.audioChunks,
      providerOutputSha256: gateway.outputSha256,
      finalUserTranscript: gateway.finalUserTranscript,
      finalAssistantTranscript: gateway.finalAssistantTranscript,
      turnStatus: gateway.turnStatus,
      providerTurnDisposed: gateway.providerTurnDisposed,
      gatewayConnectionDisposed: gateway.gatewayConnectionDisposed,
      alphaRpcEndpoints: ['workspace/create', 'session/create'],
      alphaRpcResponsesCorrelated: true,
      authenticatedRootStatus: rootResponse.status,
      cookieIssued: authentication.cookieIssued,
      credentialConfigured: false,
      credentialBackedQwen: false,
      dshBuiltFromCleanSource: !dshWorktreeDirty,
      dshClientArtifacts,
      dshCommit,
      dshTag,
      dshVersion,
      dshWebIndexSha256,
      dshWorktreeDirty,
      externalProviderServer: false,
      launchTokenExchanged: authentication.launchTokenExchanged,
      liveCredential: false,
      liveProvider: false,
      officialDshWebProfile: true,
      os: { platform: process.platform, release: release() },
      packagedDesktop: false,
      physicalMicrophone: false,
      physicalSpeaker: false,
      pluginCommit,
      pluginTarballSha256,
      pluginWorktreeDirty,
      qwenTransportShim: false,
      sourceBuiltOfficialAlpha: true,
      unauthenticatedVoiceUpgradeStatus: authentication.unauthenticatedVoiceUpgradeStatus,
    })}\n`)
    return
  }

  if (runBrowserBfcache) {
    const browserBfcache = await driveOfficialBrowserBfcache(
      harness.baseUrl,
      session.sessionId,
      workspaceId,
      authentication,
    )
    assert.equal(fakeProvider.acceptedConnections, 3)
    assert.equal(fakeProvider.providerEvents[0], 'session.update')
    assert.equal(fakeProvider.providerEvents.includes('input_audio_buffer.append'), true)
    assert.equal(fakeProvider.providerEvents.includes('input_audio_buffer.commit'), false)
    assert.equal(fakeProvider.turnCompleted, false)
    assert.equal(fakeProvider.inputBytes > 0, true)
    await waitFor(() => fakeProvider.clientCount === 0, TURN_TIMEOUT_MS, 'browser provider socket disposal')
    assert.equal(fakeProvider.failureError, undefined)
    process.stdout.write(`${JSON.stringify({
      rootStatus: rootResponse.status,
      clientStatus: clientResponse.status,
      upgradeOnlyStatus: upgradeOnlyResponse.status,
      workspaceBound: workspaceId !== undefined,
      sessionBound: session.sessionId !== undefined,
      dshBuiltFromCleanSource: !dshWorktreeDirty,
      dshClientArtifacts,
      dshCommit,
      dshVersion,
      dshWebIndexSha256,
      dshWorktreeDirty,
      officialDshWebProfile: true,
      bfcacheSaveRestore: true,
      ...browserBfcache,
      os: { platform: process.platform, release: release() },
      runtime: { node: process.version, pnpm: packageManagerVersion },
      pluginCommit,
      pluginTarballSha256,
      pluginWorktreeDirty,
      providerInputBytes: fakeProvider.inputBytes,
      providerSocketDisposed: true,
      credentialBackedQwen: false,
      liveProvider: false,
      physicalMicrophone: false,
      physicalSpeaker: false,
      packagedDesktop: false,
    })}\n`)
    return
  }

  const gateway = await driveGateway(harness.baseUrl, session.sessionId, workspaceId, authentication.cookie)

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
  assert.equal(fakeProvider.failureError, undefined)

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
    ...(runAlphaAuth ? {
      alphaRpcEndpoints: ['workspace/create', 'session/create'],
      alphaRpcResponsesCorrelated: true,
      authenticatedRootStatus: rootResponse.status,
      cookieIssued: authentication.cookieIssued,
      credentialBackedQwen: false,
      dshBuiltFromCleanSource: !dshWorktreeDirty,
      dshClientArtifacts,
      dshCommit,
      dshTag,
      dshVersion,
      dshWebIndexSha256,
      dshWorktreeDirty,
      launchTokenExchanged: authentication.launchTokenExchanged,
      liveCredential: false,
      liveProvider: false,
      officialDshWebProfile: true,
      os: { platform: process.platform, release: release() },
      runtime: { node: process.version, pnpm: packageManagerVersion },
      packagedDesktop: false,
      physicalMicrophone: false,
      physicalSpeaker: false,
      pluginCommit,
      pluginTarballSha256,
      pluginWorktreeDirty,
      providerEvents: fakeProvider.providerEvents,
      sourceBuiltOfficialAlpha: true,
      unauthenticatedVoiceUpgradeStatus: authentication.unauthenticatedVoiceUpgradeStatus,
    } : {}),
  })}\n`)
}

try {
  await main()
} catch (error) {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  throw new Error(redactSensitive(detail))
} finally {
  if (gatewaySocket !== undefined && gatewaySocket.readyState !== WebSocket.CLOSED) {
    gatewaySocket.terminate()
  }
  for (const child of activeChildren) await stopChild(child)
  activeChildren.clear()
  if (fakeProvider !== undefined) await fakeProvider.close().catch(() => {})
  if (temporaryRoot !== undefined) {
    try {
      await rm(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
    } catch (error) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      throw new Error(redactSensitive(`temporary cleanup failed: ${detail}`))
    }
  }
}
