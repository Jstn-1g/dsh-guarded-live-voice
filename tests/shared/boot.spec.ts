import { describe, expect, it } from 'vitest'
import { guardedVoiceClientBootInjection } from '../../src/host/boot.js'
import {
  CLIENT_BOOT_GLOBAL,
  CLIENT_BOOT_VERSION,
  parseGuardedVoiceClientBoot,
} from '../../src/shared/boot.js'

describe('browser bootstrap', () => {
  it('round-trips the sole non-secret route field', () => {
    const injection = guardedVoiceClientBootInjection('/guarded-voice.v2')
    expect(injection).toEqual({
      kind: 'global',
      name: CLIENT_BOOT_GLOBAL,
      value: { v: CLIENT_BOOT_VERSION, route: '/guarded-voice.v2' },
    })
    if (injection.kind !== 'global') throw new Error('expected a structured global injection')
    expect(parseGuardedVoiceClientBoot(injection.value)).toEqual(injection.value)
  })

  it.each([
    undefined,
    null,
    [],
    { v: 2, route: '/guarded-voice' },
    { v: 1, route: '' },
    { v: 1, route: 'guarded-voice' },
    { v: 1, route: '/voice/nested' },
    { v: 1, route: '/.' },
    { v: 1, route: '/..' },
    { v: 1, route: '//example.test/voice' },
    { v: 1, route: '/voice?secret=value' },
    { v: 1, route: '/voice', credential: 'secret' },
  ])('rejects malformed or expanded bootstrap data %#', (value) => {
    expect(() => parseGuardedVoiceClientBoot(value)).toThrow(/bootstrap/u)
  })

  it.each(['//example.test/voice', '/.', '/..'])('also rejects %s through the exported Host helper', route => {
    expect(() => guardedVoiceClientBootInjection(route)).toThrow(/bootstrap/u)
  })
})
