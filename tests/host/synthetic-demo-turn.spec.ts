import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT,
  SYNTHETIC_DEMO_MODEL,
  SYNTHETIC_DEMO_PROVIDER,
  SYNTHETIC_DEMO_USER_TRANSCRIPT,
  openSyntheticDemoTurn,
} from '../../src/host/synthetic-demo-turn.js'
import type { ManualTurnProviderEvent } from '../../src/host/provider.js'
import {
  MAX_INPUT_PCM16_CHUNK_BYTES,
  MAX_INPUT_PCM16_TURN_BYTES,
  MAX_OUTPUT_PCM16_CHUNK_BYTES,
} from '../../src/shared/audio.js'

function transcript(event: ManualTurnProviderEvent | undefined) {
  if (event?.type !== 'transcript') throw new Error('expected a transcript event')
  return event
}

function audio(event: ManualTurnProviderEvent | undefined) {
  if (event?.type !== 'audio') throw new Error('expected an audio event')
  return event.pcm24
}

describe('in-process synthetic demo turn', () => {
  it('emits fixed transcripts, one deterministic bounded chime, then completed', async () => {
    const controller = new AbortController()
    const session = await openSyntheticDemoTurn({ signal: controller.signal })
    const events: ManualTurnProviderEvent[] = []
    session.subscribe(event => { events.push(event) })

    const owned = new Uint8Array([1, 0, 2, 0])
    session.appendPcm16(owned)
    owned.fill(255)
    session.commit()
    expect(events).toEqual([])
    await Promise.resolve()

    expect(session.authorization).toEqual({
      provider: SYNTHETIC_DEMO_PROVIDER,
      model: SYNTHETIC_DEMO_MODEL,
    })
    expect(events.map(event => event.type)).toEqual(['transcript', 'transcript', 'audio', 'done'])
    expect(transcript(events[0])).toEqual({
      type: 'transcript', role: 'user', text: SYNTHETIC_DEMO_USER_TRANSCRIPT, final: true,
    })
    expect(transcript(events[1])).toEqual({
      type: 'transcript', role: 'assistant', text: SYNTHETIC_DEMO_ASSISTANT_TRANSCRIPT, final: true,
    })
    const pcm24 = audio(events[2])
    expect(pcm24.byteLength).toBeGreaterThan(0)
    expect(pcm24.byteLength).toBeLessThanOrEqual(MAX_OUTPUT_PCM16_CHUNK_BYTES)
    expect(pcm24.byteLength % 2).toBe(0)
    expect([...pcm24].some(value => value !== 0)).toBe(true)
    expect(createHash('sha256').update(pcm24).digest('hex'))
      .toBe('ef3d9ae9e285aaef41443f087dbf1a046ed32d50470394f1e492c86815811e57')
    expect(events[3]).toEqual({ type: 'done', status: 'completed' })

    session.close()
    await expect(session.closed).resolves.toBe('local')
  })

  it('validates each PCM16 chunk and the cumulative turn boundary without retaining input', async () => {
    const session = await openSyntheticDemoTurn({ signal: new AbortController().signal })
    expect(() => { session.appendPcm16(new Uint8Array()) }).toThrow(/chunk is invalid/u)
    expect(() => { session.appendPcm16(new Uint8Array([1])) }).toThrow(/chunk is invalid/u)
    expect(() => { session.appendPcm16(new Uint8Array(MAX_INPUT_PCM16_CHUNK_BYTES + 2)) })
      .toThrow(/chunk is invalid/u)

    const full = new Uint8Array(MAX_INPUT_PCM16_CHUNK_BYTES)
    const wholeChunks = Math.floor(MAX_INPUT_PCM16_TURN_BYTES / full.byteLength)
    for (let index = 0; index < wholeChunks; index += 1) session.appendPcm16(full)
    const remainder = MAX_INPUT_PCM16_TURN_BYTES - wholeChunks * full.byteLength
    if (remainder > 0) session.appendPcm16(new Uint8Array(remainder))
    full.fill(255)
    expect(() => { session.appendPcm16(new Uint8Array([0, 0])) }).toThrow(/turn limit/u)
    expect(() => { session.commit() }).not.toThrow()
    session.close()
    await expect(session.closed).resolves.toBe('local')
  })

  it('requires nonzero input and permits only one commit', async () => {
    const session = await openSyntheticDemoTurn({ signal: new AbortController().signal })
    expect(() => { session.commit() }).toThrow(/no audio/u)
    session.appendPcm16(new Uint8Array([1, 0]))
    session.commit()
    expect(() => { session.commit() }).toThrow(/only once/u)
    expect(() => { session.appendPcm16(new Uint8Array([2, 0])) }).toThrow(/not accepting audio/u)
    session.close()
    await expect(session.closed).resolves.toBe('local')
  })

  it('close is idempotent, resolves locally, and fences queued and later emissions', async () => {
    const deferred: Array<() => void> = []
    const session = await openSyntheticDemoTurn({
      signal: new AbortController().signal,
      defer: callback => { deferred.push(callback) },
    })
    const listener = vi.fn()
    session.subscribe(listener)
    session.appendPcm16(new Uint8Array([1, 0]))
    session.commit()
    session.close()
    session.close()
    deferred[0]?.()

    await expect(session.closed).resolves.toBe('local')
    expect(listener).not.toHaveBeenCalled()
    const late = vi.fn()
    session.subscribe(late)
    expect(late).not.toHaveBeenCalled()
    expect(() => { session.appendPcm16(new Uint8Array([2, 0])) }).toThrow(/not accepting audio/u)
  })

  it('abort resolves locally, fences queued output, and rejects an already-aborted open', async () => {
    const deferred: Array<() => void> = []
    const controller = new AbortController()
    const session = await openSyntheticDemoTurn({
      signal: controller.signal,
      defer: callback => { deferred.push(callback) },
    })
    const listener = vi.fn()
    session.subscribe(listener)
    session.appendPcm16(new Uint8Array([1, 0]))
    session.commit()
    controller.abort()
    deferred[0]?.()

    await expect(session.closed).resolves.toBe('local')
    expect(listener).not.toHaveBeenCalled()

    const alreadyAborted = new AbortController()
    alreadyAborted.abort()
    await expect(openSyntheticDemoTurn({ signal: alreadyAborted.signal })).rejects.toThrow(/cancelled/u)
  })

  it('unsubscribe fences that listener without affecting the remaining turn', async () => {
    const session = await openSyntheticDemoTurn({ signal: new AbortController().signal })
    const removed = vi.fn()
    const retained = vi.fn()
    const unsubscribe = session.subscribe(removed)
    session.subscribe(retained)
    unsubscribe()
    session.appendPcm16(new Uint8Array([1, 0]))
    session.commit()
    await Promise.resolve()
    expect(removed).not.toHaveBeenCalled()
    expect(retained).toHaveBeenCalledTimes(4)
    session.close()
    await expect(session.closed).resolves.toBe('local')
  })
})
