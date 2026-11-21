import { USER_PREFERENCE_PROMPT_MAX_LENGTH } from '@/desktop/appPreferences'

export type UserPreferencePromptCommand = { action: 'append'; value: string }

export function parseUserPreferencePromptCommand(
  input: string
): UserPreferencePromptCommand | null {
  const value = input.trim()
  const preference = value.match(/^\/remember\s+([\s\S]+)$/)
  if (!preference) return null
  const preferenceValue = preference[1].trim()
  if (!preferenceValue) return null
  return { action: 'append', value: preferenceValue }
}

export function appendUserPreferencePrompt(current: string, value: string): string {
  const preference = value.trim()
  if (!preference) throw new Error('User preference cannot be empty')
  const next = current.trim() ? `${current.trim()}\n${preference}` : preference
  if (next.length > USER_PREFERENCE_PROMPT_MAX_LENGTH) {
    throw new Error(
      `User preference prompt must be at most ${USER_PREFERENCE_PROMPT_MAX_LENGTH} characters`
    )
  }
  return next
}
