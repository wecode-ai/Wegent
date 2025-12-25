// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useRef, useCallback } from 'react';
import type { Team, TaskDetail } from '@/types/api';
import type { Model } from '../selector/ModelSelector';
import { DEFAULT_MODEL_NAME } from '../selector/ModelSelector';

export interface UseTeamPreferencesOptions {
  /**
   * List of available teams.
   */
  teams: Team[];

  /**
   * Whether there are messages to display.
   * Preferences are only restored when there are no messages.
   */
  hasMessages: boolean;

  /**
   * Currently selected task detail.
   */
  selectedTaskDetail: TaskDetail | null;

  /**
   * Currently selected team.
   */
  selectedTeam: Team | null;

  /**
   * Function to set the selected team.
   */
  setSelectedTeam: (team: Team | null) => void;

  /**
   * Function to set the selected model.
   */
  setSelectedModel: (model: Model | null) => void;

  /**
   * Function to set the force override flag.
   */
  setForceOverride: (value: boolean) => void;

  /**
   * Whether preferences have been restored.
   */
  hasRestoredPreferences: boolean;

  /**
   * Function to set the hasRestoredPreferences flag.
   */
  setHasRestoredPreferences: (value: boolean) => void;

  /**
   * Function to check if a team is compatible with the current mode.
   */
  isTeamCompatibleWithMode: (team: Team) => boolean;

  /**
   * Ref containing the initial team ID from localStorage.
   */
  initialTeamIdRef: React.MutableRefObject<number | null>;

  /**
   * Clear version from chat stream context.
   * Used to detect "New Chat" action.
   */
  clearVersion: number;
}

/**
 * Extracts the team ID from a task detail's team field.
 * Handles both number and object formats.
 */
function extractTeamId(team: TaskDetail['team']): number | null {
  if (!team) return null;
  if (typeof team === 'number') return team;
  if (typeof team === 'object') {
    const maybeId = (team as { id?: number }).id;
    return typeof maybeId === 'number' ? maybeId : null;
  }
  return null;
}

/**
 * Extracts the model name from a team's first bot configuration.
 */
function extractTeamModelName(team: Team): string | null {
  if (!team.bots || team.bots.length === 0) return null;
  const firstBotConfig = team.bots[0]?.bot?.agent_config;
  if (!firstBotConfig) return null;
  try {
    return ((firstBotConfig as Record<string, unknown>).bind_model as string | undefined) ?? null;
  } catch {
    return null;
  }
}

/**
 * useTeamPreferences Hook
 *
 * Consolidates all team preference and model synchronization logic:
 * - Restoring team preferences from localStorage
 * - Syncing team selection when viewing existing tasks
 * - Setting model when viewing existing tasks
 * - Resetting state when clearVersion changes (New Chat)
 *
 * This hook extracts multiple useEffect calls from ChatArea into a single,
 * cohesive unit that manages team and model preferences.
 */
