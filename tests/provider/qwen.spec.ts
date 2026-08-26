import { describe, expect, it } from 'vitest'
import {
  QwenHandshake,
  buildQwenRealtimeEndpoint,
  isQwenRealtimeModel,
} from '../../src/host/qwen.js'

describe('Qwen contract boundary', () => {
  const created = JSON.stringify({
    type: 'session.created',
    session: {
      id: 'sess-1',
      model: 'qwen-audio-3.0-realtime-plus',
      object: 'realtime.session',
    },
  })
  const updated = JSON.stringify({
    type: 'session.updated',
    session: {
      id: 'sess-1',
      modalities: ['text'],
      model: 'qwen-audio-3.0-realtime-plus',
      object: 'realtime.session',
      turn_detection: null,
    },
  })

  it('constructs only the fixed Beijing endpoint and allowlisted models', () => {
    const endpoint = buildQwenRealtimeEndpoint('workspace-123', 'qwen-audio-3.0-realtime-plus')
    expect(endpoint.origin).toBe('wss://workspace-123.cn-beijing.maas.aliyuncs.com')
    expect(endpoint.pathname).toBe('/api-ws/v1/realtime')
    expect(endpoint.searchParams.get('model')).toBe('qwen-audio-3.0-realtime-plus')
    expect(isQwenRealtimeModel('qwen-audio-3.0-realtime-flash')).toBe(true)
    expect(isQwenRealtimeModel('attacker-model')).toBe(false)
    expect(() => buildQwenRealtimeEndpoint('bad.workspace', 'qwen-audio-3.0-realtime-plus')).toThrow(/workspace id/u)
  })

  it('enforces created -> update -> updated ordering', () => {
    const update: Record<string, unknown> = { session: { mode: 'test' } }
    const handshake = new QwenHandshake(update)
    update.type = 'response.cancel'
    update.session = { mode: 'mutated' }
    expect(handshake.receive(created)).toEqual({
      kind: 'send',
      payload: { type: 'session.update', session: { mode: 'test' } },
    })
    expect(handshake.receive(updated)).toEqual({ kind: 'ready' })
    expect(() => handshake.assertReady()).not.toThrow()
  })

  it('fails closed on out-of-order, malformed, oversized, error, and closed events', () => {
    expect(() => new QwenHandshake({ type: 'override' })).toThrow(/must not override/u)
    expect(() => new QwenHandshake({}).receive('{"type":"session.updated"}')).toThrow(/out of order/u)
    expect(() => new QwenHandshake({}).receive('not-json')).toThrow(/valid JSON/u)
    expect(() => new QwenHandshake({}).receive(JSON.stringify({ type: 'x', pad: '😀'.repeat(40_000) }))).toThrow(/byte limit/u)
    expect(() => new QwenHandshake({}).receive('{"type":"error","message":"secret provider detail"}'))
      .toThrow('Qwen rejected the realtime session')
    const closed = new QwenHandshake({})
    closed.close()
    expect(() => closed.receive(created)).toThrow(/closed/u)
  })

  it('binds the updated session to the created id and requested model', () => {
    const wrongModel = new QwenHandshake({}, 'qwen-audio-3.0-realtime-flash')
    expect(() => wrongModel.receive(created)).toThrow(/does not match/u)

    const changedId = new QwenHandshake({}, 'qwen-audio-3.0-realtime-plus')
    changedId.receive(created)
    expect(() => changedId.receive(JSON.stringify({
      type: 'session.updated',
      session: {
        id: 'sess-2',
        model: 'qwen-audio-3.0-realtime-plus',
        object: 'realtime.session',
      },
    }))).toThrow(/identity changed/u)

    expect(() => new QwenHandshake({}).receive(JSON.stringify({
      type: 'session.created',
      session: { id: '', model: 'unknown', object: 'other' },
    }))).toThrow(/object type/u)
  })

  it('requires the provider to confirm the requested text-only manual-turn configuration', () => {
    const handshake = new QwenHandshake(
      { session: { modalities: ['text'], turn_detection: null } },
      'qwen-audio-3.0-realtime-plus',
      { modalities: ['text'], turnDetection: null },
    )
    handshake.receive(created)
    expect(() => handshake.receive(JSON.stringify({
      type: 'session.updated',
      session: {
        id: 'sess-1',
        modalities: ['text', 'audio'],
        model: 'qwen-audio-3.0-realtime-plus',
        object: 'realtime.session',
        turn_detection: { type: 'server_vad' },
      },
    }))).toThrow(/configuration does not match/u)
  })
})
