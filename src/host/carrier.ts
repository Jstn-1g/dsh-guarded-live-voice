import type { IncomingHttpHeaders } from 'node:http'
import type { Duplex } from 'node:stream'

export type UpgradeAssessment =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 403 | 426 | 429; readonly reason: string }

const ACCEPTED: UpgradeAssessment = { ok: true }

export interface UpgradeRequestView {
  readonly method: string | undefined
  readonly headers: IncomingHttpHeaders
  readonly remoteAddress: string | undefined
}

function oneHeader(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  if (Array.isArray(value)) return undefined
  return value
}

function parseAuthority(raw: string): URL | undefined {
  if (raw.includes('/') || raw.includes('\\') || /[\u0000-\u0020\u007f]/u.test(raw)) return undefined
  try {
    const value = new URL(`http://${raw}`)
    if (value.username !== ''
      || value.password !== ''
      || value.pathname !== '/'
      || value.search !== ''
      || value.hash !== '') return undefined
    return value
  } catch {
    return undefined
  }
}

function isTrustedHost(requested: URL, trustedHosts: readonly string[]): boolean {
  return trustedHosts.some(entry => {
    const trusted = parseAuthority(entry)
    if (trusted === undefined) return false
    if (trusted.hostname.toLowerCase() !== requested.hostname.toLowerCase()) return false
    return trusted.port === '' || trusted.port === requested.port
  })
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) return false
  const normalized = address.toLowerCase().split('%', 1)[0]
  return normalized === '127.0.0.1'
    || normalized === '::1'
    || normalized === '::ffff:127.0.0.1'
}

/** Loopback-only, same-origin, explicit-host fence for the privileged WebSocket. */
export function assessUpgradeRequest(
  request: UpgradeRequestView,
  trustedHosts: readonly string[],
): UpgradeAssessment {
  // Host and Origin are client-controlled. The peer address is the milestone-
  // one authorization floor, preventing a remote raw client from spoofing both.
  if (!isLoopbackAddress(request.remoteAddress)) {
    return { ok: false, status: 403, reason: 'guarded voice is loopback-only' }
  }
  if (request.method !== 'GET') return { ok: false, status: 400, reason: 'websocket upgrade must use GET' }
  const upgrade = oneHeader(request.headers, 'upgrade')?.toLowerCase()
  const connection = oneHeader(request.headers, 'connection')?.toLowerCase().split(',').map(value => value.trim())
  if (upgrade !== 'websocket' || !connection?.includes('upgrade')) {
    return { ok: false, status: 426, reason: 'websocket upgrade required' }
  }
  if (oneHeader(request.headers, 'sec-websocket-version') !== '13') {
    return { ok: false, status: 426, reason: 'websocket version 13 required' }
  }
  const hostRaw = oneHeader(request.headers, 'host')
  const requested = hostRaw === undefined ? undefined : parseAuthority(hostRaw)
  if (requested === undefined || !isTrustedHost(requested, trustedHosts)) {
    return { ok: false, status: 403, reason: 'host is not trusted' }
  }
  const originRaw = oneHeader(request.headers, 'origin')
  let origin: URL
  try {
    origin = new URL(originRaw ?? '')
  } catch {
    return { ok: false, status: 403, reason: 'origin is required' }
  }
  if (!['http:', 'https:'].includes(origin.protocol)
    || origin.username !== ''
    || origin.password !== ''
    || origin.host.toLowerCase() !== requested.host.toLowerCase()) {
    return { ok: false, status: 403, reason: 'origin does not match host' }
  }
  const fetchSite = oneHeader(request.headers, 'sec-fetch-site')?.toLowerCase()
  if (fetchSite !== undefined && fetchSite !== 'same-origin') {
    return { ok: false, status: 403, reason: 'cross-site websocket is forbidden' }
  }
  return ACCEPTED
}

export function assertTrustedHosts(trustedHosts: readonly string[]): void {
  if (trustedHosts.length === 0) throw new TypeError('at least one trusted host is required')
  for (const host of trustedHosts) {
    if (parseAuthority(host) === undefined) throw new TypeError(`invalid trusted host: ${host}`)
  }
}

export function rejectUpgrade(socket: Duplex, assessment: Extract<UpgradeAssessment, { readonly ok: false }>): void {
  const statusText = assessment.status === 403
    ? 'Forbidden'
    : assessment.status === 429 ? 'Too Many Requests'
    : assessment.status === 426 ? 'Upgrade Required' : 'Bad Request'
  socket.end(
    `HTTP/1.1 ${assessment.status} ${statusText}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + 'Content-Length: 0\r\n\r\n',
  )
}
