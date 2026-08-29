import { Context } from '@deepseek-ai/cordis'
import * as cordis from '@deepseek-ai/cordis'
import type { SlotRegistry as OfficialSlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import * as slotCore from '@deepseek-ai/dsh-client-ui-slots'
import { readFileSync } from 'node:fs'
import { createElement, type ComponentType, useSyncExternalStore } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as client from '../../src/client/index.js'
import type { VoiceClientSnapshot } from '../../src/client/controller.js'
import type { VoiceInjected } from '../../src/client/contract.js'
import { CLIENT_BOOT_GLOBAL } from '../../src/shared/boot.js'

interface RuntimeSlotEntry {
  readonly component: unknown
  readonly inject?: unknown
}

interface RuntimeSlotRegistry {
  register(options: object, component: unknown): () => void
  entries(name: string): readonly RuntimeSlotEntry[]
}

interface ClientHandoff {
  readonly factory: (require: (specifier: string) => unknown) => Record<string, unknown>
}

function officialSlotRegistry(): typeof OfficialSlotRegistry {
  let handoff: ClientHandoff | undefined
  const code = readFileSync(new URL(
    '../../node_modules/@deepseek-ai/dsh-client-runtime/lib/client.js',
    import.meta.url,
  ), 'utf8')
  const loaderWindow = {
    __ModuleLoader__: {
      load(value: ClientHandoff) { handoff = value },
    },
  }
  new Function('window', code)(loaderWindow)
  if (handoff === undefined) throw new Error('official client runtime did not register its factory')
  const exports = handoff.factory(specifier => {
    if (specifier === '@deepseek-ai/cordis') return cordis
    if (specifier === '@deepseek-ai/dsh-client-ui-slots') return slotCore
    throw new Error(`unexpected official runtime dependency: ${specifier}`)
  })
  return exports.SlotRegistry as typeof OfficialSlotRegistry
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>)[CLIENT_BOOT_GLOBAL]
  vi.unstubAllGlobals()
})

function fixture() {
  const cleanups: Array<() => void> = []
  const declarations: Array<{ readonly name: string; readonly declare: () => unknown }> = []
  const registrations: Array<{ readonly config: Record<string, unknown>; readonly component: unknown }> = []
  const localeCleanup = vi.fn()
  const ctx = {
    effect(factory: () => unknown) {
      const cleanup = factory()
      if (typeof cleanup === 'function') cleanups.push(cleanup as () => void)
    },
    locale: {
      register: vi.fn(() => localeCleanup),
    },
    slots: {
      inject: vi.fn((name: string, declare: () => unknown) => {
        declarations.push({ name, declare })
      }),
      register: vi.fn((config: Record<string, unknown>, component: unknown) => {
        registrations.push({ config, component })
        return vi.fn()
      }),
    },
  }
  return { ctx, cleanups, declarations, registrations, localeCleanup }
}

function browserWindow(): EventTarget & { readonly location: { readonly href: string, readonly protocol: string } } {
  return Object.assign(new EventTarget(), {
    location: { href: 'http://localhost:2026/', protocol: 'http:' },
  })
}

