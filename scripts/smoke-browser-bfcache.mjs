/**
 * Controlled-browser fixture for real Chromium BFCache save/restore receipts.
 *
 * The fixture is loopback-only and substitutes a synthetic Web Audio stream for
 * getUserMedia. It never requests microphone permission, resolves a credential,
 * or connects to Qwen. A browser driver exercises both printed case URLs by
 * navigating each tab to the printed away URL and then traversing back.
 */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'

const TIMEOUT_MS = 240_000
const BODY_LIMIT = 32 * 1024
const WORKSPACE_ID = 'bfcache-workspace'
const CHALLENGE_PREFIX = 'controlled_bfcache_challenge_'
const MODEL = 'qwen-audio-3.0-realtime-plus'
const RUN_TOKEN = randomUUID()
const CASES = ['idle', 'active']
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const clientBundle = await readFile(resolve(pluginRoot, 'lib/client.js'), 'utf8')

let expectedHost = ''
let baseUrl = ''
let resolveReceipts
let resolveConnectionsClosed
let rejectFailure
const receipts = new Map()
const connections = []
const receiptsReady = new Promise(resolveReady => { resolveReceipts = resolveReady })
const connectionsClosed = new Promise(resolveClosed => { resolveConnectionsClosed = resolveClosed })
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

