// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * User preferences management using localStorage
 */

const STORAGE_KEYS = {
  LAST_TAB: 'wegent_last_tab',
  LAST_TEAM_ID: 'wegent_last_team_id',
  LAST_TEAM_ID_CHAT: 'wegent_last_team_id_chat',
  LAST_TEAM_ID_CODE: 'wegent_last_team_id_code',
  LAST_REPO_ID: 'wegent_last_repo_id',
  LAST_REPO_NAME: 'wegent_last_repo_name',
  // Model selection by mode
  LAST_MODEL_ID_CHAT: 'wegent_last_model_id_chat',
  LAST_MODEL_TYPE_CHAT: 'wegent_last_model_type_chat',
  LAST_MODEL_ID_CODE: 'wegent_last_model_id_code',
  LAST_MODEL_TYPE_CODE: 'wegent_last_model_type_code',
} as const;

export type TabType = 'chat' | 'code' | 'wiki';

/**
 * Save user's last active tab
 */
export function saveLastTab(tab: TabType): void {
  try {
    localStorage.setItem(STORAGE_KEYS.LAST_TAB, tab);
  } catch (error) {
    console.warn('Failed to save last tab to localStorage:', error);
  }
}

/**
 * Get user's last active tab
 */
export function getLastTab(): TabType | null {
  try {
    const tab = localStorage.getItem(STORAGE_KEYS.LAST_TAB);
    return tab === 'chat' || tab === 'code' || tab === 'wiki' ? tab : null;
  } catch (error) {
    console.warn('Failed to get last tab from localStorage:', error);
    return null;
  }
}

/**
 * Save user's last selected team
 */
export function saveLastTeam(teamId: number): void {
  try {
    if (!teamId || isNaN(teamId)) {
      console.warn('[userPreferences] Invalid team ID, not saving:', teamId);
      return;
    }
    localStorage.setItem(STORAGE_KEYS.LAST_TEAM_ID, String(teamId));
  } catch (error) {
    console.warn('Failed to save last team to localStorage:', error);
  }
}

/**
 * Get user's last selected team ID
 */
export function getLastTeamId(): number | null {
  try {
    const teamId = localStorage.getItem(STORAGE_KEYS.LAST_TEAM_ID);
    if (!teamId || teamId === 'undefined' || teamId === 'null' || teamId === 'NaN') {
      return null;
    }
    const result = parseInt(teamId, 10);
    if (isNaN(result)) {
      console.log('[userPreferences] Failed to parse team ID, got NaN from:', teamId);
      return null;
    }
    console.log('[userPreferences] Getting team from localStorage:', result);
    return result;
  } catch (error) {
    console.warn('Failed to get last team from localStorage:', error);
    return null;
  }
}

/**
 * Save user's last selected team for a specific mode (chat/code)
 */
export function saveLastTeamByMode(teamId: number, mode: 'chat' | 'code'): void {
  try {
    if (!teamId || isNaN(teamId)) {
      console.warn('[userPreferences] Invalid team ID, not saving:', teamId);
      return;
    }
    const key = mode === 'chat' ? STORAGE_KEYS.LAST_TEAM_ID_CHAT : STORAGE_KEYS.LAST_TEAM_ID_CODE;
    localStorage.setItem(key, String(teamId));
    // Also save to the generic key for backward compatibility
    localStorage.setItem(STORAGE_KEYS.LAST_TEAM_ID, String(teamId));
  } catch (error) {
    console.warn('Failed to save last team to localStorage:', error);
  }
}

/**
 * Get user's last selected team ID for a specific mode (chat/code)
 */
export function getLastTeamIdByMode(mode: 'chat' | 'code'): number | null {
  try {
    const key = mode === 'chat' ? STORAGE_KEYS.LAST_TEAM_ID_CHAT : STORAGE_KEYS.LAST_TEAM_ID_CODE;
    const teamId = localStorage.getItem(key);
    if (!teamId || teamId === 'undefined' || teamId === 'null' || teamId === 'NaN') {
      // console.log(
      //   `[userPreferences] Invalid or missing team ID in localStorage for ${mode} mode:`,
      //   teamId
      // );
      // Fallback to generic key
      return getLastTeamId();
    }
    const result = parseInt(teamId, 10);
    if (isNaN(result)) {
      console.log(
        `[userPreferences] Failed to parse team ID for ${mode} mode, got NaN from:`,
        teamId
      );
      return getLastTeamId();
    }
    console.log(`[userPreferences] Getting team from localStorage for ${mode} mode:`, result);
    return result;
  } catch (error) {
    console.warn('Failed to get last team from localStorage:', error);
    return null;
  }
}

