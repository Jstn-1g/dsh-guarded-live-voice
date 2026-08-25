import type { IncomingHttpHeaders } from 'node:http'
import { describe, expect, it } from 'vitest'
import { assessUpgradeRequest, assertTrustedHosts } from '../../src/host/carrier.js'

const baseHeaders = (): IncomingHttpHeaders => ({
  host: '127.0.0.1:31415',
  origin: 'http://127.0.0.1:31415',
  upgrade: 'websocket',
  connection: 'keep-alive, Upgrade',
  'sec-websocket-version': '13',
  'sec-fetch-site': 'same-origin',
})

const assess = (headers: IncomingHttpHeaders, trusted = ['127.0.0.1']) =>
  assessUpgradeRequest({ method: 'GET', headers, remoteAddress: '127.0.0.1' }, trusted)

describe('WebSocket carrier trust fence', () => {
  it('accepts an exact same-origin request on an allowlisted host', () => {
    expect(assess(baseHeaders()).ok).toBe(true)
  })

  it.each([
    ['untrusted host', { host: 'attacker.example', origin: 'http://attacker.example' }],
    ['origin swap', { origin: 'http://localhost:31415' }],
    ['cross site', { 'sec-fetch-site': 'cross-site' }],
    ['missing origin', { origin: undefined }],
    ['wrong version', { 'sec-websocket-version': '12' }],
    ['missing upgrade', { upgrade: undefined }],
  ])('rejects %s', (_label, changed) => {
    const headers = { ...baseHeaders(), ...changed }
    expect(assess(headers).ok).toBe(false)
  })

  it('requires GET and accepts a trusted authority that pins its port', () => {
    expect(assessUpgradeRequest({
      method: 'POST',
      headers: baseHeaders(),
      remoteAddress: '127.0.0.1',
    }, ['127.0.0.1'])).toMatchObject({ ok: false, status: 400 })
    expect(assess(baseHeaders(), ['127.0.0.1:31415']).ok).toBe(true)
    expect(assess(baseHeaders(), ['127.0.0.1:9999']).ok).toBe(false)
  })

  it('rejects a remote raw client even when it spoofs matching Host and Origin', () => {
    expect(assessUpgradeRequest({
      method: 'GET',
      headers: baseHeaders(),
      remoteAddress: '203.0.113.44',
    }, ['127.0.0.1'])).toMatchObject({ ok: false, status: 403, reason: 'guarded voice is loopback-only' })
    expect(assessUpgradeRequest({
      method: 'GET',
      headers: baseHeaders(),
      remoteAddress: undefined,
    }, ['127.0.0.1'])).toMatchObject({ ok: false, status: 403 })
  })

  it('validates the configured trusted host boundary', () => {
    expect(() => assertTrustedHosts([])).toThrow(/at least one/u)
    expect(() => assertTrustedHosts(['good.example/path'])).toThrow(/invalid trusted host/u)
    expect(() => assertTrustedHosts(['good.example?admin=true'])).toThrow(/invalid trusted host/u)
    expect(() => assertTrustedHosts(['localhost', '[::1]'])).not.toThrow()
  })
})
