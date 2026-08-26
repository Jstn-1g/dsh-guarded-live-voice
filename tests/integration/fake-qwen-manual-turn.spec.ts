import { createServer, type IncomingMessage } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import {
  MAX_QWEN_INPUT_CHUNK_BYTES,
  openQwenManualTurn,
} from '../../src/host/qwen-manual-turn.js'
import type { ManualTurnProviderEvent } from '../../src/host/provider.js'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

const sessionEvent = (
  type: 'session.created' | 'session.updated',
): string => JSON.stringify({
  type,
  session: {
    id: 'sess-1',
    model: 'qwen-audio-3.0-realtime-plus',
    object: 'realtime.session',
    ...(type === 'session.updated'
      ? {
          modalities: ['text', 'audio'],
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          turn_detection: null,
        }
      : {}),
  },
})

const responseCreated = (id = 'resp-1'): string => JSON.stringify({
  type: 'response.created',
  response: {
    id,
    object: 'realtime.response',
    status: 'in_progress',
    modalities: ['text', 'audio'],
    output: [],
  },
})

const completedResponse = (
  transcript = 'hi there',
  itemId = 'assistant-1',
): Record<string, unknown> => ({
  id: 'resp-1',
  object: 'realtime.response',
  status: 'completed',
  modalities: ['text', 'audio'],
  output: [{
    id: itemId,
    object: 'realtime.item',
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'audio', transcript }],
  }],
})

async function startFakeQwen(
  onConnection: (socket: WebSocket, request: IncomingMessage) => void,
): Promise<number> {
  const http = createServer()
  const server = new WebSocketServer({ noServer: true })
  http.on('upgrade', (request, socket, head) => {
    server.handleUpgrade(request, socket, head, ws => server.emit('connection', ws, request))
  })
  server.on('connection', onConnection)
  await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
  closers.push(async () => {
    for (const client of server.clients) client.terminate()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await new Promise<void>(resolve => http.close(() => resolve()))
  })
  return (http.address() as AddressInfo).port
}

function fakeDial(port: number) {
  return (_endpoint: URL, options: { authorization: string; maxPayload: number }): WebSocket => new WebSocket(
    `ws://127.0.0.1:${port}`,
    {
      headers: { Authorization: options.authorization },
      maxPayload: options.maxPayload,
      perMessageDeflate: false,
    },
  )
}