/**
 * Save user's last selected repository
 */
export function saveLastRepo(repoId: number, repoName: string): void {
  try {
    localStorage.setItem(STORAGE_KEYS.LAST_REPO_ID, String(repoId));
    localStorage.setItem(STORAGE_KEYS.LAST_REPO_NAME, repoName);
  } catch (error) {
    console.warn('Failed to save last repo to localStorage:', error);
  }
}

/**
 * Get user's last selected repository info
 */
export function getLastRepo(): { repoId: number; repoName: string } | null {
  try {
    const repoId = localStorage.getItem(STORAGE_KEYS.LAST_REPO_ID);
    const repoName = localStorage.getItem(STORAGE_KEYS.LAST_REPO_NAME);

    if (repoId && repoName) {
      return {
        repoId: parseInt(repoId, 10),
        repoName,
      };
    }
    return null;
  } catch (error) {
    console.warn('Failed to get last repo from localStorage:', error);
    return null;
  }
}

/**
 * Model preference type for storing model selection
 */
export interface ModelPreference {
  modelId: string;
  modelType?: string;
}

/**
 * Save user's last selected model for a specific mode (chat/code)
 * This allows chat and code modes to remember their own model selections independently
 */
export function saveLastModelByMode(
  modelId: string,
  mode: 'chat' | 'code',
  modelType?: string
): void {
  try {
    if (!modelId) {
      console.warn('[userPreferences] Invalid model ID, not saving');
      return;
    }
    const idKey =
      mode === 'chat' ? STORAGE_KEYS.LAST_MODEL_ID_CHAT : STORAGE_KEYS.LAST_MODEL_ID_CODE;
    const typeKey =
      mode === 'chat' ? STORAGE_KEYS.LAST_MODEL_TYPE_CHAT : STORAGE_KEYS.LAST_MODEL_TYPE_CODE;

    localStorage.setItem(idKey, modelId);
    if (modelType) {
      localStorage.setItem(typeKey, modelType);
    } else {
      localStorage.removeItem(typeKey);
    }
  } catch (error) {
    console.warn('Failed to save last model to localStorage:', error);
  }
}

/**
 * Get user's last selected model for a specific mode (chat/code)
 * Returns the model preference if found, or null if not set
 */
export function getLastModelByMode(mode: 'chat' | 'code'): ModelPreference | null {
  try {
    const idKey =
      mode === 'chat' ? STORAGE_KEYS.LAST_MODEL_ID_CHAT : STORAGE_KEYS.LAST_MODEL_ID_CODE;
    const typeKey =
      mode === 'chat' ? STORAGE_KEYS.LAST_MODEL_TYPE_CHAT : STORAGE_KEYS.LAST_MODEL_TYPE_CODE;

    const modelId = localStorage.getItem(idKey);
    const modelType = localStorage.getItem(typeKey);

    if (!modelId || modelId === 'undefined' || modelId === 'null') {
      return null;
    }

    return {
      modelId,
      modelType: modelType || undefined,
    };
  } catch (error) {
    console.warn('Failed to get last model from localStorage:', error);
    return null;
  }
}

/**
 * Clear model preferences for a specific mode
 */
export function clearModelPreferenceByMode(mode: 'chat' | 'code'): void {
  try {
    const idKey =
      mode === 'chat' ? STORAGE_KEYS.LAST_MODEL_ID_CHAT : STORAGE_KEYS.LAST_MODEL_ID_CODE;
    const typeKey =
      mode === 'chat' ? STORAGE_KEYS.LAST_MODEL_TYPE_CHAT : STORAGE_KEYS.LAST_MODEL_TYPE_CODE;

    localStorage.removeItem(idKey);
    localStorage.removeItem(typeKey);
  } catch (error) {
    console.warn('Failed to clear model preference from localStorage:', error);
  }
}

/**
 * Clear all user preferences
 */
export function clearAllPreferences(): void {
  try {
    Object.values(STORAGE_KEYS).forEach(key => {
      localStorage.removeItem(key);
    });
  } catch (error) {
    console.warn('Failed to clear preferences from localStorage:', error);
  }
}
