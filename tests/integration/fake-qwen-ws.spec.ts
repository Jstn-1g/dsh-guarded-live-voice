import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket, WebSocketServer } from 'ws'
import { QwenHandshake } from '../../src/host/qwen.js'

const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

describe('deterministic fake Qwen WebSocket', () => {
  it('does not send session.update before session.created', async () => {
    const http = createServer()
    const server = new WebSocketServer({ noServer: true })
    http.on('upgrade', (request, socket, head) => {
      server.handleUpgrade(request, socket, head, ws => server.emit('connection', ws, request))
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    closers.push(async () => {
      for (const client of server.clients) client.terminate()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await new Promise<void>(resolve => http.close(() => resolve()))
    })

    const received: unknown[] = []
    const serverDone = new Promise<void>((resolve) => {
      server.once('connection', ws => {
        setTimeout(() => { ws.send('{"type":"session.created"}') }, 10)
        ws.once('message', raw => {
          received.push(JSON.parse(raw.toString()))
          ws.send('{"type":"session.updated"}')
          resolve()
        })
      })
    })

    const port = (http.address() as AddressInfo).port
    const client = new WebSocket(`ws://127.0.0.1:${port}`)
    const handshake = new QwenHandshake({ session: { test: true } })
    const ready = new Promise<void>((resolve, reject) => {
      client.on('message', raw => {
        try {
          const action = handshake.receive(raw.toString())
          if (action.kind === 'send') client.send(JSON.stringify(action.payload))
          else resolve()
        } catch (error) {
          reject(error)
        }
      })
      client.once('error', reject)
    })

    await new Promise<void>((resolve, reject) => {
      client.once('open', resolve)
      client.once('error', reject)
    })
    expect(received).toEqual([])
    await Promise.all([serverDone, ready])
    expect(received).toEqual([{ type: 'session.update', session: { test: true } }])
    expect(() => handshake.assertReady()).not.toThrow()
    client.close()
  })
})
