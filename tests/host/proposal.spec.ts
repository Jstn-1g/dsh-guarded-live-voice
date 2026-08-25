import { describe, expect, it } from 'vitest'
import {
  MAX_PROPOSAL_INSTRUCTION_LENGTH,
  parseGuardedProposal,
} from '../../src/host/proposal.js'

const target = { sessionId: 's1', workspaceId: 'w1' }

describe('guarded proposal normalization', () => {
  it('creates data with explicitly no execution authority', () => {
    expect(parseGuardedProposal('{"title":"Fix it","instruction":"Inspect, then propose a patch.\\r\\nDo not run it."}', target))
      .toEqual({
        kind: 'work-instruction',
        title: 'Fix it',
        instruction: 'Inspect, then propose a patch.\nDo not run it.',
        target,
        authority: 'none',
      })
  })

  it.each([
    'not-json',
    '[]',
    '{"instruction":""}',
    '{"instruction":42}',
    '{"instruction":"ok","execute":true}',
    '{"instruction":"bad\\u0000text"}',
  ])('rejects malformed or authority-expanding arguments %s', (raw) => {
    expect(() => parseGuardedProposal(raw, target)).toThrow()
  })

  it('rejects oversized title, instruction, and encoded payload', () => {
    expect(() => parseGuardedProposal(JSON.stringify({ instruction: 'x'.repeat(MAX_PROPOSAL_INSTRUCTION_LENGTH + 1) }), target))
      .toThrow(/too long/u)
    expect(() => parseGuardedProposal(JSON.stringify({ title: 'x'.repeat(121), instruction: 'ok' }), target))
      .toThrow(/too long/u)
    expect(() => parseGuardedProposal(JSON.stringify({ instruction: '😀'.repeat(3_000) }), target))
      .toThrow(/byte limit/u)
  })
})
