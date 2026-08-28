import { describe, expect, it } from 'vitest'
import {
  MAX_CONTROL_BYTES,
  WIRE_VERSION,
  encodeServerControl,
  isValidWireId,
  parseClientControl,
  parseServerControl,
} from '../../src/shared/wire.js'

describe('wire controls', () => {
  it('shares one exact identifier rule between Host producers and browser consumers', () => {
    expect(isValidWireId('session-1')).toBe(true)
    for (const value of ['', ' session', 'session ', 'session\nline', 's'.repeat(257)]) {
      expect(isValidWireId(value)).toBe(false)
    }
  })

  it('accepts only the four exact version-one client controls', () => {
    expect(parseClientControl('{"v":1,"type":"bind","sessionId":"session-1"}')).toEqual({
      v: WIRE_VERSION,
      type: 'bind',
      sessionId: 'session-1',
    })
    expect(parseClientControl('{"v":1,"type":"consent.accept","challenge":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}'))
      .toEqual({ v: 1, type: 'consent.accept', challenge: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' })
    expect(parseClientControl('{"v":1,"type":"stop"}')).toEqual({ v: 1, type: 'stop' })
    expect(parseClientControl('{"v":1,"type":"turn.commit"}')).toEqual({ v: 1, type: 'turn.commit' })
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
    '{"v":1,"type":"turn.commit","extra":true}',
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

  it('parses the exact disclosure and ready bindings returned by the Host', () => {
    const consent = {
      v: 1,
      type: 'consent.required',
      challenge: 'a'.repeat(43),
      expiresAt: 1_900_000_000_000,
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      provider: 'qwen',
      disclosure: {
        audioDestination: 'Alibaba Cloud Qwen realtime API',
        exportedContext: 'none',
        executionAuthority: 'none',
        providerRetention: 'not specified for Qwen realtime audio',
        currentMilestone: 'one bounded manual audio turn after acceptance',
      },
    }
    expect(parseServerControl(JSON.stringify(consent))).toEqual(consent)
    expect(parseServerControl(JSON.stringify({
      v: 1,
      type: 'ready',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      provider: 'qwen',
      model: 'qwen-audio-3.0-realtime-plus',
      authority: 'proposal-only',
    }))).toMatchObject({ type: 'ready', sessionId: 'session-1', workspaceId: 'workspace-1' })
    expect(parseServerControl('{"v":1,"type":"stopped"}')).toEqual({ v: 1, type: 'stopped' })
    expect(parseServerControl('{"v":1,"type":"error","code":"closed","message":"safe message"}'))
      .toEqual({ v: 1, type: 'error', code: 'closed', message: 'safe message' })
    expect(parseServerControl('{"v":1,"type":"transcript","role":"assistant","text":"line one\\nline two","final":true}'))
      .toEqual({ v: 1, type: 'transcript', role: 'assistant', text: 'line one\nline two', final: true })
    expect(parseServerControl('{"v":1,"type":"turn.done","status":"completed"}'))
      .toEqual({ v: 1, type: 'turn.done', status: 'completed' })
  })

  it.each([
    'not-json',
    '[]',
    '{"v":2,"type":"stopped"}',
    '{"v":1,"type":"stopped","extra":true}',
    '{"v":1,"type":"error","code":" bad","message":"message"}',
    '{"v":1,"type":"error","code":"bad","message":"line\\nbreak"}',
    '{"v":1,"type":"ready","sessionId":"s","workspaceId":"w","provider":"qwen","model":" bad","authority":"proposal-only"}',
    '{"v":1,"type":"ready","sessionId":"s","workspaceId":"w","provider":"other","model":"qwen-audio-3.0-realtime-plus","authority":"proposal-only"}',
    '{"v":1,"type":"consent.required","challenge":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","expiresAt":0,"sessionId":"s","workspaceId":"w","provider":"qwen","disclosure":{}}',
    '{"v":1,"type":"transcript","role":"tool","text":"x","final":true}',
    '{"v":1,"type":"transcript","role":"assistant","text":"nul\\u0000","final":true}',
    '{"v":1,"type":"turn.done","status":"failed"}',
  ])('rejects malformed server event %s', (raw) => {
    expect(() => parseServerControl(raw)).toThrow(/server|event|frame/u)
  })

  it('applies the same UTF-8 byte ceiling to server events', () => {
    const message = '😀'.repeat(MAX_CONTROL_BYTES)
    expect(() => parseServerControl(JSON.stringify({ v: 1, type: 'error', code: 'x', message })))
      .toThrow(/byte limit/u)
  })
})