export function useTeamPreferences({
  teams,
  hasMessages,
  selectedTaskDetail,
  selectedTeam,
  setSelectedTeam,
  setSelectedModel,
  setForceOverride,
  hasRestoredPreferences,
  setHasRestoredPreferences,
  isTeamCompatibleWithMode,
  initialTeamIdRef,
  clearVersion,
}: UseTeamPreferencesOptions): void {
  // Refs for tracking previous values
  const prevTaskIdForModelRef = useRef<number | null | undefined>(undefined);
  const prevClearVersionRef = useRef(clearVersion);

  // Compute detailTeamId
  const detailTeamId = selectedTaskDetail ? extractTeamId(selectedTaskDetail.team) : null;

  /**
   * Helper: Set model to default.
   */
  const handleDefaultModel = useCallback(() => {
    setSelectedModel({ name: DEFAULT_MODEL_NAME, provider: '', modelId: '' });
    setForceOverride(false);
  }, [setSelectedModel, setForceOverride]);

  /**
   * Helper: Set model to explicit value.
   */
  const handleExplicitModel = useCallback(
    (modelName: string) => {
      setSelectedModel({
        name: modelName,
        provider: '',
        modelId: modelName,
        displayName: null,
        type: undefined,
      });
    },
    [setSelectedModel]
  );

  /**
   * Effect: Reset state when clearVersion changes (New Chat).
   *
   * This replaces the original useEffect at lines 306-313 in ChatArea.tsx.
   */
  useEffect(() => {
    if (clearVersion !== prevClearVersionRef.current) {
      prevClearVersionRef.current = clearVersion;
      prevTaskIdForModelRef.current = undefined;
      setHasRestoredPreferences(false);
    }
  }, [clearVersion, setHasRestoredPreferences]);

  /**
   * Effect: Restore team preferences from localStorage.
   *
   * This replaces the original useEffect at lines 206-227 in ChatArea.tsx.
   * Only runs when there are no messages and preferences haven't been restored.
   */
  useEffect(() => {
    if (hasRestoredPreferences || !teams.length || (!selectedTaskDetail && hasMessages)) return;

    const lastTeamId = initialTeamIdRef.current;

    if (lastTeamId) {
      const lastTeam = teams.find(team => team.id === lastTeamId);
      if (lastTeam && isTeamCompatibleWithMode(lastTeam)) {
        setSelectedTeam(lastTeam);
        setHasRestoredPreferences(true);
        return;
      }
    }

    const compatibleTeam = teams.find(team => isTeamCompatibleWithMode(team));
    if (compatibleTeam) {
      setSelectedTeam(compatibleTeam);
    }
    setHasRestoredPreferences(true);
  }, [
    teams,
    hasRestoredPreferences,
    hasMessages,
    selectedTaskDetail,
    isTeamCompatibleWithMode,
    initialTeamIdRef,
    setSelectedTeam,
    setHasRestoredPreferences,
  ]);

  /**
   * Effect: Sync team selection when viewing existing task.
   *
   * This replaces the original useEffect at lines 230-246 in ChatArea.tsx.
   */
  useEffect(() => {
    if (!detailTeamId) return;

    if (!selectedTeam?.id || selectedTeam.id !== detailTeamId) {
      const matchedTeam = teams.find(team => team.id === detailTeamId) || null;
      if (matchedTeam) {
        setSelectedTeam(matchedTeam);
        setHasRestoredPreferences(true);
      } else if (selectedTaskDetail?.team && typeof selectedTaskDetail.team === 'object') {
        const teamFromDetail = selectedTaskDetail.team as Team;
        if (teamFromDetail.id === detailTeamId) {
          setSelectedTeam(teamFromDetail);
          setHasRestoredPreferences(true);
        }
      }
    }
  }, [
    detailTeamId,
    teams,
    selectedTeam?.id,
    selectedTaskDetail?.team,
    setSelectedTeam,
    setHasRestoredPreferences,
  ]);

  /**
   * Effect: Set model when viewing existing task.
   *
   * This replaces the original useEffect at lines 249-303 in ChatArea.tsx.
   */
  useEffect(() => {
    if (!selectedTaskDetail?.id || !selectedTeam) return;

    const taskIdChanged = prevTaskIdForModelRef.current !== selectedTaskDetail.id;
    if (!taskIdChanged) return;

    const isUserSwitchingTasks =
      prevTaskIdForModelRef.current !== undefined && prevTaskIdForModelRef.current !== null;

    prevTaskIdForModelRef.current = selectedTaskDetail.id;

    if (!isUserSwitchingTasks) return;

    const taskModelId = selectedTaskDetail.model_id;

    if (!taskModelId || taskModelId === DEFAULT_MODEL_NAME) {
      const teamModelName = extractTeamModelName(selectedTeam);

      if (teamModelName) {
        handleExplicitModel(teamModelName);
        setForceOverride(false);
      } else {
        handleDefaultModel();
      }
      return;
    }

    handleExplicitModel(taskModelId);
    setForceOverride(true);
  }, [
    selectedTaskDetail?.id,
    selectedTaskDetail?.model_id,
    selectedTeam,
    handleDefaultModel,
    handleExplicitModel,
    setForceOverride,
  ]);
}

export default useTeamPreferences;
