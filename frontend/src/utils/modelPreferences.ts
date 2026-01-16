// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Model preferences management using localStorage
 *
 * Supports two dimensions of model preference storage:
 * 1. Global dimension (team_id): Used for new chat sessions
 * 2. Session dimension (task_id + team_id): Used for existing chat sessions
 *
 * Update rules:
 * - New chat: Only updates global dimension
 * - Existing chat: Updates both global and session dimensions
 *
 * Restore rules:
 * - New chat: Restores from global dimension
 * - Existing chat: Prioritizes session dimension, falls back to global dimension
 */

// Storage key prefixes
const GLOBAL_MODEL_PREF_PREFIX = 'wegent_model_pref_'
const SESSION_MODEL_PREF_PREFIX = 'wegent_model_pref_'

// NOTE: Legacy storage keys (last_selected_model_id, last_selected_model_type) have been removed
// because they were global and caused cross-team model preference pollution.
// Each team now has its own isolated model preference stored with team-specific keys.

// Cleanup configuration
const SESSION_PREF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MAX_GLOBAL_PREFS = 50 // Maximum number of global preferences to keep

/**
 * Model preference data structure
 */
export interface ModelPreference {
  modelName: string
  modelType?: string
  forceOverride: boolean
  updatedAt: number
}

/**
 * Get the storage key for global dimension (team-level preference)
 */
