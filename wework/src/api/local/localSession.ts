import type { User, UserPreferences } from '@/types/api'

export const LOCAL_USER = {
  id: 0,
  user_name: 'local',
  email: 'local@wework.local',
  preferences: {},
} satisfies User

const LOCAL_USER_PREFERENCES_STORAGE_KEY = 'wework.localUser.preferences'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readLocalUserPreferences(): UserPreferences {
  try {
    const raw = globalThis.localStorage?.getItem(LOCAL_USER_PREFERENCES_STORAGE_KEY)
    if (!raw) return LOCAL_USER.preferences

    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? (parsed as UserPreferences) : LOCAL_USER.preferences
  } catch {
    return LOCAL_USER.preferences
  }
}

export function saveLocalUserPreferences(preferences: UserPreferences): User {
  try {
    globalThis.localStorage?.setItem(
      LOCAL_USER_PREFERENCES_STORAGE_KEY,
      JSON.stringify(preferences)
    )
  } catch {
    // Keep the in-session return value even if local persistence is unavailable.
  }

  return {
    ...LOCAL_USER,
    preferences,
  }
}

export function getLocalUser(): User {
  return {
    ...LOCAL_USER,
    preferences: readLocalUserPreferences(),
  }
}
