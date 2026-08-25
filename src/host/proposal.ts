import { GuardedVoiceError } from '../shared/errors.js'
import type { PublicAuthorityBinding } from './authority.js'

export const PROPOSAL_TOOL_NAME = 'prepare_work_instruction'
export const MAX_PROPOSAL_TITLE_LENGTH = 120
export const MAX_PROPOSAL_INSTRUCTION_LENGTH = 4_000

export interface GuardedProposal {
  readonly kind: 'work-instruction'
  readonly title?: string
  readonly instruction: string
  readonly target: PublicAuthorityBinding
  readonly authority: 'none'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function cleanText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') {
    throw new GuardedVoiceError('invalid-message', `${field} must be text`)
  }
  const cleaned = value.replace(/\r\n?/gu, '\n').trim()
  if (cleaned.length === 0 || cleaned.length > maxLength || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(cleaned)) {
    throw new GuardedVoiceError('invalid-message', `${field} is empty, too long, or contains control characters`)
  }
  return cleaned
}

/** Normalize one provider tool-call payload into a non-executable proposal. */
export function parseGuardedProposal(
  rawArguments: string,
  target: PublicAuthorityBinding,
): GuardedProposal {
  if (new TextEncoder().encode(rawArguments).byteLength > 8 * 1024) {
    throw new GuardedVoiceError('invalid-message', 'proposal arguments exceed the byte limit')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(rawArguments)
  } catch {
    throw new GuardedVoiceError('invalid-message', 'proposal arguments are not valid JSON')
  }
  if (!isRecord(parsed)) {
    throw new GuardedVoiceError('invalid-message', 'proposal arguments must be an object')
  }
  const allowed = new Set(['title', 'instruction'])
  if (Object.keys(parsed).some(key => !allowed.has(key))) {
    throw new GuardedVoiceError('invalid-message', 'proposal arguments contain unsupported fields')
  }
  const instruction = cleanText(parsed.instruction, 'instruction', MAX_PROPOSAL_INSTRUCTION_LENGTH)
  const title = parsed.title === undefined
    ? undefined
    : cleanText(parsed.title, 'title', MAX_PROPOSAL_TITLE_LENGTH)
  return {
    kind: 'work-instruction',
    ...(title === undefined ? {} : { title }),
    instruction,
    target: { ...target },
    authority: 'none',
  }
}
