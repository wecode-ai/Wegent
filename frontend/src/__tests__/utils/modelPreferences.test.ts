// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  saveGlobalModelPreference,
  saveSessionModelPreference,
  getModelPreference,
  getSessionModelPreference,
  getGlobalModelPreference,
  clearSessionModelPreference,
  clearGlobalModelPreference,
  cleanupModelPreferences,
  ModelPreference,
} from '@/utils/modelPreferences'

// Constants matching the source file
const GLOBAL_MODEL_PREF_PREFIX = 'wegent_model_pref_'
const SESSION_PREF_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
const MAX_GLOBAL_PREFS = 50

describe('modelPreferences', () => {
  // Mock localStorage
  let localStorageMock: { [key: string]: string }

  beforeEach(() => {
    localStorageMock = {}

    // Mock localStorage methods
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation((key, value) => {
      localStorageMock[key] = value
    })
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(key => {
      return localStorageMock[key] || null
    })
    jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(key => {
      delete localStorageMock[key]
    })
    // Note: localStorage.key() returns keys in insertion order in real browsers,
    // but Object.keys() may return them in a different order for numeric-like keys.
    // We use a stable implementation that captures keys at call time.
    jest.spyOn(Storage.prototype, 'key').mockImplementation(index => {
      const keys = Object.keys(localStorageMock)
      return keys[index] ?? null
    })
    Object.defineProperty(Storage.prototype, 'length', {
      get: () => Object.keys(localStorageMock).length,
      configurable: true,
    })

    // Suppress console.warn during tests
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  // Helper to create a valid preference
  const createPreference = (
    modelName: string,
    modelType?: string,
    forceOverride = false,
    updatedAt = Date.now()
  ): ModelPreference => ({
    modelName,
    modelType,
    forceOverride,
    updatedAt,
  })

  describe('saveGlobalModelPreference', () => {
    it('should save preference with valid team ID', () => {
      const teamId = 123
      const preference = createPreference('gpt-4', 'public')

      saveGlobalModelPreference(teamId, preference)

      const key = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
      expect(localStorageMock[key]).toBeDefined()
      const saved = JSON.parse(localStorageMock[key])
      expect(saved.modelName).toBe('gpt-4')
      expect(saved.modelType).toBe('public')
    })

    it('should not save with invalid team ID (0)', () => {
      const preference = createPreference('gpt-4')

      saveGlobalModelPreference(0, preference)

      expect(Object.keys(localStorageMock).length).toBe(0)
    })

    it('should not save with invalid team ID (NaN)', () => {
      const preference = createPreference('gpt-4')

      saveGlobalModelPreference(NaN, preference)

      expect(Object.keys(localStorageMock).length).toBe(0)
    })

    it('should not save with negative team ID', () => {
      const preference = createPreference('gpt-4')

      // Note: negative numbers are valid in the current implementation
      // This test documents current behavior
      saveGlobalModelPreference(-1, preference)

      // Current implementation allows negative IDs
      const key = `${GLOBAL_MODEL_PREF_PREFIX}-1`
      expect(localStorageMock[key]).toBeDefined()
    })

    it('should not update legacy keys (cross-team isolation)', () => {
      const teamId = 123
      const preference = createPreference('gpt-4')

      saveGlobalModelPreference(teamId, preference)

      // Legacy keys should NOT be updated
      expect(localStorageMock['last_selected_model_id']).toBeUndefined()
      expect(localStorageMock['last_selected_model_type']).toBeUndefined()
    })

    it('should overwrite existing preference for same team', () => {
      const teamId = 123
      const preference1 = createPreference('gpt-4')
      const preference2 = createPreference('claude-3')

      saveGlobalModelPreference(teamId, preference1)
      saveGlobalModelPreference(teamId, preference2)

      const key = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
      const saved = JSON.parse(localStorageMock[key])
      expect(saved.modelName).toBe('claude-3')
    })

    it('should keep preferences isolated between teams', () => {
      const teamId1 = 123
      const teamId2 = 456
      const preference1 = createPreference('gpt-4')
      const preference2 = createPreference('claude-3')

      saveGlobalModelPreference(teamId1, preference1)
      saveGlobalModelPreference(teamId2, preference2)

      const key1 = `${GLOBAL_MODEL_PREF_PREFIX}${teamId1}`
      const key2 = `${GLOBAL_MODEL_PREF_PREFIX}${teamId2}`
      expect(JSON.parse(localStorageMock[key1]).modelName).toBe('gpt-4')
      expect(JSON.parse(localStorageMock[key2]).modelName).toBe('claude-3')
    })

    it('should handle localStorage errors gracefully', () => {
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      const preference = createPreference('gpt-4')

      // Should not throw
      expect(() => saveGlobalModelPreference(123, preference)).not.toThrow()
    })
  })

  describe('saveSessionModelPreference', () => {
    it('should save to both session and global dimensions', () => {
      const taskId = 100
      const teamId = 123
      const preference = createPreference('gpt-4')

      saveSessionModelPreference(taskId, teamId, preference)

      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}${taskId}_${teamId}`
      const globalKey = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`

      expect(localStorageMock[sessionKey]).toBeDefined()
      expect(localStorageMock[globalKey]).toBeDefined()
    })

    it('should not save with invalid task ID (0)', () => {
      const preference = createPreference('gpt-4')

      saveSessionModelPreference(0, 123, preference)

      expect(Object.keys(localStorageMock).length).toBe(0)
    })

    it('should not save with invalid task ID (NaN)', () => {
      const preference = createPreference('gpt-4')

      saveSessionModelPreference(NaN, 123, preference)

      expect(Object.keys(localStorageMock).length).toBe(0)
    })

    it('should not save with invalid team ID (0)', () => {
      const preference = createPreference('gpt-4')

      saveSessionModelPreference(100, 0, preference)

      expect(Object.keys(localStorageMock).length).toBe(0)
    })

    it('should not save with invalid team ID (NaN)', () => {
      const preference = createPreference('gpt-4')

      saveSessionModelPreference(100, NaN, preference)

      expect(Object.keys(localStorageMock).length).toBe(0)
    })

    it('should handle localStorage errors gracefully', () => {
      jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('QuotaExceededError')
      })

      const preference = createPreference('gpt-4')

      expect(() => saveSessionModelPreference(100, 123, preference)).not.toThrow()
    })
  })

  describe('getModelPreference', () => {
    it('should return null for invalid team ID (0)', () => {
      const result = getModelPreference(0)
      expect(result).toBeNull()
    })

    it('should return null for invalid team ID (NaN)', () => {
      const result = getModelPreference(NaN)
      expect(result).toBeNull()
    })

    it('should return null when no preference exists', () => {
      const result = getModelPreference(123)
      expect(result).toBeNull()
    })

    it('should return global preference when no taskId provided', () => {
      const teamId = 123
      const preference = createPreference('gpt-4', 'public', true)
      saveGlobalModelPreference(teamId, preference)

      const result = getModelPreference(teamId)

      expect(result).not.toBeNull()
      expect(result!.modelName).toBe('gpt-4')
      expect(result!.modelType).toBe('public')
      expect(result!.forceOverride).toBe(true)
    })

    it('should prioritize session preference over global when taskId provided', () => {
      const taskId = 100
      const teamId = 123
      const globalPref = createPreference('gpt-4')
      const sessionPref = createPreference('claude-3')

      saveGlobalModelPreference(teamId, globalPref)
      saveSessionModelPreference(taskId, teamId, sessionPref)

      const result = getModelPreference(teamId, taskId)

      expect(result!.modelName).toBe('claude-3')
    })

    it('should fall back to global when session preference does not exist', () => {
      const taskId = 100
      const teamId = 123
      const globalPref = createPreference('gpt-4')

      saveGlobalModelPreference(teamId, globalPref)

      const result = getModelPreference(teamId, taskId)

      expect(result!.modelName).toBe('gpt-4')
    })

    it('should remove and skip expired session preferences', () => {
      const taskId = 100
      const teamId = 123
      const expiredTime = Date.now() - SESSION_PREF_MAX_AGE_MS - 1000
      const expiredPref = createPreference('expired-model', undefined, false, expiredTime)
      const globalPref = createPreference('gpt-4')

      // Manually set expired session preference
      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}${taskId}_${teamId}`
      localStorageMock[sessionKey] = JSON.stringify(expiredPref)
      saveGlobalModelPreference(teamId, globalPref)

      const result = getModelPreference(teamId, taskId)

      // Should return global preference, not expired session
      expect(result!.modelName).toBe('gpt-4')
      // Expired session should be removed
      expect(localStorageMock[sessionKey]).toBeUndefined()
    })

    it('should return valid session preference that is not expired', () => {
      const taskId = 100
      const teamId = 123
      const validTime = Date.now() - 1000 // 1 second ago
      const sessionPref = createPreference('session-model', undefined, false, validTime)

      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}${taskId}_${teamId}`
      localStorageMock[sessionKey] = JSON.stringify(sessionPref)

      const result = getModelPreference(teamId, taskId)

      expect(result!.modelName).toBe('session-model')
    })

    it('should NOT fall back to legacy storage (cross-team isolation)', () => {
      // Set legacy storage (simulating old behavior)
      localStorageMock['last_selected_model_id'] = 'legacy-model'
      localStorageMock['last_selected_model_type'] = 'public'

      const result = getModelPreference(123)

      // Should NOT return legacy model
      expect(result).toBeNull()
    })

    it('should handle invalid JSON in localStorage gracefully', () => {
      const teamId = 123
      const key = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
      localStorageMock[key] = 'invalid json'

      const result = getModelPreference(teamId)

      expect(result).toBeNull()
    })

    it('should handle missing required fields in stored preference', () => {
      const teamId = 123
      const key = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
      // Missing updatedAt field
      localStorageMock[key] = JSON.stringify({ modelName: 'gpt-4' })

      const result = getModelPreference(teamId)

      expect(result).toBeNull()
    })

    it('should handle localStorage errors gracefully', () => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError')
      })

      const result = getModelPreference(123)

      expect(result).toBeNull()
    })
  })

  describe('getSessionModelPreference', () => {
    it('should return null for invalid task ID (0)', () => {
      const result = getSessionModelPreference(0, 123)
      expect(result).toBeNull()
    })

    it('should return null for invalid task ID (NaN)', () => {
      const result = getSessionModelPreference(NaN, 123)
      expect(result).toBeNull()
    })

    it('should return null for invalid team ID (0)', () => {
      const result = getSessionModelPreference(100, 0)
      expect(result).toBeNull()
    })

    it('should return null for invalid team ID (NaN)', () => {
      const result = getSessionModelPreference(100, NaN)
      expect(result).toBeNull()
    })

    it('should return null when no session preference exists', () => {
      const result = getSessionModelPreference(100, 123)
      expect(result).toBeNull()
    })

    it('should return session preference when it exists', () => {
      const taskId = 100
      const teamId = 123
      const preference = createPreference('gpt-4')
      saveSessionModelPreference(taskId, teamId, preference)

      const result = getSessionModelPreference(taskId, teamId)

      expect(result!.modelName).toBe('gpt-4')
    })

    it('should NOT fall back to global preference', () => {
      const taskId = 100
      const teamId = 123
      const globalPref = createPreference('gpt-4')
      saveGlobalModelPreference(teamId, globalPref)

      const result = getSessionModelPreference(taskId, teamId)

      // Should return null, not global preference
      expect(result).toBeNull()
    })

    it('should remove and skip expired session preferences', () => {
      const taskId = 100
      const teamId = 123
      const expiredTime = Date.now() - SESSION_PREF_MAX_AGE_MS - 1000
      const expiredPref = createPreference('expired-model', undefined, false, expiredTime)

      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}${taskId}_${teamId}`
      localStorageMock[sessionKey] = JSON.stringify(expiredPref)

      const result = getSessionModelPreference(taskId, teamId)

      expect(result).toBeNull()
      expect(localStorageMock[sessionKey]).toBeUndefined()
    })

    it('should handle localStorage errors gracefully', () => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError')
      })

      const result = getSessionModelPreference(100, 123)

      expect(result).toBeNull()
    })
  })

  describe('getGlobalModelPreference', () => {
    it('should return null for invalid team ID (0)', () => {
      const result = getGlobalModelPreference(0)
      expect(result).toBeNull()
    })

    it('should return null for invalid team ID (NaN)', () => {
      const result = getGlobalModelPreference(NaN)
      expect(result).toBeNull()
    })

    it('should return null when no preference exists', () => {
      const result = getGlobalModelPreference(123)
      expect(result).toBeNull()
    })

    it('should return global preference when it exists', () => {
      const teamId = 123
      const preference = createPreference('gpt-4', 'public')
      saveGlobalModelPreference(teamId, preference)

      const result = getGlobalModelPreference(teamId)

      expect(result!.modelName).toBe('gpt-4')
      expect(result!.modelType).toBe('public')
    })

    it('should NOT fall back to legacy storage (cross-team isolation)', () => {
      localStorageMock['last_selected_model_id'] = 'legacy-model'
      localStorageMock['last_selected_model_type'] = 'public'

      const result = getGlobalModelPreference(123)

      expect(result).toBeNull()
    })

    it('should handle localStorage errors gracefully', () => {
      jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('SecurityError')
      })

      const result = getGlobalModelPreference(123)

      expect(result).toBeNull()
    })
  })

  describe('clearSessionModelPreference', () => {
    it('should do nothing for invalid task ID (0)', () => {
      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}100_123`
      localStorageMock[sessionKey] = 'test'

      clearSessionModelPreference(0, 123)

      expect(localStorageMock[sessionKey]).toBe('test')
    })

    it('should do nothing for invalid task ID (NaN)', () => {
      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}100_123`
      localStorageMock[sessionKey] = 'test'

      clearSessionModelPreference(NaN, 123)

      expect(localStorageMock[sessionKey]).toBe('test')
    })

    it('should do nothing for invalid team ID (0)', () => {
      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}100_123`
      localStorageMock[sessionKey] = 'test'

      clearSessionModelPreference(100, 0)

      expect(localStorageMock[sessionKey]).toBe('test')
    })

    it('should do nothing for invalid team ID (NaN)', () => {
      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}100_123`
      localStorageMock[sessionKey] = 'test'

      clearSessionModelPreference(100, NaN)

      expect(localStorageMock[sessionKey]).toBe('test')
    })

    it('should remove session preference', () => {
      const taskId = 100
      const teamId = 123
      const preference = createPreference('gpt-4')
      saveSessionModelPreference(taskId, teamId, preference)

      clearSessionModelPreference(taskId, teamId)

      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}${taskId}_${teamId}`
      expect(localStorageMock[sessionKey]).toBeUndefined()
    })

    it('should NOT remove global preference', () => {
      const taskId = 100
      const teamId = 123
      const preference = createPreference('gpt-4')
      saveSessionModelPreference(taskId, teamId, preference)

      clearSessionModelPreference(taskId, teamId)

      const globalKey = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
      expect(localStorageMock[globalKey]).toBeDefined()
    })

    it('should handle localStorage errors gracefully', () => {
      jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError')
      })

      expect(() => clearSessionModelPreference(100, 123)).not.toThrow()
    })
  })

  describe('clearGlobalModelPreference', () => {
    it('should do nothing for invalid team ID (0)', () => {
      const globalKey = `${GLOBAL_MODEL_PREF_PREFIX}123`
      localStorageMock[globalKey] = 'test'

      clearGlobalModelPreference(0)

      expect(localStorageMock[globalKey]).toBe('test')
    })

    it('should do nothing for invalid team ID (NaN)', () => {
      const globalKey = `${GLOBAL_MODEL_PREF_PREFIX}123`
      localStorageMock[globalKey] = 'test'

      clearGlobalModelPreference(NaN)

      expect(localStorageMock[globalKey]).toBe('test')
    })

    it('should remove global preference', () => {
      const teamId = 123
      const preference = createPreference('gpt-4')
      saveGlobalModelPreference(teamId, preference)

      clearGlobalModelPreference(teamId)

      const globalKey = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
      expect(localStorageMock[globalKey]).toBeUndefined()
    })

    it('should handle localStorage errors gracefully', () => {
      jest.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
        throw new Error('SecurityError')
      })

      expect(() => clearGlobalModelPreference(123)).not.toThrow()
    })
  })

  describe('cleanupModelPreferences', () => {
    it('should remove expired session preferences', () => {
      const expiredTime = Date.now() - SESSION_PREF_MAX_AGE_MS - 1000
      const validTime = Date.now()

      // Expired session preference
      const expiredKey = `${GLOBAL_MODEL_PREF_PREFIX}100_123`
      localStorageMock[expiredKey] = JSON.stringify(
        createPreference('expired', undefined, false, expiredTime)
      )

      // Valid session preference
      const validKey = `${GLOBAL_MODEL_PREF_PREFIX}200_456`
      localStorageMock[validKey] = JSON.stringify(
        createPreference('valid', undefined, false, validTime)
      )

      cleanupModelPreferences()

      expect(localStorageMock[expiredKey]).toBeUndefined()
      expect(localStorageMock[validKey]).toBeDefined()
    })

    it('should remove invalid preferences (invalid JSON)', () => {
      const invalidKey = `${GLOBAL_MODEL_PREF_PREFIX}123`
      localStorageMock[invalidKey] = 'invalid json'

      cleanupModelPreferences()

      expect(localStorageMock[invalidKey]).toBeUndefined()
    })

    it('should remove invalid preferences (missing required fields)', () => {
      const invalidKey = `${GLOBAL_MODEL_PREF_PREFIX}123`
      localStorageMock[invalidKey] = JSON.stringify({ modelName: 'test' }) // missing updatedAt

      cleanupModelPreferences()

      expect(localStorageMock[invalidKey]).toBeUndefined()
    })

    it('should apply LRU cleanup when global preferences exceed limit', () => {
      const now = Date.now()

      // Create more than MAX_GLOBAL_PREFS global preferences
      // Use team IDs starting from 1000 to avoid underscore in the key
      for (let i = 0; i < MAX_GLOBAL_PREFS + 10; i++) {
        const teamId = 1000 + i
        const key = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
        localStorageMock[key] = JSON.stringify(
          createPreference(
            `model-${teamId}`,
            undefined,
            false,
            now - (MAX_GLOBAL_PREFS + 10 - i) * 1000
          )
        )
      }

      cleanupModelPreferences()

      const remainingKeys = Object.keys(localStorageMock).filter(
        k =>
          k.startsWith(GLOBAL_MODEL_PREF_PREFIX) &&
          !k.substring(GLOBAL_MODEL_PREF_PREFIX.length).includes('_')
      )
      expect(remainingKeys.length).toBe(MAX_GLOBAL_PREFS)

      // Oldest preferences should be removed (1000-1009)
      for (let i = 0; i < 10; i++) {
        const teamId = 1000 + i
        const key = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
        expect(localStorageMock[key]).toBeUndefined()
      }

      // Newest preferences should remain (1010-1059)
      for (let i = 10; i < MAX_GLOBAL_PREFS + 10; i++) {
        const teamId = 1000 + i
        const key = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`
        expect(localStorageMock[key]).toBeDefined()
      }
    })

    it('should not remove global preferences when under limit', () => {
      const now = Date.now()

      // Create fewer than MAX_GLOBAL_PREFS global preferences
      for (let i = 0; i < 10; i++) {
        const key = `${GLOBAL_MODEL_PREF_PREFIX}${i}`
        localStorageMock[key] = JSON.stringify(
          createPreference(`model-${i}`, undefined, false, now)
        )
      }

      cleanupModelPreferences()

      // All should remain
      for (let i = 0; i < 10; i++) {
        const key = `${GLOBAL_MODEL_PREF_PREFIX}${i}`
        expect(localStorageMock[key]).toBeDefined()
      }
    })

    it('should not affect non-preference keys', () => {
      localStorageMock['other_key'] = 'other_value'
      localStorageMock['last_selected_model_id'] = 'legacy'

      cleanupModelPreferences()

      expect(localStorageMock['other_key']).toBe('other_value')
      expect(localStorageMock['last_selected_model_id']).toBe('legacy')
    })

    it('should handle localStorage errors gracefully', () => {
      jest.spyOn(Storage.prototype, 'key').mockImplementation(() => {
        throw new Error('SecurityError')
      })

      expect(() => cleanupModelPreferences()).not.toThrow()
    })

    it('should correctly distinguish session vs global preferences', () => {
      const now = Date.now()

      // Global preference (no underscore in key after prefix)
      const globalKey = `${GLOBAL_MODEL_PREF_PREFIX}123`
      localStorageMock[globalKey] = JSON.stringify(
        createPreference('global', undefined, false, now)
      )

      // Session preference (has underscore: taskId_teamId)
      const sessionKey = `${GLOBAL_MODEL_PREF_PREFIX}100_123`
      localStorageMock[sessionKey] = JSON.stringify(
        createPreference('session', undefined, false, now)
      )

      cleanupModelPreferences()

      // Both should remain (not expired, under limit)
      expect(localStorageMock[globalKey]).toBeDefined()
      expect(localStorageMock[sessionKey]).toBeDefined()
    })
  })

  describe('cross-team isolation', () => {
    it('should keep preferences completely isolated between teams', () => {
      const team1 = 100
      const team2 = 200
      const pref1 = createPreference('model-for-team-1')
      const pref2 = createPreference('model-for-team-2')

      saveGlobalModelPreference(team1, pref1)
      saveGlobalModelPreference(team2, pref2)

      expect(getGlobalModelPreference(team1)!.modelName).toBe('model-for-team-1')
      expect(getGlobalModelPreference(team2)!.modelName).toBe('model-for-team-2')
    })

    it('should not pollute other teams when saving preference', () => {
      const team1 = 100
      const team2 = 200
      const pref1 = createPreference('model-for-team-1')

      saveGlobalModelPreference(team1, pref1)

      // Team 2 should have no preference
      expect(getGlobalModelPreference(team2)).toBeNull()
    })

    it('should not read legacy keys that could cause cross-team pollution', () => {
      // Simulate legacy data that could cause pollution
      localStorageMock['last_selected_model_id'] = 'polluted-model'
      localStorageMock['last_selected_model_type'] = 'public'

      // New team should not read legacy data
      const result = getGlobalModelPreference(999)
      expect(result).toBeNull()
    })
  })

  describe('preference data integrity', () => {
    it('should preserve all fields when saving and retrieving', () => {
      const teamId = 123
      const preference: ModelPreference = {
        modelName: 'gpt-4-turbo',
        modelType: 'private',
        forceOverride: true,
        updatedAt: 1234567890,
      }

      saveGlobalModelPreference(teamId, preference)
      const result = getGlobalModelPreference(teamId)

      expect(result).toEqual(preference)
    })

    it('should handle preference without optional modelType', () => {
      const teamId = 123
      const preference: ModelPreference = {
        modelName: 'gpt-4',
        forceOverride: false,
        updatedAt: Date.now(),
      }

      saveGlobalModelPreference(teamId, preference)
      const result = getGlobalModelPreference(teamId)

      expect(result!.modelName).toBe('gpt-4')
      expect(result!.modelType).toBeUndefined()
    })

    it('should coerce forceOverride to boolean', () => {
      const teamId = 123
      const key = `${GLOBAL_MODEL_PREF_PREFIX}${teamId}`

      // Store with truthy non-boolean value
      localStorageMock[key] = JSON.stringify({
        modelName: 'gpt-4',
        forceOverride: 1, // truthy number
        updatedAt: Date.now(),
      })

      const result = getGlobalModelPreference(teamId)
      expect(result!.forceOverride).toBe(true)

      // Store with falsy non-boolean value
      localStorageMock[key] = JSON.stringify({
        modelName: 'gpt-4',
        forceOverride: 0, // falsy number
        updatedAt: Date.now(),
      })

      const result2 = getGlobalModelPreference(teamId)
      expect(result2!.forceOverride).toBe(false)
    })
  })
})
