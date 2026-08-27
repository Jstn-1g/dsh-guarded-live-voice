/**
 * Controlled-browser fixture for one raw document-unload receipt.
 *
 * The fixture is loopback-only and uses a synthetic Web Audio MediaStream. It
 * never requests microphone permission, resolves a credential, or connects to
 * Qwen. A browser driver must open the printed URL, press Start, Accept, and
 * Record, wait for `recording`, then navigate the same tab to `/done`.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const TIMEOUT_MS = 180_000
const QUIET_MS = 500
const BODY_LIMIT = 16 * 1024
const SESSION_ID = 'raw-unload-session'
const WORKSPACE_ID = 'raw-unload-workspace'
const CHALLENGE = 'controlled_browser_unload_challenge_1'
const MODEL = 'qwen-audio-3.0-realtime-plus'
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientBundle = await readFile(resolve(pluginRoot, 'lib/client.js'), 'utf8')

let expectedHost = ''
let baseUrl = ''
let pageReceipt
let browserSocketClose
let binaryFrames = 0
let postReceiptBinaryFrames = 0
let doneRequested = false
let resolveReceipt
let resolveSocketClose
let resolveDone
let rejectFailure

const receiptReady = new Promise(resolveReceiptReady => { resolveReceipt = resolveReceiptReady })
const socketCloseReady = new Promise(resolveCloseReady => { resolveSocketClose = resolveCloseReady })
const doneReady = new Promise(resolveDoneReady => { resolveDone = resolveDoneReady })
const failure = new Promise((_, reject) => { rejectFailure = reject })
void failure.catch(() => {})

function fail(error) {
  rejectFailure(error instanceof Error ? error : new Error(String(error)))
}

function withTimeout(promise, timeoutMs, label) {
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${String(timeoutMs)} ms`)), timeoutMs)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

function page() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Guarded voice raw-unload smoke</title>
  <style>
    body { color: #151515; font: 16px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 48rem; padding: 0 1rem; }
    button { font: inherit; margin: .5rem .5rem .5rem 0; padding: .65rem 1rem; }
    output { display: block; font-family: ui-monospace, monospace; margin-top: 1rem; }
  </style>
  <script>
    (() => {
      const state = {
        audioFramesSent: 0,
        audioFramesSentAfterTeardown: 0,
        browserEngine: navigator.userAgent.match(/(?:Chrome|Chromium)\\/[0-9.]+/)?.[0] ?? 'unverified',
        errors: [],
        ownedAudioCloseCalls: 0,
        pagehidePersisted: null,
        phase: 'booting',
        phaseBeforeHide: null,
        socketCloseCalls: [],
        syntheticMediaRequests: 0,
        teardownStarted: false,
        trackStatesAfterStop: [],
        trackStatesBeforeCleanup: [],
        trackStopCalls: 0,
      }
      window.__voiceSmokeState = state
      window.__voiceSmokeFixtureContexts = new WeakSet()
      window.__ModuleLoader__ = {
        load(descriptor) {
          window.__voiceClient = descriptor.factory(specifier => {
            if (specifier === 'react/jsx-runtime') {
              return { Fragment: Symbol('Fragment'), jsx: () => null, jsxs: () => null }
            }
            throw new Error('unexpected client dependency: ' + String(specifier))
          })
        },
      }
      window.__DSH_GUARDED_LIVE_VOICE__ = { v: 1, route: '/guarded-voice' }

      const NativeAudioContext = window.AudioContext || window.webkitAudioContext
      if (NativeAudioContext === undefined) throw new Error('AudioContext is unavailable')
      window.__voiceNativeAudioContext = NativeAudioContext
      const nativeClose = NativeAudioContext.prototype.close
      NativeAudioContext.prototype.close = function (...args) {
        if (!window.__voiceSmokeFixtureContexts.has(this)) state.ownedAudioCloseCalls += 1
        return nativeClose.apply(this, args)
      }

      const nativeTrackStop = MediaStreamTrack.prototype.stop
      MediaStreamTrack.prototype.stop = function (...args) {
        state.trackStopCalls += 1
        const result = nativeTrackStop.apply(this, args)
        state.trackStatesAfterStop.push(this.readyState)
        return result
      }

      const nativeSocketSend = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        if (typeof data !== 'string') {
          state.audioFramesSent += 1
          if (state.teardownStarted) state.audioFramesSentAfterTeardown += 1
          if (document.body !== null) document.body.dataset.audioFrames = String(state.audioFramesSent)
        }
        return nativeSocketSend.call(this, data)
      }
      const nativeSocketClose = WebSocket.prototype.close
      WebSocket.prototype.close = function (code, reason) {
        state.socketCloseCalls.push({ code: code ?? null, reason: reason ?? '' })
        if (reason === 'stopped' || reason === 'plugin disposed') state.teardownStarted = true
        return nativeSocketClose.call(this, code, reason)
      }

      const mediaDevices = navigator.mediaDevices
      if (mediaDevices === undefined) throw new Error('MediaDevices is unavailable')
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          state.syntheticMediaRequests += 1
          const context = new NativeAudioContext()
          window.__voiceSmokeFixtureContexts.add(context)
          const oscillator = context.createOscillator()
          const destination = context.createMediaStreamDestination()
          const mutedOutput = context.createGain()
          mutedOutput.gain.value = 0
          oscillator.connect(destination)
          oscillator.connect(mutedOutput)
          mutedOutput.connect(context.destination)
          oscillator.start()
          await context.resume()
          window.__voiceSyntheticSource = { context, destination, mutedOutput, oscillator }
          return destination.stream
        },
      })

      addEventListener('error', event => { state.errors.push(String(event.message || 'page error')) })
      addEventListener('unhandledrejection', event => {
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
        state.errors.push(reason)
      })
      addEventListener('pagehide', event => {
        state.phaseBeforeHide = window.__voiceInjected?.hooks.voice.getSnapshot().phase ?? null
        state.pagehidePersisted = event.persisted
        state.trackStatesBeforeCleanup = window.__voiceSyntheticSource?.destination.stream
          .getTracks().map(track => track.readyState) ?? []
      })
    })()
  </script>
  <script src="/client.js"></script>
</head>
<body>
  <h1>Guarded voice raw-unload smoke</h1>
  <p>This page uses a synthetic browser MediaStream and a loopback WebSocket. It never requests microphone permission.</p>
  <button id="start" type="button">Start</button>
  <button id="accept" type="button">Accept</button>
  <button id="record" type="button">Record</button>
  <output id="phase">booting</output>
  <script>
    (() => {
      const state = window.__voiceSmokeState
      const cleanups = []
      const registrations = []
      const ctx = {
        effect(factory) {
          const cleanup = factory()
          if (typeof cleanup === 'function') cleanups.push(cleanup)
        },
        locale: { register: () => () => {} },
        slots: {
          inject(_name, declare) { declare() },
          register(config) {
            registrations.push(config)
            return () => {}
          },
        },
      }
      window.__voiceClient.apply(ctx)
      const injected = registrations[0]?.inject()
      if (injected === undefined) throw new Error('voice slot did not register')
      window.__voiceInjected = injected
      window.__voiceCleanups = cleanups
      const sessionId = '${SESSION_ID}'
      const phase = document.querySelector('#phase')
      const update = () => {
        state.phase = injected.hooks.voice.getSnapshot().phase
        phase.textContent = state.phase
        document.body.dataset.phase = state.phase
        document.body.dataset.audioFrames = String(state.audioFramesSent)
      }
      injected.hooks.voice.subscribe(update)
      update()
      document.querySelector('#start').addEventListener('click', () => { injected.startVoice(sessionId) })
      document.querySelector('#accept').addEventListener('click', () => { injected.acceptDisclosure(sessionId, 0) })
      document.querySelector('#record').addEventListener('click', () => { injected.beginVoiceCapture(sessionId) })

      addEventListener('pagehide', () => {
        state.phaseAfterCleanup = injected.hooks.voice.getSnapshot().phase
        state.trackStatesAfterCleanup = window.__voiceSyntheticSource?.destination.stream
          .getTracks().map(track => track.readyState) ?? []
        const body = new Blob([JSON.stringify(state)], { type: 'application/json' })
        navigator.sendBeacon('/receipt', body)
      })
    })()
  </script>
</body>
</html>`
}

async function readBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.byteLength
    if (bytes > BODY_LIMIT) throw new Error('browser receipt exceeded the byte limit')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function secureHeaders(contentType) {
  return {
    'Cache-Control': 'no-store',
    'Content-Security-Policy': `default-src 'none'; connect-src 'self' ws://${expectedHost}; script-src 'self' 'unsafe-inline' blob:; style-src 'unsafe-inline'; worker-src blob:`,
    'Content-Type': contentType,
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  }
}

const server = createServer((request, response) => {
  void (async () => {
    if (request.headers.host !== expectedHost) {
      response.writeHead(421, secureHeaders('text/plain; charset=utf-8')).end('unexpected host')
      return
    }
    const requestUrl = new URL(request.url ?? '/', baseUrl)
    if (request.method === 'GET' && requestUrl.pathname === '/') {
      response.writeHead(200, secureHeaders('text/html; charset=utf-8')).end(page())
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === '/client.js') {
      response.writeHead(200, secureHeaders('text/javascript; charset=utf-8')).end(clientBundle)
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === '/done') {
      doneRequested = true
      resolveDone()
      response.writeHead(200, secureHeaders('text/html; charset=utf-8')).end('<!doctype html><title>raw unload complete</title><p>Raw unload complete.</p>')
      return
    }
    if (request.method === 'POST' && requestUrl.pathname === '/receipt') {
      assert.equal(pageReceipt, undefined, 'browser sent more than one unload receipt')
      pageReceipt = JSON.parse(await readBody(request))
      resolveReceipt()
      response.writeHead(204, secureHeaders('text/plain; charset=utf-8')).end()
      return
    }
    response.writeHead(404, secureHeaders('text/plain; charset=utf-8')).end('not found')
  })().catch(error => {
    fail(error)
    if (!response.headersSent) response.writeHead(500, secureHeaders('text/plain; charset=utf-8'))
    response.end('fixture failed')
  })
})

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 })
server.on('upgrade', (request, socket, head) => {
  try {
    const requestUrl = new URL(request.url ?? '/', baseUrl)
    assert.equal(request.headers.host, expectedHost)
    assert.equal(request.headers.origin, baseUrl)
    assert.equal(requestUrl.pathname, '/guarded-voice')
    assert.equal(webSocketServer.clients.size, 0, 'fixture accepts one browser socket only')
    webSocketServer.handleUpgrade(request, socket, head, client => {
      webSocketServer.emit('connection', client, request)
    })
  } catch (error) {
    socket.destroy()
    fail(error)
  }
})

webSocketServer.on('connection', socket => {
  let phase = 'binding'
  socket.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        binaryFrames += 1
        if (pageReceipt !== undefined) postReceiptBinaryFrames += 1
        return
      }
      const control = JSON.parse(String(data))
      if (phase === 'binding') {
        assert.deepEqual(control, { v: 1, type: 'bind', sessionId: SESSION_ID })
        phase = 'consent'
        socket.send(JSON.stringify({
          v: 1,
          type: 'consent.required',
          challenge: CHALLENGE,
          expiresAt: Date.now() + 60_000,
          sessionId: SESSION_ID,
          workspaceId: WORKSPACE_ID,
          provider: 'qwen',
          disclosure: {
            audioDestination: 'Alibaba Cloud Qwen realtime API',
            exportedContext: 'none',
            executionAuthority: 'none',
            providerRetention: 'not specified for Qwen realtime audio',
            currentMilestone: 'one bounded manual audio turn after acceptance',
          },
        }))
        return
      }
      if (phase === 'consent') {
        assert.deepEqual(control, { v: 1, type: 'consent.accept', challenge: CHALLENGE })
        phase = 'recording'
        socket.send(JSON.stringify({
          v: 1,
          type: 'ready',
          sessionId: SESSION_ID,
          workspaceId: WORKSPACE_ID,
          provider: 'qwen',
          model: MODEL,
          authority: 'proposal-only',
        }))
        return
      }
      if (phase === 'recording' && control?.v === 1 && control?.type === 'stop') {
        phase = 'stopped'
        return
      }
      throw new Error(`unexpected browser control in phase ${phase}`)
    } catch (error) {
      fail(error)
      socket.terminate()
    }
  })
  socket.on('close', (code, reason) => {
    browserSocketClose = { code, reason: reason.toString('utf8') }
    resolveSocketClose()
  })
  socket.on('error', fail)
})

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  expectedHost = `127.0.0.1:${String(address.port)}`
  baseUrl = `http://${expectedHost}`
  process.stdout.write(`${JSON.stringify({ browserUnloadSmokeUrl: `${baseUrl}/` })}\n`)

  await withTimeout(
    Promise.race([Promise.all([receiptReady, socketCloseReady, doneReady]), failure]),
    TIMEOUT_MS,
    'controlled browser raw unload',
  )
  await new Promise(resolveDelay => setTimeout(resolveDelay, QUIET_MS))

  assert.equal(doneRequested, true)
  assert.equal(pageReceipt.phaseBeforeHide, 'recording')
  assert.equal(pageReceipt.phaseAfterCleanup, 'idle')
  assert.equal(pageReceipt.pagehidePersisted, false)
  assert.equal(pageReceipt.syntheticMediaRequests, 1)
  assert.deepEqual(pageReceipt.trackStatesBeforeCleanup, ['live'])
  assert.deepEqual(pageReceipt.trackStatesAfterCleanup, ['ended'])
  assert.deepEqual(pageReceipt.trackStatesAfterStop, ['ended'])
  assert.equal(pageReceipt.trackStopCalls, 1)
  assert.equal(pageReceipt.ownedAudioCloseCalls, 2)
  assert.deepEqual(pageReceipt.socketCloseCalls, [{ code: 1000, reason: 'stopped' }])
  assert.equal(pageReceipt.audioFramesSent > 0, true, 'browser did not exercise the active audio path')
  assert.equal(pageReceipt.audioFramesSentAfterTeardown, 0)
  assert.match(pageReceipt.browserEngine, /^(?:Chrome|Chromium)\/[0-9.]+$/u)
  assert.deepEqual(pageReceipt.errors, [])
  assert.equal(binaryFrames > 0, true, 'loopback peer received no browser audio')
  assert.equal(postReceiptBinaryFrames, 0)
  assert.deepEqual(browserSocketClose, { code: 1000, reason: 'stopped' })

  process.stdout.write(`${JSON.stringify({
    rawDocumentUnload: true,
    browserEngine: pageReceipt.browserEngine,
    pagehidePersisted: pageReceipt.pagehidePersisted,
    phaseBeforeHide: pageReceipt.phaseBeforeHide,
    phaseAfterCleanup: pageReceipt.phaseAfterCleanup,
    syntheticTrackStopped: true,
    ownedAudioContextsCloseRequested: pageReceipt.ownedAudioCloseCalls,
    browserAudioFrames: pageReceipt.audioFramesSent,
    loopbackAudioFrames: binaryFrames,
    postTeardownAudioFrames: pageReceipt.audioFramesSentAfterTeardown,
    postReceiptAudioFrames: postReceiptBinaryFrames,
    browserSocketClose,
    physicalMicrophone: false,
    liveProvider: false,
    packagedDshClient: false,
  })}\n`)
} finally {
  for (const client of webSocketServer.clients) client.terminate()
  await withTimeout(
    new Promise(resolveClose => webSocketServer.close(() => resolveClose())),
    5_000,
    'fixture WebSocket shutdown',
  ).catch(() => {})
  if (server.listening) {
    const closed = once(server, 'close')
    server.close()
    server.closeAllConnections()
    await withTimeout(closed, 5_000, 'fixture HTTP shutdown').catch(() => {})
  }
}
