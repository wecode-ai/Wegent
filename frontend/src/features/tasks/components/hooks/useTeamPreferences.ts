// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useTeamPreferences Hook
 *
 * Manages team preference and synchronization logic:
 * - Restoring team preferences from localStorage
 * - Syncing team selection when viewing existing tasks
 * - Resetting state when clearVersion changes (New Chat)
 *
 * NOTE: Model selection logic has been moved to useModelSelection hook.
 * This hook now focuses solely on team preferences.
 */

import { useEffect, useRef } from 'react';
import type { Team, TaskDetail } from '@/types/api';

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
 * useTeamPreferences Hook
 *
 * Consolidates team preference logic:
 * - Restoring team preferences from localStorage
 * - Syncing team selection when viewing existing tasks
 * - Resetting state when clearVersion changes (New Chat)
 *
 * Model selection is now handled by useModelSelection hook in ModelSelector.
 */
export function useTeamPreferences({
  teams,
  hasMessages,
  selectedTaskDetail,
  selectedTeam,
  setSelectedTeam,
  hasRestoredPreferences,
  setHasRestoredPreferences,
  isTeamCompatibleWithMode,
  initialTeamIdRef,
  clearVersion,
}: UseTeamPreferencesOptions): void {
  // Refs for tracking previous values
  const prevClearVersionRef = useRef(clearVersion);

  // Compute detailTeamId
  const detailTeamId = selectedTaskDetail ? extractTeamId(selectedTaskDetail.team) : null;

  /**
   * Effect: Reset state when clearVersion changes (New Chat).
   */
  useEffect(() => {
    if (clearVersion !== prevClearVersionRef.current) {
      prevClearVersionRef.current = clearVersion;
      setHasRestoredPreferences(false);
    }
  }, [clearVersion, setHasRestoredPreferences]);

  /**
   * Effect: Restore team preferences from localStorage.
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
}

export default useTeamPreferences;
