import { describe, expect, it } from 'vitest'
import {
  MAX_CONTROL_BYTES,
  WIRE_VERSION,
  encodeServerControl,
  parseClientControl,
} from '../../src/shared/wire.js'

describe('wire controls', () => {
  it('accepts only the three exact version-one client controls', () => {
    expect(parseClientControl('{"v":1,"type":"bind","sessionId":"session-1"}')).toEqual({
      v: WIRE_VERSION,
      type: 'bind',
      sessionId: 'session-1',
    })
    expect(parseClientControl('{"v":1,"type":"consent.accept","challenge":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'))
      .toEqual({ v: 1, type: 'consent.accept', challenge: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(parseClientControl('{"v":1,"type":"stop"}')).toEqual({ v: 1, type: 'stop' })
  })

  it.each([
    'not-json',
    '[]',
    '{"v":2,"type":"stop"}',
    '{"v":1,"type":"bind","sessionId":""}',
    '{"v":1,"type":"bind","sessionId":" session"}',
    '{"v":1,"type":"bind","sessionId":"session","extra":true}',
    '{"v":1,"type":"consent.accept","challenge":"short"}',
    '{"v":1,"type":"stop","extra":true}',
    '{"v":1,"type":"audio"}',
  ])('rejects invalid control %s', (raw) => {
    expect(() => parseClientControl(raw)).toThrow(/control|frame|bind|consent|stop/u)
  })

  it('applies the limit to UTF-8 bytes, not UTF-16 code units', () => {
    const padding = '😀'.repeat(Math.floor(MAX_CONTROL_BYTES / 2))
    expect(() => parseClientControl(JSON.stringify({ v: 1, type: 'bind', sessionId: padding })))
      .toThrow(/byte limit/u)
  })

  it('serializes only the supplied safe server event', () => {
    expect(encodeServerControl({ v: 1, type: 'stopped' })).toBe('{"v":1,"type":"stopped"}')
  })
})