describe('lazy browser plugin', () => {
  it('exports only the function-plugin face and declares its exact services', () => {
    expect(Object.keys(client).sort()).toEqual(['apply', 'inject'])
    expect(client.inject).toEqual(['slots', 'locale'])
  })

  it('registers delayed exact-session slots without opening a socket at module activation', () => {
    const constructSocket = vi.fn(() => { throw new Error('must remain lazy') })
    const constructAudioContext = vi.fn(() => { throw new Error('must remain gesture-lazy') })
    const getUserMedia = vi.fn(() => Promise.reject(new Error('must remain gesture-lazy')))
    vi.stubGlobal('window', browserWindow())
    vi.stubGlobal('WebSocket', constructSocket)
    vi.stubGlobal('AudioContext', constructAudioContext)
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } })
    ;(globalThis as Record<string, unknown>)[CLIENT_BOOT_GLOBAL] = { v: 1, route: '/guarded-voice' }
    const f = fixture()

    client.apply(f.ctx as never)
    expect(constructSocket).not.toHaveBeenCalled()
    expect(constructAudioContext).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()
    expect(f.ctx.locale.register).toHaveBeenCalledTimes(1)
    expect(f.declarations.map(entry => entry.name)).toEqual([
      'conversation.input.left',
      'conversation.input.dock',
    ])
    expect(f.registrations).toEqual([])

    for (const declaration of f.declarations) declaration.declare()
    expect(f.registrations).toHaveLength(2)
    expect(f.registrations.map(entry => entry.config)).toEqual([
      expect.objectContaining({
        name: 'conversation.input.left',
        id: 'guarded-live-voice',
        order: 30,
        locale: 'guardedVoice',
      }),
      expect.objectContaining({
        name: 'conversation.input.dock',
        id: 'guarded-live-voice-disclosure',
        order: 30,
        locale: 'guardedVoice',
      }),
    ])
    const firstInject = f.registrations[0]?.config.inject as ((sessionId: string) => Record<string, unknown>) | undefined
    const secondInject = f.registrations[1]?.config.inject as ((sessionId: string) => Record<string, unknown>) | undefined
    const first = firstInject?.('session-1') as VoiceInjected | undefined
    const second = secondInject?.('session-1') as VoiceInjected | undefined
    expect(first?.hooks.voice).toBe(second?.hooks.voice)
    expect(first?.mountVoiceSession).toBe(second?.mountVoiceSession)
    expect(constructAudioContext).not.toHaveBeenCalled()
    expect(getUserMedia).not.toHaveBeenCalled()

    for (const cleanup of f.cleanups.reverse()) cleanup()
    expect(f.localeCleanup).toHaveBeenCalledTimes(1)
  })

  it('composes through the official SlotRegistry and a real React render, then unloads cleanly', async () => {
    const constructSocket = vi.fn(() => { throw new Error('render must remain transport-lazy') })
    vi.stubGlobal('window', browserWindow())
    vi.stubGlobal('WebSocket', constructSocket)
    ;(globalThis as Record<string, unknown>)[CLIENT_BOOT_GLOBAL] = { v: 1, route: '/guarded-voice' }

    const ctx = new Context()
    const SlotRegistry = officialSlotRegistry()
    await ctx.plugin(SlotRegistry).await()
    const slots = (ctx as unknown as { readonly slots: RuntimeSlotRegistry }).slots
    const dictionaries = new Map<string, Record<string, Record<string, string>>>()
    const locale = {
      register(namespace: string, value: Record<string, Record<string, string>>) {
        dictionaries.set(namespace, value)
        return () => { dictionaries.delete(namespace) }
      },
      bind(namespace: string) {
        return (key: string) => dictionaries.get(namespace)?.en?.[key] ?? key
      },
    }
    ctx.provide('locale', locale)
    const fiber = ctx.plugin({ name: 'dsh-live-voice-test', inject: [...client.inject], apply: client.apply })
    await fiber.await()
    expect(slots.entries('conversation.input.left')).toHaveLength(0)
    expect(slots.entries('conversation.input.dock')).toHaveLength(0)

    const disposeDeclaration = slots.register({
      name: 'root',
      children: {
        'conversation.input.left': { kind: 'list', scope: 'session' },
        'conversation.input.dock': { kind: 'list', scope: 'session' },
      },
    } as never, () => null)
    expect(slots.entries('conversation.input.left')).toHaveLength(1)
    expect(slots.entries('conversation.input.dock')).toHaveLength(1)

    const entry = slots.entries('conversation.input.left')[0]
    const injectEntry = entry?.inject as unknown as ((sessionId: string) => VoiceInjected)
    const injected = injectEntry('session-1')
    const Component = entry?.component as ComponentType<Record<string, unknown>>
    const useVoice = <T,>(selector: (snapshot: VoiceClientSnapshot) => T): T => useSyncExternalStore(
      injected.hooks.voice.subscribe,
      () => selector(injected.hooks.voice.getSnapshot()),
      () => selector(injected.hooks.voice.getSnapshot()),
    )
    const markup = renderToStaticMarkup(createElement(Component, {
      sessionId: 'session-1',
      useVoice,
      startVoice: injected.startVoice,
      acceptDisclosure: injected.acceptDisclosure,
      stopVoice: injected.stopVoice,
      t: locale.bind('guardedVoice'),
    }))
    expect(markup).toContain('Open DSH Live Voice')
    expect(constructSocket).not.toHaveBeenCalled()

    await fiber.dispose()
    expect(slots.entries('conversation.input.left')).toHaveLength(0)
    expect(slots.entries('conversation.input.dock')).toHaveLength(0)
    disposeDeclaration()
  })

  it('fails before registration when the Host bootstrap is absent or expanded', () => {
    vi.stubGlobal('window', browserWindow())
    const missing = fixture()
    expect(() => client.apply(missing.ctx as never)).toThrow(/bootstrap/u)
    expect(missing.declarations).toEqual([])

    ;(globalThis as Record<string, unknown>)[CLIENT_BOOT_GLOBAL] = {
      v: 1,
      route: '/guarded-voice',
      credential: 'must-not-cross',
    }
    const expanded = fixture()
    expect(() => client.apply(expanded.ctx as never)).toThrow(/bootstrap/u)
    expect(expanded.declarations).toEqual([])
  })
})