function browserPage(testCase) {
  const sessionId = `${testCase}-session`
  const freshSessionId = `${testCase}-restored-session`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>DSH Live Voice BFCache ${testCase} smoke</title>
  <style>
    body { color: #151515; font: 16px/1.5 system-ui, sans-serif; margin: 3rem auto; max-width: 48rem; padding: 0 1rem; }
    button { font: inherit; margin: .5rem .5rem .5rem 0; padding: .65rem 1rem; }
    output { display: block; font-family: ui-monospace, monospace; margin-top: 1rem; }
  </style>
  <script>
    (() => {
      const testCase = ${JSON.stringify(testCase)}
      const runToken = ${JSON.stringify(RUN_TOKEN)}
      const historyKey = 'dsh-live-voice:bfcache:' + runToken + ':' + testCase
      const returning = sessionStorage.getItem(historyKey) === 'away'
      const state = {
        testCase,
        runToken,
        bootNonce: crypto.randomUUID(),
        returning,
        audioFramesSent: 0,
        audioFramesSentAfterTeardown: 0,
        browserEngine: navigator.userAgent.match(/(?:Chrome|Chromium)\\/[0-9.]+/)?.[0] ?? 'unverified',
        errors: [],
        fixtureAudioCloseCalls: 0,
        freshCommitNoop: null,
        freshDisclosureRequired: null,
        freshPhase: null,
        freshSocketSendDelta: null,
        initialPageshowPersisted: null,
        isComposerBindingAfterCleanup: null,
        notRestoredReasons: null,
        ownedAudioCloseCallsBeforeRestore: 0,
        ownedAudioCloseCallsTotal: 0,
        pagehidePersisted: null,
        pageshowPersisted: [],
        phaseAfterCleanup: null,
        phaseAfterRestore: null,
        phaseBeforeHide: null,
        restored: false,
        socketCloseCalls: [],
        socketSends: [],
        staleAcceptNoop: null,
        staleClaimRejected: null,
        staleSessionNoop: null,
        syntheticMediaRequests: 0,
        timeoutCleared: 0,
        timeoutScheduled: 0,
        timersAfterCleanup: null,
        timersBeforeHide: null,
        trackStatesAfterCleanup: [],
        trackStatesBeforeCleanup: [],
        trackStopCallsBeforeRestore: 0,
        trackStopCallsTotal: 0,
      }
      window.__voiceBfcacheState = state
      window.__voiceBfcacheHistoryKey = historyKey
      window.__voiceFixtureContexts = new WeakSet()
      window.__voiceTrackedTimers = new Set()
      window.__voiceComposerIdentity = {}
      window.__voiceFreshComposerIdentity = {}

      const nativeSetTimeout = window.setTimeout.bind(window)
      const nativeClearTimeout = window.clearTimeout.bind(window)
      window.setTimeout = (handler, delay, ...args) => {
        let timer
        const wrapped = typeof handler === 'function'
          ? (...callbackArgs) => {
              window.__voiceTrackedTimers.delete(timer)
              return handler(...callbackArgs)
            }
          : handler
        timer = nativeSetTimeout(wrapped, delay, ...args)
        window.__voiceTrackedTimers.add(timer)
        state.timeoutScheduled += 1
        return timer
      }
      window.clearTimeout = timer => {
        if (window.__voiceTrackedTimers.delete(timer)) state.timeoutCleared += 1
        return nativeClearTimeout(timer)
      }

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
      const nativeClose = NativeAudioContext.prototype.close
      NativeAudioContext.prototype.close = function (...args) {
        if (window.__voiceFixtureContexts.has(this)) state.fixtureAudioCloseCalls += 1
        else {
          state.ownedAudioCloseCallsTotal += 1
          if (!state.restored) state.ownedAudioCloseCallsBeforeRestore += 1
        }
        return nativeClose.apply(this, args)
      }

      const nativeTrackStop = MediaStreamTrack.prototype.stop
      MediaStreamTrack.prototype.stop = function (...args) {
        state.trackStopCallsTotal += 1
        if (!state.restored) state.trackStopCallsBeforeRestore += 1
        return nativeTrackStop.apply(this, args)
      }

      const nativeSocketSend = WebSocket.prototype.send
      WebSocket.prototype.send = function (data) {
        const entry = {
          afterRestore: state.restored,
          binary: typeof data !== 'string',
          control: typeof data === 'string' ? data : null,
        }
        state.socketSends.push(entry)
        if (entry.binary) {
          state.audioFramesSent += 1
          if (state.socketCloseCalls.some(call => call.afterRestore === false)) {
            state.audioFramesSentAfterTeardown += 1
          }
          if (document.body !== null) document.body.dataset.audioFrames = String(state.audioFramesSent)
          const frames = document.querySelector('#frames')
          if (frames !== null) frames.textContent = 'synthetic audio frames: ' + String(state.audioFramesSent)
        }
        return nativeSocketSend.call(this, data)
      }
      const nativeSocketClose = WebSocket.prototype.close
      WebSocket.prototype.close = function (code, reason) {
        state.socketCloseCalls.push({ afterRestore: state.restored, code: code ?? null, reason: reason ?? '' })
        return nativeSocketClose.call(this, code, reason)
      }

      const mediaDevices = navigator.mediaDevices
      if (mediaDevices === undefined) throw new Error('MediaDevices is unavailable')
      Object.defineProperty(mediaDevices, 'getUserMedia', {
        configurable: true,
        value: async () => {
          state.syntheticMediaRequests += 1
          const context = new NativeAudioContext()
          window.__voiceFixtureContexts.add(context)
          const oscillator = context.createOscillator()
          const destination = context.createMediaStreamDestination()
          oscillator.connect(destination)
          oscillator.start()
          await context.resume()
          window.__voiceSyntheticSource = { context, destination, oscillator }
          return destination.stream
        },
      })

      addEventListener('error', event => { state.errors.push(String(event.message || 'page error')) })
      addEventListener('unhandledrejection', event => {
        const reason = event.reason instanceof Error ? event.reason.message : String(event.reason)
        state.errors.push(reason)
      })
      addEventListener('pagehide', event => {
        sessionStorage.setItem(historyKey, 'away')
        state.phaseBeforeHide = window.__voiceInjected?.hooks.voice.getSnapshot().phase ?? null
        state.pagehidePersisted = event.persisted
        state.timersBeforeHide = window.__voiceTrackedTimers.size
        state.trackStatesBeforeCleanup = window.__voiceSyntheticSource?.destination.stream
          .getTracks().map(track => track.readyState) ?? []
        const source = window.__voiceSyntheticSource
        if (source !== undefined) {
          try { source.oscillator.stop() } catch {}
          void source.context.close()
        }
      })
    })()
  </script>
  <script src="/client.js"></script>
</head>
<body data-case="${testCase}">
  <h1>DSH Live Voice BFCache ${testCase} smoke</h1>
  <p>This page uses synthetic audio and loopback transport only.</p>
  <button id="start" type="button">Start</button>
  <button id="accept" type="button">Accept</button>
  <button id="record" type="button">Record</button>
  <output id="phase">booting</output>
  <output id="frames">synthetic audio frames: 0</output>
  <script>
    (() => {
      const state = window.__voiceBfcacheState
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
      const sessionId = ${JSON.stringify(sessionId)}
      const freshSessionId = ${JSON.stringify(freshSessionId)}
      const phase = document.querySelector('#phase')
      const frames = document.querySelector('#frames')
      let receiptSent = false
      let restoredFreshAccepted = false
      let restoredFreshStarted = false

      const sendReceipt = () => {
        if (receiptSent) return
        receiptSent = true
        state.finalPhase = injected.hooks.voice.getSnapshot().phase
        document.body.dataset.receipt = 'sent'
        const body = new Blob([JSON.stringify(state)], { type: 'application/json' })
        if (!navigator.sendBeacon('/receipt', body)) throw new Error('BFCache receipt beacon was rejected')
      }

      const update = () => {
        const snapshot = injected.hooks.voice.getSnapshot()
        phase.textContent = snapshot.error === undefined ? snapshot.phase : snapshot.phase + ': ' + snapshot.error
        document.body.dataset.phase = snapshot.phase
        document.body.dataset.voiceError = snapshot.error ?? ''
        document.body.dataset.audioFrames = String(state.audioFramesSent)
        frames.textContent = 'synthetic audio frames: ' + String(state.audioFramesSent)
        if (state.restored
          && snapshot.sessionId === freshSessionId
          && snapshot.phase === 'awaiting-consent'
          && !restoredFreshAccepted) {
          restoredFreshAccepted = true
          state.freshDisclosureRequired = true
          injected.acceptDisclosure(freshSessionId, 1, window.__voiceFreshComposerIdentity)
        }
        if (state.restored && snapshot.sessionId === freshSessionId && snapshot.phase === 'ready' && !receiptSent) {
          state.freshPhase = snapshot.phase
          const sendsBeforeCommit = state.socketSends.length
          injected.commitVoiceTurn(freshSessionId)
          state.freshCommitNoop = injected.hooks.voice.getSnapshot().phase === 'ready'
          state.freshSocketSendDelta = state.socketSends.length - sendsBeforeCommit
          injected.stopVoice(freshSessionId)
          queueMicrotask(sendReceipt)
        }
      }
      injected.hooks.voice.subscribe(update)
      update()

      document.querySelector('#start').addEventListener('click', () => { injected.startVoice(sessionId) })
      document.querySelector('#accept').addEventListener('click', () => {
        injected.acceptDisclosure(sessionId, 0, window.__voiceComposerIdentity)
      })
      document.querySelector('#record').addEventListener('click', () => { injected.beginVoiceCapture(sessionId) })

      addEventListener('pagehide', () => {
        state.phaseAfterCleanup = injected.hooks.voice.getSnapshot().phase
        state.timersAfterCleanup = window.__voiceTrackedTimers.size
        state.trackStatesAfterCleanup = window.__voiceSyntheticSource?.destination.stream
          .getTracks().map(track => track.readyState) ?? []
        state.isComposerBindingAfterCleanup = injected.isComposerBindingCurrent(
          sessionId,
          window.__voiceComposerIdentity,
        )
      })

      addEventListener('pageshow', event => {
        state.pageshowPersisted.push(event.persisted)
        if (state.initialPageshowPersisted === null) state.initialPageshowPersisted = event.persisted
        if (!state.returning && !event.persisted) return
        if (!event.persisted) {
          state.notRestoredReasons = performance.getEntriesByType('navigation')[0]?.notRestoredReasons ?? null
          state.errors.push('history traversal did not restore this document from BFCache')
          sendReceipt()
          return
        }
        state.restored = true
        state.phaseAfterRestore = injected.hooks.voice.getSnapshot().phase
        state.staleClaimRejected = !injected.claimVoiceDraftHandoff(
          sessionId,
          window.__voiceComposerIdentity,
          0,
        )
        const staleSendsBefore = state.socketSends.length
        injected.acceptDisclosure(sessionId, 0, window.__voiceComposerIdentity)
        state.staleAcceptNoop = injected.hooks.voice.getSnapshot().phase === 'idle'
        injected.appendVoicePcm16(sessionId, new Uint8Array([0, 0]))
        injected.commitVoiceTurn(sessionId)
        state.staleSessionNoop = state.socketSends.length === staleSendsBefore
          && injected.hooks.voice.getSnapshot().phase === 'idle'
        if (!restoredFreshStarted) {
          restoredFreshStarted = true
          injected.startVoice(freshSessionId)
        }
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

function secureHeaders(contentType, cacheControl = 'no-store') {
  return {
    'Cache-Control': cacheControl,
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
    if (request.method === 'GET' && requestUrl.pathname.startsWith('/case/')) {
      const testCase = requestUrl.pathname.slice('/case/'.length)
      if (!CASES.includes(testCase)) {
        response.writeHead(404, secureHeaders('text/plain; charset=utf-8')).end('unknown case')
        return
      }
      response.writeHead(200, secureHeaders(
        'text/html; charset=utf-8',
        'private, max-age=0, must-revalidate',
      )).end(browserPage(testCase))
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === '/client.js') {
      response.writeHead(200, secureHeaders('text/javascript; charset=utf-8')).end(clientBundle)
      return
    }
    if (request.method === 'GET' && requestUrl.pathname === '/away') {
      response.writeHead(200, secureHeaders('text/html; charset=utf-8')).end(
        '<!doctype html><title>BFCache traversal point</title><p>Use browser Back to restore the voice fixture.</p>',
      )
      return
    }
    if (request.method === 'POST' && requestUrl.pathname === '/receipt') {
      const receipt = JSON.parse(await readBody(request))
      assert.ok(CASES.includes(receipt.testCase), 'receipt used an unknown case')
      assert.equal(receipt.runToken, RUN_TOKEN, 'receipt used the wrong run token')
      assert.equal(receipts.has(receipt.testCase), false, `duplicate ${receipt.testCase} receipt`)
      receipts.set(receipt.testCase, receipt)
      if (receipts.size === CASES.length) resolveReceipts()
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
    webSocketServer.handleUpgrade(request, socket, head, client => {
      webSocketServer.emit('connection', client, request)
    })
  } catch (error) {
    socket.destroy()
    fail(error)
  }
})

webSocketServer.on('connection', socket => {
  const record = { binaryFrames: 0, controls: [], sessionId: null, close: null }
  connections.push(record)
  let phase = 'binding'
  socket.on('message', (data, isBinary) => {
    try {
      if (isBinary) {
        assert.equal(phase, 'ready', `binary audio arrived while loopback peer was ${phase}`)
        record.binaryFrames += 1
        return
      }
      const control = JSON.parse(String(data))
      record.controls.push(control)
      if (phase === 'binding') {
        assert.deepEqual(control, { v: 1, type: 'bind', sessionId: control.sessionId })
        assert.match(control.sessionId, /^(?:idle|active)(?:-restored)?-session$/u)
        record.sessionId = control.sessionId
        phase = 'consent'
        socket.send(JSON.stringify({
          v: 1,
          type: 'consent.required',
          challenge: `${CHALLENGE_PREFIX}${control.sessionId}`,
          expiresAt: Date.now() + 60_000,
          sessionId: control.sessionId,
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
        if (control?.v === 1 && control?.type === 'stop') {
          phase = 'stopped'
          return
        }
        assert.deepEqual(control, {
          v: 1,
          type: 'consent.accept',
          challenge: `${CHALLENGE_PREFIX}${record.sessionId}`,
        })
        phase = 'ready'
        socket.send(JSON.stringify({
          v: 1,
          type: 'ready',
          sessionId: record.sessionId,
          workspaceId: WORKSPACE_ID,
          provider: 'qwen',
          model: MODEL,
          authority: 'proposal-only',
        }))
        return
      }
      if (phase === 'ready' && control?.v === 1 && control?.type === 'stop') {
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
    record.close = { code, reason: reason.toString('utf8') }
    if (connections.length >= 3 && connections.every(connection => connection.close !== null)) {
      resolveConnectionsClosed()
    }
  })
  socket.on('error', fail)
})

function assertCommon(receipt, testCase) {
  assert.equal(receipt.testCase, testCase)
  assert.equal(receipt.returning, false, 'BFCache restore unexpectedly reloaded the document')
  assert.equal(receipt.initialPageshowPersisted, false)
  assert.deepEqual(receipt.pageshowPersisted, [false, true])
  assert.equal(receipt.pagehidePersisted, true)
  assert.equal(receipt.phaseAfterCleanup, 'idle')
  assert.equal(receipt.phaseAfterRestore, 'idle')
  assert.equal(receipt.isComposerBindingAfterCleanup, false)
  assert.equal(receipt.staleAcceptNoop, true)
  assert.equal(receipt.staleClaimRejected, true)
  assert.equal(receipt.staleSessionNoop, true)
  assert.equal(receipt.freshDisclosureRequired, true)
  assert.equal(receipt.freshPhase, 'ready')
  assert.equal(receipt.freshCommitNoop, true)
  assert.equal(receipt.freshSocketSendDelta, 0)
  assert.equal(receipt.finalPhase, 'idle')
  assert.deepEqual(receipt.errors, [])
  assert.match(receipt.browserEngine, /^(?:Chrome|Chromium)\/[0-9.]+$/u)
}

try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address !== null && typeof address === 'object')
  expectedHost = `127.0.0.1:${String(address.port)}`
  baseUrl = `http://${expectedHost}`
  process.stdout.write(`${JSON.stringify({
    browserBfcacheSmoke: {
      idleUrl: `${baseUrl}/case/idle`,
      activeUrl: `${baseUrl}/case/active`,
      awayUrl: `${baseUrl}/away`,
    },
  })}\n`)

  await withTimeout(Promise.race([receiptsReady, failure]), TIMEOUT_MS, 'controlled browser BFCache')

  const idle = receipts.get('idle')
  const active = receipts.get('active')
  assertCommon(idle, 'idle')
  assertCommon(active, 'active')

  await withTimeout(
    Promise.race([connectionsClosed, failure]),
    5_000,
    'controlled browser BFCache socket closure',
  )

  assert.equal(idle.phaseBeforeHide, 'idle')
  assert.equal(idle.syntheticMediaRequests, 0)
  assert.equal(idle.trackStopCallsBeforeRestore, 0)
  assert.equal(idle.ownedAudioCloseCallsBeforeRestore, 0)
  assert.equal(idle.timersBeforeHide, 0)
  assert.equal(idle.timersAfterCleanup, 0)
  assert.deepEqual(idle.trackStatesBeforeCleanup, [])
  assert.deepEqual(idle.trackStatesAfterCleanup, [])
  assert.deepEqual(idle.socketCloseCalls, [
    { afterRestore: true, code: 1000, reason: 'stopped' },
  ])

  assert.equal(active.phaseBeforeHide, 'recording')
  assert.equal(active.syntheticMediaRequests, 1)
  assert.equal(active.audioFramesSent > 0, true, 'active BFCache case sent no synthetic audio')
  assert.equal(active.audioFramesSentAfterTeardown, 0)
  assert.equal(active.trackStopCallsBeforeRestore, 1)
  assert.equal(active.ownedAudioCloseCallsBeforeRestore, 2)
  assert.equal(active.timersBeforeHide, 0)
  assert.equal(active.timersAfterCleanup, 0)
  assert.deepEqual(active.trackStatesBeforeCleanup, ['live'])
  assert.deepEqual(active.trackStatesAfterCleanup, ['ended'])
  assert.deepEqual(active.socketCloseCalls, [
    { afterRestore: false, code: 1000, reason: 'stopped' },
    { afterRestore: true, code: 1000, reason: 'stopped' },
  ])
  assert.equal(active.socketSends.some(entry => {
    if (entry.afterRestore || entry.binary || entry.control === null) return false
    const control = JSON.parse(entry.control)
    return control?.v === 1 && control?.type === 'stop'
  }), true, 'active BFCache cleanup sent no pre-restore stop control')

  assert.equal(connections.length, 3, 'BFCache fixture created an unexpected connection count')
  const connectionSessionIds = connections.map(connection => connection.sessionId)
  assert.equal(
    new Set(connectionSessionIds).size,
    connections.length,
    'BFCache fixture reused a loopback session id',
  )
  const bySession = new Map(connections.map(connection => [connection.sessionId, connection]))
  assert.deepEqual([...bySession.keys()].sort(), [
    'active-restored-session',
    'active-session',
    'idle-restored-session',
  ])
  assert.equal(bySession.get('active-session').binaryFrames > 0, true)
  assert.equal(bySession.get('active-restored-session').binaryFrames, 0)
  assert.equal(bySession.get('idle-restored-session').binaryFrames, 0)
  for (const connection of bySession.values()) {
    assert.deepEqual(connection.close, { code: 1000, reason: 'stopped' })
  }

  process.stdout.write(`${JSON.stringify({
    bfcacheSaveRestore: true,
    browserEngine: active.browserEngine,
    idle: {
      pagehidePersisted: idle.pagehidePersisted,
      pageshowPersisted: idle.pageshowPersisted,
      phaseAfterRestore: idle.phaseAfterRestore,
      freshLifecycle: idle.freshPhase,
    },
    active: {
      phaseBeforeHide: active.phaseBeforeHide,
      phaseAfterCleanup: active.phaseAfterCleanup,
      phaseAfterRestore: active.phaseAfterRestore,
      syntheticTrackStopped: active.trackStatesAfterCleanup[0] === 'ended',
      ownedAudioContextsCloseRequested: active.ownedAudioCloseCallsBeforeRestore,
      browserAudioFrames: active.audioFramesSent,
      loopbackAudioFrames: bySession.get('active-session').binaryFrames,
      postTeardownAudioFrames: active.audioFramesSentAfterTeardown,
      preRestoreSocketClose: active.socketCloseCalls[0],
      timersAfterCleanup: active.timersAfterCleanup,
      staleConsentRejected: active.staleAcceptNoop,
      staleComposerBindingRejected: active.staleClaimRejected,
      staleSessionRejected: active.staleSessionNoop,
      staleInputBufferRejected: active.freshCommitNoop,
      freshLifecycle: active.freshPhase,
    },
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
