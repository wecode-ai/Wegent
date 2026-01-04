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
import { useSearchParams } from 'next/navigation';
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

  // Get taskId from URL to check if we're waiting for task detail to load
  // Support multiple parameter formats for backward compatibility
  const searchParams = useSearchParams();
  const taskIdFromUrl =
    searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid');

  // Track the taskId we're waiting for to detect if it changes
  const waitingForTaskIdRef = useRef<string | null>(null);

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
   *
   * IMPORTANT: If URL has taskId but selectedTaskDetail hasn't loaded yet,
   * we should wait for the task detail to load before restoring preferences.
   * This prevents showing the wrong team when navigating between chat/code pages.
   *
   * A timeout (3 seconds) is used as a fallback in case task detail fails to load.
   */
  useEffect(() => {
    if (hasRestoredPreferences || !teams.length || (!selectedTaskDetail && hasMessages)) {
      return;
    }

    // Helper function to restore from localStorage
    const restoreFromLocalStorage = () => {
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
    };

    // If URL has taskId but task detail hasn't loaded yet, wait for it
    // Use a timeout (3s) as fallback in case task detail fails to load
    if (taskIdFromUrl && !selectedTaskDetail) {
      // Start waiting for this taskId
      if (waitingForTaskIdRef.current !== taskIdFromUrl) {
        waitingForTaskIdRef.current = taskIdFromUrl;
      }

      const timeoutId = setTimeout(() => {
        // Only fallback if we're still waiting for the same taskId and preferences not restored
        if (waitingForTaskIdRef.current === taskIdFromUrl && !hasRestoredPreferences) {
          console.warn(
            '[useTeamPreferences] Task detail load timeout, falling back to localStorage'
          );
          restoreFromLocalStorage();
        }
      }, 3000);

      return () => clearTimeout(timeoutId);
    }

    // Clear waiting state when task detail is loaded
    waitingForTaskIdRef.current = null;

    // Normal restoration logic
    restoreFromLocalStorage();
  }, [
    teams,
    hasRestoredPreferences,
    hasMessages,
    selectedTaskDetail,
    isTeamCompatibleWithMode,
    initialTeamIdRef,
    setSelectedTeam,
    setHasRestoredPreferences,
    taskIdFromUrl,
  ]);

  /**
   * Effect: Sync team selection when viewing existing task.
   */
  useEffect(() => {
    if (!detailTeamId) {
      return;
    }

    // Skip sync if there's no taskId in URL
    // This means user switched modes without a specific task, so we should use localStorage preference
    if (!taskIdFromUrl) {
      return;
    }

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
    taskIdFromUrl,
  ]);
}

export default useTeamPreferences;
