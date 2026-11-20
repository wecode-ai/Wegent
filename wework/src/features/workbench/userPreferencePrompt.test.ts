import { describe, expect, test } from 'vitest'

import type { RuntimeAdditionalContext } from '@wegent/chat-core/runtime-task-api-types'

import { USER_PREFERENCE_PROMPT_MAX_LENGTH } from '@/desktop/appPreferences'
import { withUserPreferencePrompt } from './userPreferencePrompt'

interface RequestWithOptionalContext {
  additionalContext?: RuntimeAdditionalContext
}

describe('withUserPreferencePrompt', () => {
  test('injects a trimmed non-empty prompt while preserving existing context', () => {
    const request: RequestWithOptionalContext = {
      additionalContext: {
        existing: { kind: 'application', value: 'Keep this context' },
      },
    }

    expect(withUserPreferencePrompt(request, '  Be concise.  ')).toEqual({
      additionalContext: {
        existing: { kind: 'application', value: 'Keep this context' },
        'wework.user-preferences': { kind: 'application', value: 'Be concise.' },
      },
    })
  })

  test('creates context when the request has none', () => {
    expect(withUserPreferencePrompt({}, 'Prefer plain language')).toEqual({
      additionalContext: {
        'wework.user-preferences': { kind: 'application', value: 'Prefer plain language' },
      },
    })
  })

  test('returns the same request for an empty prompt', () => {
    const request: RequestWithOptionalContext = {
      additionalContext: {
        existing: { kind: 'application', value: 'Keep this context' },
      },
    }

    expect(withUserPreferencePrompt(request, '   ')).toBe(request)
  })

  test('rejects a prompt over the configured length', () => {
    expect(() =>
      withUserPreferencePrompt({}, 'x'.repeat(USER_PREFERENCE_PROMPT_MAX_LENGTH + 1))
    ).toThrow('User preference prompt must be at most 4000 characters')
  })
})
