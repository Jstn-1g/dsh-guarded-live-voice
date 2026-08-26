import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { assessUpgradeRequest, rejectUpgrade } from './carrier.js'
import type { VoiceSessionManager } from './session-manager.js'
import { asGuardedVoiceError, GuardedVoiceError } from '../shared/errors.js'
import {
  MAX_CONTROL_BYTES,
  WIRE_VERSION,
  encodeServerControl,
  parseClientControl,
  type ClientControl,
  type ServerControl,
} from '../shared/wire.js'

export interface GatewayLogger {
  warn(error: Error): void
}

export interface GuardedVoiceGatewayOptions {
  readonly manager: VoiceSessionManager
  readonly trustedHosts: readonly string[]
  readonly bindTimeoutMs?: number
  readonly maxConnections?: number
  readonly logger?: GatewayLogger
}

interface ClientRecord {
  readonly socket: WebSocket
  tail: Promise<void>
  bindTimer: ReturnType<typeof setTimeout> | undefined
  consentTimer: ReturnType<typeof setTimeout> | undefined
}

function textOf(data: RawData): string {
  if (typeof data === 'string') return data
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8')
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8')
  return data.toString('utf8')
}

/** Milestone-one carrier: JSON binding and consent only; audio is fail-closed. */
export class GuardedVoiceGateway {
  private readonly server = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: MAX_CONTROL_BYTES,
  })
  private readonly clients = new Map<string, ClientRecord>()
  private readonly bindTimeoutMs: number
  private readonly maxConnections: number

  constructor(private readonly options: GuardedVoiceGatewayOptions) {
    this.bindTimeoutMs = options.bindTimeoutMs ?? 10_000
    this.maxConnections = options.maxConnections ?? 8
    if (!Number.isSafeInteger(this.bindTimeoutMs) || this.bindTimeoutMs < 10 || this.bindTimeoutMs > 60_000) {
      throw new TypeError('bind timeout must be an integer between 10 ms and 60 seconds')
    }
    if (!Number.isSafeInteger(this.maxConnections) || this.maxConnections < 1 || this.maxConnections > 64) {
      throw new TypeError('max connections must be an integer between 1 and 64')
    }
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const assessment = assessUpgradeRequest({
      method: request.method,
      headers: request.headers,
      remoteAddress: request.socket.remoteAddress,
    }, this.options.trustedHosts)
    if (!assessment.ok) {
      rejectUpgrade(socket, assessment)
      return
    }
    if (this.clients.size >= this.maxConnections) {
      rejectUpgrade(socket, { ok: false, status: 429, reason: 'guarded voice connection limit reached' })
      return
    }
    this.server.handleUpgrade(request, socket, head, webSocket => this.accept(webSocket))
  }

  stopSession(sessionId: string): void {
    for (const connectionId of this.options.manager.stopSession(sessionId)) {
      const client = this.take(connectionId)
      if (client === undefined) continue
      this.send(client.socket, {
        v: WIRE_VERSION,
        type: 'error',
        code: 'authority-changed',
        message: 'the bound session was disposed',
      })
      client.socket.close(1008, 'session disposed')
    }
  }

  close(): void {
    for (const connectionId of [...this.clients.keys()]) {
      const client = this.take(connectionId)
      if (client === undefined) continue
      this.options.manager.stop(connectionId)
      client.socket.terminate()
    }
    this.server.close()
  }

  /** Number of carrier connections currently consuming the bounded capacity. */
  get connectionCount(): number {
    return this.clients.size
  }

  private accept(socket: WebSocket): void {
    const connectionId = randomUUID()
    const client: ClientRecord = {
      socket,
      tail: Promise.resolve(),
      bindTimer: undefined,
      consentTimer: undefined,
    }
    client.bindTimer = setTimeout(() => {
      this.fail(connectionId, new GuardedVoiceError('invalid-state', 'connection did not bind in time'))
    }, this.bindTimeoutMs)
    this.clients.set(connectionId, client)

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.fail(connectionId, new GuardedVoiceError('invalid-message', 'audio frames are not enabled in this milestone'))
        return
      }
      let control: ClientControl
      try {
        control = parseClientControl(textOf(data))
      } catch (error) {
        this.fail(connectionId, error)
        return
      }
      // Stop is a cancellation signal, not another ordered provider message.
      // Process it immediately so a pending authorization cannot delay it.
      if (control.type === 'stop') {
        this.stopNow(connectionId)
        return
      }
      client.tail = client.tail
        .then(() => this.handleControl(connectionId, control))
        .catch(error => { this.fail(connectionId, error) })
    })
    socket.once('close', () => { this.remove(connectionId) })
    socket.once('error', error => {
      this.options.logger?.warn(error)
      this.remove(connectionId)
    })
  }

  private async handleControl(connectionId: string, control: Exclude<ClientControl, { readonly type: 'stop' }>): Promise<void> {
    const client = this.clients.get(connectionId)
    if (client === undefined) return
    if (control.type === 'bind') {
      const begun = this.options.manager.begin(connectionId, control.sessionId)
      if (client.bindTimer !== undefined) clearTimeout(client.bindTimer)
      client.bindTimer = undefined
      client.consentTimer = setTimeout(() => {
        this.fail(connectionId, new GuardedVoiceError('consent-expired', 'disclosure acceptance expired'))
      }, Math.max(0, begun.expiresAt - Date.now()))
      this.send(client.socket, {
        v: WIRE_VERSION,
        type: 'consent.required',
        challenge: begun.challenge,
        expiresAt: begun.expiresAt,
        sessionId: begun.binding.sessionId,
        workspaceId: begun.binding.workspaceId,
        provider: 'qwen',
        disclosure: {
          audioDestination: 'Alibaba Cloud Qwen realtime API',
          exportedContext: 'none',
          executionAuthority: 'none',
          providerRetention: 'not specified for Qwen realtime audio',
          currentMilestone: 'no microphone access or audio transmission',
        },
      })
      return
    }
    if (client.consentTimer !== undefined) clearTimeout(client.consentTimer)
    client.consentTimer = undefined
    const ready = await this.options.manager.acceptConsent(connectionId, control.challenge)
    this.send(client.socket, {
      v: WIRE_VERSION,
      type: 'ready',
      sessionId: ready.binding.sessionId,
      workspaceId: ready.binding.workspaceId,
      provider: ready.provider.provider,
      model: ready.provider.model,
      authority: 'proposal-only',
    })
  }

  private stopNow(connectionId: string): void {
    // Detach the transport first. Aborting authorization rejects its queued
    // consent handler, which must not race this graceful terminal outcome.
    const client = this.take(connectionId)
    if (client === undefined) return
    this.options.manager.stop(connectionId)
    this.send(client.socket, { v: WIRE_VERSION, type: 'stopped' })
    client.socket.close(1000, 'stopped')
  }

  private fail(connectionId: string, error: unknown): void {
    const client = this.take(connectionId)
    if (client === undefined) return
    const safe = asGuardedVoiceError(error)
    this.options.logger?.warn(safe)
    this.send(client.socket, {
      v: WIRE_VERSION,
      type: 'error',
      code: safe.code,
      message: safe.message,
    })
    this.options.manager.stop(connectionId)
    client.socket.close(1008, safe.code)
  }

  private send(socket: WebSocket, event: ServerControl): void {
    if (socket.readyState === WebSocket.OPEN) socket.send(encodeServerControl(event))
  }

  private remove(connectionId: string): void {
    this.take(connectionId)
    this.options.manager.stop(connectionId)
  }

  private take(connectionId: string): ClientRecord | undefined {
    const client = this.clients.get(connectionId)
    if (client === undefined) return undefined
    this.clients.delete(connectionId)
    this.clearTimers(client)
    return client
  }

  private clearTimers(client: ClientRecord): void {
    if (client.bindTimer !== undefined) clearTimeout(client.bindTimer)
    if (client.consentTimer !== undefined) clearTimeout(client.consentTimer)
    client.bindTimer = undefined
    client.consentTimer = undefined
  }
}
