import type { RuntimeAdditionalContext } from '@wegent/chat-core/runtime-task-api-types'

import { USER_PREFERENCE_PROMPT_MAX_LENGTH } from '@/desktop/appPreferences'

const USER_PREFERENCE_CONTEXT_KEY = 'wework.user-preferences'

export function withUserPreferencePrompt<
  T extends { additionalContext?: RuntimeAdditionalContext },
>(request: T, prompt: string): T & { additionalContext: RuntimeAdditionalContext } {
  const value = prompt.trim()
  if (!value) return request as T & { additionalContext: RuntimeAdditionalContext }
  if (value.length > USER_PREFERENCE_PROMPT_MAX_LENGTH) {
    throw new Error(
      `User preference prompt must be at most ${USER_PREFERENCE_PROMPT_MAX_LENGTH} characters`
    )
  }

  return {
    ...request,
    additionalContext: {
      ...request.additionalContext,
      [USER_PREFERENCE_CONTEXT_KEY]: {
        kind: 'application',
        value,
      },
    },
  }
}