describe('one bounded Qwen manual turn', () => {
  it('streams only PCM input and bounded transcript/audio output through a single turn', async () => {
    const received: Array<Record<string, unknown>> = []
    let authorization: string | undefined
    const port = await startFakeQwen((socket, request) => {
      authorization = request.headers.authorization
      socket.send(sessionEvent('session.created'))
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>
        received.push(event)
        if (event.type === 'session.update') socket.send(sessionEvent('session.updated'))
        if (event.type === 'response.create') {
          socket.send(JSON.stringify({
            type: 'input_audio_buffer.committed',
            item_id: 'item-1',
            previous_item_id: 'item-0',
          }))
          socket.send(JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'item-1',
            content_index: 0,
            text: '',
            stash: 'hel',
          }))
          socket.send(JSON.stringify({
            type: 'conversation.item.input_audio_transcription.delta',
            item_id: 'item-1',
            content_index: 0,
            text: 'hello ',
            stash: 'wor',
          }))
          socket.send(JSON.stringify({
            type: 'conversation.item.input_audio_transcription.completed',
            item_id: 'item-1',
            content_index: 0,
            transcript: 'hello world',
          }))
          socket.send(responseCreated())
          socket.send(JSON.stringify({
            type: 'response.audio_transcript.delta',
            response_id: 'resp-1',
            item_id: 'assistant-1',
            output_index: 0,
            content_index: 0,
            delta: 'hi ',
          }))
          socket.send(JSON.stringify({
            type: 'response.audio.delta',
            response_id: 'resp-1',
            item_id: 'assistant-1',
            output_index: 0,
            content_index: 0,
            delta: Buffer.from([1, 0, 2, 0]).toString('base64'),
          }))
          socket.send(JSON.stringify({
            type: 'response.audio_transcript.done',
            response_id: 'resp-1',
            item_id: 'assistant-1',
            output_index: 0,
            content_index: 0,
            transcript: 'hi there',
          }))
          socket.send(JSON.stringify({
            type: 'response.audio.done',
            response_id: 'resp-1',
            item_id: 'assistant-1',
            output_index: 0,
            content_index: 0,
          }))
          socket.send(JSON.stringify({
            type: 'response.done',
            response: completedResponse(),
          }))
        }
      })
    })

    const session = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
    }, { createSocket: fakeDial(port) })
    const events: ManualTurnProviderEvent[] = []
    const unsubscribe = session.subscribe(event => { events.push(event) })
    session.appendPcm16(new Uint8Array([1, 0, 2, 0]))
    session.commit()

    await expect.poll(() => events.at(-1)).toEqual({ type: 'done', status: 'completed' })
    expect(authorization).toBe('Bearer test-secret')
    expect(received).toEqual([
      {
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          input_audio_format: 'pcm',
          output_audio_format: 'pcm',
          turn_detection: null,
        },
      },
      { type: 'input_audio_buffer.append', audio: 'AQACAA==' },
      { type: 'input_audio_buffer.commit' },
      { type: 'response.create', response: { modalities: ['text', 'audio'] } },
    ])
    expect(events).toEqual([
      { type: 'transcript', role: 'user', text: 'hel', final: false },
      { type: 'transcript', role: 'user', text: 'hello wor', final: false },
      { type: 'transcript', role: 'user', text: 'hello world', final: true },
      { type: 'transcript', role: 'assistant', text: 'hi ', final: false },
      { type: 'audio', pcm24: new Uint8Array([1, 0, 2, 0]) },
      { type: 'transcript', role: 'assistant', text: 'hi there', final: true },
      { type: 'done', status: 'completed' },
    ])
    expect(() => session.appendPcm16(new Uint8Array([3, 0]))).toThrow(/not accepting/u)
    expect(() => session.commit()).toThrow(/no audio/u)
    expect(await session.closed).toBe('local')
    unsubscribe()
    session.close()
  })

  it('bounds opening lifetime and tears down on caller abort or provider close', async () => {
    const preAborted = new AbortController()
    preAborted.abort()
    const resolveCredential = vi.fn(async () => 'test-secret')
    await expect(openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential,
      signal: preAborted.signal,
    })).rejects.toThrow(/cancelled/u)
    expect(resolveCredential).not.toHaveBeenCalled()

    await expect(openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: () => new Promise(() => {}),
      signal: new AbortController().signal,
      readyTimeoutMs: 5,
    })).rejects.toThrow(/timed out/u)

    const port = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.once('message', () => { socket.send(sessionEvent('session.updated')) })
    })
    const abort = new AbortController()
    const aborted = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: abort.signal,
    }, { createSocket: fakeDial(port) })
    abort.abort()
    expect(await aborted.closed).toBe('transport-error')

    const closedPort = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.once('message', () => {
        socket.send(sessionEvent('session.updated'))
        setTimeout(() => { socket.close(1000) }, 10)
      })
    })
    const providerClosed = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
    }, { createSocket: fakeDial(closedPort) })
    expect(await providerClosed.closed).toBe('provider-closed')
  })

  it('bounds both the uncommitted-input and in-flight-response wall clocks', async () => {
    const inputPort = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.once('message', () => { socket.send(sessionEvent('session.updated')) })
    })
    const inputExpired = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
      inputTimeoutMs: 5,
    }, { createSocket: fakeDial(inputPort) })
    expect(await inputExpired.closed).toBe('transport-error')

    const responsePort = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.once('message', () => { socket.send(sessionEvent('session.updated')) })
    })
    const responseExpired = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
      responseTimeoutMs: 5,
    }, { createSocket: fakeDial(responsePort) })
    responseExpired.appendPcm16(new Uint8Array([1, 0]))
    responseExpired.commit()
    expect(await responseExpired.closed).toBe('transport-error')
  })

  it('fails closed on out-of-order, identity-changing, malformed, or tool-bearing output', async () => {
    const earlyCommitPort = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.once('message', () => {
        socket.send(sessionEvent('session.updated'))
        setTimeout(() => {
          socket.send(JSON.stringify({
            type: 'input_audio_buffer.committed',
            item_id: 'item-early',
          }))
        }, 0)
      })
    })
    const earlyCommit = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
    }, { createSocket: fakeDial(earlyCommitPort) })
    expect(await earlyCommit.closed).toBe('protocol-error')

    const run = async (sendEvents: (socket: WebSocket) => void): Promise<void> => {
      const port = await startFakeQwen((socket) => {
        socket.send(sessionEvent('session.created'))
        socket.on('message', (raw) => {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>
          if (event.type === 'session.update') socket.send(sessionEvent('session.updated'))
          if (event.type === 'response.create') sendEvents(socket)
        })
      })
      const session = await openQwenManualTurn({
        workspaceId: 'workspace-123',
        model: 'qwen-audio-3.0-realtime-plus',
        resolveCredential: async () => 'test-secret',
        signal: new AbortController().signal,
      }, { createSocket: fakeDial(port) })
      session.appendPcm16(new Uint8Array([1, 0]))
      session.commit()
      expect(await session.closed).toBe('protocol-error')
    }

    await run(socket => {
      socket.send(JSON.stringify({
        type: 'response.audio.delta',
        response_id: 'resp-1',
        item_id: 'assistant-1',
        output_index: 0,
        content_index: 0,
        delta: 'AQI=',
      }))
    })

    await run(socket => {
      socket.send(responseCreated())
      socket.send(JSON.stringify({
        type: 'response.audio_transcript.delta',
        response_id: 'resp-1',
        item_id: 'assistant-1',
        output_index: 0,
        content_index: 0,
        delta: 'answer',
      }))
      socket.send(JSON.stringify({
        type: 'response.audio.delta',
        response_id: 'resp-1',
        item_id: 'assistant-2',
        output_index: 0,
        content_index: 0,
        delta: 'AQI=',
      }))
    })

    await run(socket => {
      socket.send(JSON.stringify({
        type: 'input_audio_buffer.committed',
        item_id: 'item-1',
      }))
      socket.send(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.delta',
        item_id: 'item-1',
        content_index: 0,
        text: 'hello',
        stash: '',
      }))
      socket.send(JSON.stringify({
        type: 'conversation.item.input_audio_transcription.completed',
        item_id: 'item-1',
        content_index: 1,
        transcript: 'hello',
      }))
    })

    await run(socket => {
      socket.send(responseCreated())
      socket.send(JSON.stringify({
        type: 'response.audio.delta',
        response_id: 'resp-1',
        item_id: 'assistant-1',
        output_index: 0,
        content_index: 0,
        delta: 'not-base64',
      }))
    })

    await run(socket => {
      socket.send(responseCreated())
      socket.send(JSON.stringify({
        type: 'response.audio_transcript.delta',
        response_id: 'resp-1',
        item_id: 'assistant-1',
        output_index: 0,
        content_index: 0,
        delta: '😀'.repeat(2_100),
      }))
    })

    await run(socket => {
      socket.send(responseCreated())
      socket.send(JSON.stringify({
        type: 'response.audio_transcript.done',
        response_id: 'resp-1',
        item_id: 'assistant-1',
        output_index: 0,
        content_index: 0,
        transcript: 'answer',
      }))
      socket.send(JSON.stringify({
        type: 'response.audio.delta',
        response_id: 'resp-1',
        item_id: 'assistant-1',
        output_index: 0,
        content_index: 0,
        delta: 'AQI=',
      }))
      socket.send(JSON.stringify({
        type: 'response.audio.done',
        response_id: 'resp-1',
        item_id: 'assistant-1',
        output_index: 0,
        content_index: 0,
      }))
      socket.send(JSON.stringify({
        type: 'response.done',
        response: {
          id: 'resp-1',
          object: 'realtime.response',
          status: 'completed',
          modalities: ['text', 'audio'],
          output: [{
            id: 'assistant-1',
            object: 'realtime.item',
            type: 'function_call',
            status: 'completed',
            call_id: 'call-1',
            name: 'dangerous_tool',
            arguments: '{}',
          }],
        },
      }))
    })
  })

  it('accepts the documented reduced cancelled response but never marks it completed', async () => {
    const events: ManualTurnProviderEvent[] = []
    const port = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>
        if (event.type === 'session.update') socket.send(sessionEvent('session.updated'))
        if (event.type === 'response.create') {
          socket.send(responseCreated())
          socket.send(JSON.stringify({
            type: 'response.done',
            response: {
              id: 'resp-1',
              status: 'cancelled',
              status_details: { type: 'cancelled', reason: 'client_cancelled' },
            },
          }))
        }
      })
    })
    const session = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
    }, { createSocket: fakeDial(port) })
    session.subscribe(event => { events.push(event) })
    session.appendPcm16(new Uint8Array([1, 0]))
    session.commit()
    await expect.poll(() => events.at(-1)).toEqual({ type: 'done', status: 'cancelled' })
    expect(await session.closed).toBe('local')
  })

  it('rejects malformed input, a second phase, and unexpected provider capabilities', async () => {
    const port = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.once('message', () => { socket.send(sessionEvent('session.updated')) })
    })
    const session = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
    }, { createSocket: fakeDial(port) })

    expect(() => session.appendPcm16(new Uint8Array())).toThrow(/PCM16/u)
    expect(() => session.appendPcm16(new Uint8Array([1]))).toThrow(/PCM16/u)
    expect(() => session.appendPcm16(new Uint8Array(MAX_QWEN_INPUT_CHUNK_BYTES + 2))).toThrow(/PCM16/u)
    expect(() => session.commit()).toThrow(/no audio/u)
    session.close()
    expect(await session.closed).toBe('local')

    const hostilePort = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.once('message', () => {
        socket.send(sessionEvent('session.updated'))
        setTimeout(() => {
          socket.send(JSON.stringify({
            type: 'response.function_call_arguments.delta',
            response_id: 'resp-1',
            delta: '{"command":"whoami"}',
          }))
        }, 10)
      })
    })
    const hostile = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
    }, { createSocket: fakeDial(hostilePort) })
    expect(await hostile.closed).toBe('protocol-error')

    const prematurePort = await startFakeQwen((socket) => {
      socket.send(sessionEvent('session.created'))
      socket.on('message', (raw) => {
        const event = JSON.parse(raw.toString()) as Record<string, unknown>
        if (event.type === 'session.update') socket.send(sessionEvent('session.updated'))
        if (event.type === 'response.create') {
          socket.send(responseCreated())
          socket.send(JSON.stringify({
            type: 'response.done',
            response: completedResponse(),
          }))
        }
      })
    })
    const premature = await openQwenManualTurn({
      workspaceId: 'workspace-123',
      model: 'qwen-audio-3.0-realtime-plus',
      resolveCredential: async () => 'test-secret',
      signal: new AbortController().signal,
    }, { createSocket: fakeDial(prematurePort) })
    premature.appendPcm16(new Uint8Array([1, 0]))
    premature.commit()
    expect(await premature.closed).toBe('protocol-error')
  })
})