function getGlobalKey(teamId: number): string {
  return `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
}

/**
 * Get the storage key for session dimension (task-level preference)
 */
function getSessionKey(taskId: number, teamId: number): string {
  return `${SESSION_MODEL_PREF_PREFIX}${taskId}_${teamId}`
}

/**
 * Parse stored preference JSON safely
 */
function parsePreference(json: string | null): ModelPreference | null {
  if (!json) return null
  try {
    const parsed = JSON.parse(json)
    // Validate required fields
    if (typeof parsed.modelName !== 'string' || typeof parsed.updatedAt !== 'number') {
      return null
    }
    return {
      modelName: parsed.modelName,
      modelType: parsed.modelType,
      forceOverride: Boolean(parsed.forceOverride),
      updatedAt: parsed.updatedAt,
    }
  } catch {
    return null
  }
}

/**
 * Save global model preference (team-level)
 * Used when user selects a model in a new chat session
 */
export function saveGlobalModelPreference(teamId: number, preference: ModelPreference): void {
  if (!teamId || isNaN(teamId)) {
    console.warn('[modelPreferences] Invalid team ID, not saving:', teamId)
    return
  }

  try {
    const key = getGlobalKey(teamId)
    localStorage.setItem(key, JSON.stringify(preference))
    // NOTE: Removed legacy key updates (LEGACY_MODEL_ID_KEY, LEGACY_MODEL_TYPE_KEY)
    // because they are global and cause cross-team model preference pollution.
    // Each team should have its own isolated model preference.
  } catch (error) {
    console.warn('[modelPreferences] Failed to save global preference:', error)
  }
}

/**
 * Save session model preference (task-level)
 * Also updates global preference for consistency
 * Used when user selects a model in an existing chat session
 */
export function saveSessionModelPreference(
  taskId: number,
  teamId: number,
  preference: ModelPreference
): void {
  if (!taskId || isNaN(taskId) || !teamId || isNaN(teamId)) {
    console.warn('[modelPreferences] Invalid task/team ID, not saving:', { taskId, teamId })
    return
  }

  try {
    // Save to session dimension
    const sessionKey = getSessionKey(taskId, teamId)
    localStorage.setItem(sessionKey, JSON.stringify(preference))

    // Also update global dimension
    saveGlobalModelPreference(teamId, preference)
  } catch (error) {
    console.warn('[modelPreferences] Failed to save session preference:', error)
  }
}

/**
 * Get model preference with priority:
 * 1. Session dimension (if taskId provided and preference exists)
 * 2. Global dimension (if preference exists)
 *
 * NOTE: Legacy storage fallback has been removed because it caused cross-team
 * model preference pollution. Each team now has its own isolated preference.
 */
export function getModelPreference(teamId: number, taskId?: number | null): ModelPreference | null {
  if (!teamId || isNaN(teamId)) {
    return null
  }

  try {
    // Priority 1: Session dimension (if taskId provided)
    if (taskId && !isNaN(taskId)) {
      const sessionKey = getSessionKey(taskId, teamId)
      const sessionPref = parsePreference(localStorage.getItem(sessionKey))
      if (sessionPref) {
        // Check if session preference is not expired
        if (Date.now() - sessionPref.updatedAt < SESSION_PREF_MAX_AGE_MS) {
          return sessionPref
        }
        // Clean up expired session preference
        localStorage.removeItem(sessionKey)
      }
    }

    // Priority 2: Global dimension
    const globalKey = getGlobalKey(teamId)
    const globalPref = parsePreference(localStorage.getItem(globalKey))
    if (globalPref) {
      return globalPref
    }

    // NOTE: Legacy storage fallback removed - each team has isolated preference
    // If no preference exists, return null to use team's bind_model
    return null
  } catch (error) {
    console.warn('[modelPreferences] Failed to get preference:', error)
    return null
  }
}

/**
 * Get session model preference only (no fallback to global)
 * Used when viewing existing tasks to avoid overwriting task's model with global preference
 */
export function getSessionModelPreference(taskId: number, teamId: number): ModelPreference | null {
  if (!taskId || isNaN(taskId) || !teamId || isNaN(teamId)) {
    return null
  }

  try {
    const sessionKey = getSessionKey(taskId, teamId)
    const sessionPref = parsePreference(localStorage.getItem(sessionKey))
    if (sessionPref) {
      // Check if session preference is not expired
      if (Date.now() - sessionPref.updatedAt < SESSION_PREF_MAX_AGE_MS) {
        return sessionPref
      }
      // Clean up expired session preference
      localStorage.removeItem(sessionKey)
    }
    return null
  } catch (error) {
    console.warn('[modelPreferences] Failed to get session preference:', error)
    return null
  }
}

/**
 * Get global model preference only (no session lookup)
 * Used for new chat sessions
 */
export function getGlobalModelPreference(teamId: number): ModelPreference | null {
  if (!teamId || isNaN(teamId)) {
    return null
  }

  try {
    const globalKey = getGlobalKey(teamId)
    const globalPref = parsePreference(localStorage.getItem(globalKey))
    if (globalPref) {
      return globalPref
    }
    // NOTE: Removed legacy storage fallback (LEGACY_MODEL_ID_KEY, LEGACY_MODEL_TYPE_KEY)
    // because they are global and cause cross-team model preference pollution.
    // Each team should have its own isolated model preference.
    // If no team-specific preference exists, return null to use team's bind_model.
    return null
  } catch (error) {
    console.warn('[modelPreferences] Failed to get global preference:', error)
    return null
  }
}

/**
 * Clear session model preference for a specific task
 */
export function clearSessionModelPreference(taskId: number, teamId: number): void {
  if (!taskId || isNaN(taskId) || !teamId || isNaN(teamId)) {
    return
  }

  try {
    const sessionKey = getSessionKey(taskId, teamId)
    localStorage.removeItem(sessionKey)
  } catch (error) {
    console.warn('[modelPreferences] Failed to clear session preference:', error)
  }
}

/**
 * Clear global model preference for a specific team
 */
export function clearGlobalModelPreference(teamId: number): void {
  if (!teamId || isNaN(teamId)) {
    return
  }

  try {
    const globalKey = getGlobalKey(teamId)
    localStorage.removeItem(globalKey)
  } catch (error) {
    console.warn('[modelPreferences] Failed to clear global preference:', error)
  }
}

/**
 * Clean up expired session preferences and limit global preferences count
 * Should be called periodically (e.g., on app startup)
 */
export function cleanupModelPreferences(): void {
  try {
    const now = Date.now()
    const globalPrefs: Array<{ key: string; updatedAt: number }> = []
    const keysToRemove: string[] = []

    // First, collect all keys into an array to avoid issues with
    // localStorage.length changing during iteration when keys are removed
    const allKeys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key) {
        allKeys.push(key)
      }
    }

    // Now iterate through the collected keys
    for (const key of allKeys) {
      if (!key.startsWith(GLOBAL_MODEL_PREF_PREFIX)) continue

      const value = localStorage.getItem(key)
      const pref = parsePreference(value)

      if (!pref) {
        // Invalid preference, mark for removal
        keysToRemove.push(key)
        continue
      }

      // Check if it's a session preference (contains underscore after prefix)
      const keyWithoutPrefix = key.substring(GLOBAL_MODEL_PREF_PREFIX.length)
      const isSessionPref = keyWithoutPrefix.includes('_')

      if (isSessionPref) {
        // Session preference: check expiration
        if (now - pref.updatedAt > SESSION_PREF_MAX_AGE_MS) {
          keysToRemove.push(key)
        }
      } else {
        // Global preference: collect for LRU cleanup
        globalPrefs.push({ key, updatedAt: pref.updatedAt })
      }
    }

    // Remove expired session preferences and invalid preferences
    keysToRemove.forEach(key => localStorage.removeItem(key))

    // LRU cleanup for global preferences
    if (globalPrefs.length > MAX_GLOBAL_PREFS) {
      // Sort by updatedAt ascending (oldest first)
      globalPrefs.sort((a, b) => a.updatedAt - b.updatedAt)
      // Remove oldest preferences
      const toRemove = globalPrefs.slice(0, globalPrefs.length - MAX_GLOBAL_PREFS)
      toRemove.forEach(({ key }) => localStorage.removeItem(key))
    }
  } catch (error) {
    console.warn('[modelPreferences] Failed to cleanup preferences:', error)
  }
}
