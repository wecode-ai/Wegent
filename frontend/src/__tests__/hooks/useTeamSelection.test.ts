// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for useTeamSelection hook
 *
 * This test suite validates the team selection logic including:
 * - Team filtering by bind_mode (chat/code)
 * - Priority-based team selection (task detail > mode change > localStorage)
 * - Race condition prevention when switching between sessions
 * - localStorage persistence and restoration
 * - Compatibility checking
 */

import { renderHook, act, waitFor } from '@testing-library/react'
import { useTeamSelection } from '@/features/tasks/hooks/useTeamSelection'
import type { Team, TaskDetail, User } from '@/types/api'
import * as userPreferences from '@/utils/userPreferences'

// Mock next/navigation
const mockSearchParams = new URLSearchParams()
jest.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
}))

// Mock userPreferences
jest.mock('@/utils/userPreferences', () => ({
  getLastTeamIdByMode: jest.fn(),
  saveLastTeamByMode: jest.fn(),
  saveLastRepo: jest.fn(),
}))

describe('useTeamSelection', () => {
  // Helper functions to create test data
  const createTeam = (
    id: number,
    name: string,
    bindMode: ('chat' | 'code')[] | null = ['chat', 'code']
  ): Team => ({
    id,
    name,
    namespace: 'default',
    description: '',
    icon: 'team',
    agent_type: 'claude',
    bind_mode: bindMode ?? undefined,
    share_status: 0,
    user_id: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    bots: [],
    workflow: {},
    is_active: true,
  })

  const createTaskDetail = (id: number, teamId: number, teamName: string): TaskDetail => ({
    id,
    title: `Task ${id}`,
    team: { id: teamId, name: teamName } as Team,
    git_url: '',
    git_repo: '',
    git_repo_id: 0,
    git_domain: '',
    branch_name: '',
    prompt: '',
    status: 'RUNNING',
    task_type: 'chat',
    progress: 0,
    batch: 0,
    result: {},
    error_message: '',
    user: { id: 1, user_name: 'test' } as User,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: '',
    is_group_chat: false,
    subtasks: [],
  })

  // Common test data
  const teamChat = createTeam(1, 'Chat Team', ['chat'])
  const teamCode = createTeam(2, 'Code Team', ['code'])
  const teamBoth = createTeam(3, 'Both Team', ['chat', 'code'])
  const teamEmpty = createTeam(4, 'Empty Team', [])
  const teamNull = createTeam(5, 'Null Team', null)

  beforeEach(() => {
    jest.clearAllMocks()
    mockSearchParams.delete('taskId')
    mockSearchParams.delete('task_id')
    mockSearchParams.delete('taskid')
    ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValue(null)
  })

  describe('Team Filtering by bind_mode', () => {
    it('should filter teams by chat mode', () => {
      const teams = [teamChat, teamCode, teamBoth]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      expect(result.current.filteredTeams).toHaveLength(2)
      expect(result.current.filteredTeams.map(t => t.id)).toEqual([1, 3]) // Chat Team, Both Team
    })

    it('should filter teams by code mode', () => {
      const teams = [teamChat, teamCode, teamBoth]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'code',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      expect(result.current.filteredTeams).toHaveLength(2)
      expect(result.current.filteredTeams.map(t => t.id)).toEqual([2, 3]) // Code Team, Both Team
    })

    it('should filter out teams with empty bind_mode array', () => {
      const teams = [teamChat, teamEmpty]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      expect(result.current.filteredTeams).toHaveLength(1)
      expect(result.current.filteredTeams[0].id).toBe(1)
    })

    it('should include teams with null bind_mode in all modes', () => {
      const teams = [teamChat, teamNull]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'code',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      expect(result.current.filteredTeams).toHaveLength(1)
      expect(result.current.filteredTeams[0].id).toBe(5) // Null Team included
    })
  })

  describe('Priority 1: Task Detail Sync', () => {
    it('should sync team from task detail when taskId matches URL', async () => {
      const teams = [teamChat, teamCode]
      const taskDetail = createTaskDetail(100, 1, 'Chat Team')
      mockSearchParams.set('taskId', '100')

      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: taskDetail,
          hasMessages: true,
          disabled: false,
          clearVersion: 0,
        })
      )

      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(1)
        expect(result.current.hasRestoredPreferences).toBe(true)
      })
    })

    it('should NOT sync from task detail when taskId does not match URL (prevents race condition)', async () => {
      const teams = [teamChat, teamCode]
      const taskDetail = createTaskDetail(100, 1, 'Chat Team')
      mockSearchParams.set('taskId', '200') // Different taskId

      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: taskDetail,
          hasMessages: true,
          disabled: false,
          clearVersion: 0,
        })
      )

      // Should NOT sync because taskIds don't match
      await waitFor(() => {
        expect(result.current.selectedTeam).toBeNull()
      })
    })

    it('should wait for correct task detail before syncing', async () => {
      const teams = [teamChat, teamCode]
      mockSearchParams.set('taskId', '200')

      const { result, rerender } = renderHook(
        ({ taskDetail }) =>
          useTeamSelection({
            teams,
            currentMode: 'chat',
            selectedTaskDetail: taskDetail,
            hasMessages: true,
            disabled: false,
            clearVersion: 0,
          }),
        {
          initialProps: { taskDetail: createTaskDetail(100, 1, 'Chat Team') },
        }
      )

      // Initially should not sync (wrong taskId)
      expect(result.current.selectedTeam).toBeNull()

      // Update with correct task detail
      rerender({ taskDetail: createTaskDetail(200, 2, 'Code Team') })

      // Now should sync
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(2)
      })
    })

    it('should use team object from detail if not found in filtered list', async () => {
      const teams = [teamChat]
      const taskDetail = createTaskDetail(100, 2, 'Code Team')
      taskDetail.team = teamCode // Full team object in detail
      mockSearchParams.set('taskId', '100')

      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: taskDetail,
          hasMessages: true,
          disabled: false,
          clearVersion: 0,
        })
      )

      // Should use team object from detail even if not in filtered list
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(2)
      })
    })
  })

  describe('Priority 2: Mode Change Validation', () => {
    it('should keep compatible team when mode changes', async () => {
      const teams = [teamBoth]
      ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValue(3)

      const { result, rerender } = renderHook(
        ({ mode }) =>
          useTeamSelection({
            teams,
            currentMode: mode,
            selectedTaskDetail: null,
            hasMessages: false,
            disabled: false,
            clearVersion: 0,
          }),
        {
          initialProps: { mode: 'chat' as 'chat' | 'code' },
        }
      )

      // Initial selection
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(3)
      })

      // Change mode
      act(() => {
        rerender({ mode: 'code' })
      })

      // Should keep the same team (compatible with both modes)
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(3)
      })
    })

    it('should re-select team when mode changes and current team is incompatible', async () => {
      const teams = [teamChat, teamCode]
      ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValueOnce(1) // chat
      ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValueOnce(2) // code

      const { result, rerender } = renderHook(
        ({ mode }) =>
          useTeamSelection({
            teams,
            currentMode: mode,
            selectedTaskDetail: null,
            hasMessages: false,
            disabled: false,
            clearVersion: 0,
          }),
        {
          initialProps: { mode: 'chat' as 'chat' | 'code' },
        }
      )

      // Initial selection (chat mode)
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(1)
      })

      // Change to code mode
      act(() => {
        rerender({ mode: 'code' })
      })

      // Should auto-select first compatible team in code mode
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(2)
      })
    })
  })

  describe('Priority 3: localStorage Restoration', () => {
    it('should restore team from localStorage on initial load', async () => {
      const teams = [teamChat, teamCode]
      ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValue(2)

      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'code',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(2)
        expect(result.current.hasRestoredPreferences).toBe(true)
      })
    })

    it('should fallback to first team if localStorage team is not found', async () => {
      const teams = [teamChat, teamCode]
      ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValue(999) // Non-existent team

      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(1)
      })
    })

    it('should NOT restore from localStorage when viewing existing task', async () => {
      const teams = [teamChat, teamCode]
      const taskDetail = createTaskDetail(100, 2, 'Code Team')
      mockSearchParams.set('taskId', '100')
      ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValue(1) // Different team in localStorage

      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: taskDetail,
          hasMessages: true,
          disabled: false,
          clearVersion: 0,
        })
      )

      // Should use team from task detail (2), not localStorage (1)
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(2)
      })
    })
  })

  describe('localStorage Persistence', () => {
    it('should save team selection to localStorage', async () => {
      const teams = [teamChat, teamCode]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      // Wait for initial restore
      await waitFor(() => {
        expect(result.current.selectedTeam).not.toBeNull()
      })

      // Manually select a team
      act(() => {
        result.current.selectTeam(teamCode)
      })

      // Should save to localStorage
      await waitFor(() => {
        expect(userPreferences.saveLastTeamByMode).toHaveBeenCalledWith(2, 'chat')
      })
    })

    it('should NOT save to localStorage during restore', async () => {
      const teams = [teamChat]
      ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValue(1)

      renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      // Wait for restore to complete
      await waitFor(() => {
        // saveLastTeamByMode should NOT be called during restore
        expect(userPreferences.saveLastTeamByMode).not.toHaveBeenCalled()
      })
    })
  })

  describe('Clear Version (New Chat Detection)', () => {
    it('should reset preferences when clearVersion changes', async () => {
      const teams = [teamChat]
      ;(userPreferences.getLastTeamIdByMode as jest.Mock).mockReturnValue(1)

      const { result, rerender } = renderHook(
        ({ clearVersion }) =>
          useTeamSelection({
            teams,
            currentMode: 'chat',
            selectedTaskDetail: null,
            hasMessages: false,
            disabled: false,
            clearVersion,
          }),
        {
          initialProps: { clearVersion: 0 },
        }
      )

      // Wait for initial restore
      await waitFor(() => {
        expect(result.current.hasRestoredPreferences).toBe(true)
      })

      // Simulate "New Chat" action by changing clearVersion
      act(() => {
        rerender({ clearVersion: 1 })
      })

      // Should reset hasRestoredPreferences
      await waitFor(() => {
        expect(result.current.hasRestoredPreferences).toBe(false)
      })
    })
  })

  describe('Edge Cases', () => {
    it('should handle empty teams array', () => {
      const { result } = renderHook(() =>
        useTeamSelection({
          teams: [],
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      expect(result.current.filteredTeams).toEqual([])
      expect(result.current.selectedTeam).toBeNull()
    })

    it('should handle null selectedTaskDetail', () => {
      const teams = [teamChat]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      expect(result.current.selectedTeam).not.toBeNull()
    })

    it('should handle task detail with number team field', async () => {
      const teams = [teamChat]
      const taskDetail = createTaskDetail(100, 1, 'Chat Team')
      taskDetail.team = 1 as unknown as Team // Number instead of object
      mockSearchParams.set('taskId', '100')

      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: taskDetail,
          hasMessages: true,
          disabled: false,
          clearVersion: 0,
        })
      )

      // Should still sync by team ID
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(1)
      })
    })

    it('should handle all teams filtered out by bind_mode', () => {
      const teams = [teamChat]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'code', // No chat team supports code mode
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      expect(result.current.filteredTeams).toEqual([])
      expect(result.current.selectedTeam).toBeNull()
    })
  })

  describe('Helper Functions', () => {
    it('isTeamCompatibleWithMode should correctly check compatibility', () => {
      const teams = [teamChat, teamCode, teamBoth, teamEmpty, teamNull]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      expect(result.current.isTeamCompatibleWithMode(teamChat)).toBe(true)
      expect(result.current.isTeamCompatibleWithMode(teamCode)).toBe(false)
      expect(result.current.isTeamCompatibleWithMode(teamBoth)).toBe(true)
      expect(result.current.isTeamCompatibleWithMode(teamEmpty)).toBe(false)
      expect(result.current.isTeamCompatibleWithMode(teamNull)).toBe(false)
    })

    it('selectTeam should update selected team', async () => {
      const teams = [teamChat, teamCode]
      const { result } = renderHook(() =>
        useTeamSelection({
          teams,
          currentMode: 'chat',
          selectedTaskDetail: null,
          hasMessages: false,
          disabled: false,
          clearVersion: 0,
        })
      )

      act(() => {
        result.current.selectTeam(teamCode)
      })

      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(2)
      })
    })
  })

  describe('Race Condition Prevention', () => {
    it('should prevent stale task detail from overwriting correct team (the main bug fix)', async () => {
      const teams = [teamChat, teamCode]

      // Simulate: User is on Task 100 (team 1), clicks Task 200 (team 2)
      // But API is slow, so task detail for 100 is still in state

      mockSearchParams.set('taskId', '200')
      const staleTaskDetail = createTaskDetail(100, 1, 'Chat Team')

      const { result, rerender } = renderHook(
        ({ taskDetail }) =>
          useTeamSelection({
            teams,
            currentMode: 'chat',
            selectedTaskDetail: taskDetail,
            hasMessages: true,
            disabled: false,
            clearVersion: 0,
          }),
        {
          initialProps: { taskDetail: staleTaskDetail },
        }
      )

      // Should NOT sync because taskId (100) doesn't match URL (200)
      await waitFor(() => {
        expect(result.current.selectedTeam).toBeNull()
      })

      // Simulate API response for Task 200
      const correctTaskDetail = createTaskDetail(200, 2, 'Code Team')
      act(() => {
        rerender({ taskDetail: correctTaskDetail })
      })

      // NOW should sync with correct team
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(2)
      })
    })

    it('should handle rapid task switching', async () => {
      const teams = [teamChat, teamCode, teamBoth]

      mockSearchParams.set('taskId', '100')
      const task100 = createTaskDetail(100, 1, 'Chat Team')
      const task200 = createTaskDetail(200, 2, 'Code Team')
      const task300 = createTaskDetail(300, 3, 'Both Team')

      const { result, rerender } = renderHook(
        ({ taskDetail, taskId }) => {
          mockSearchParams.set('taskId', taskId)
          return useTeamSelection({
            teams,
            currentMode: 'chat',
            selectedTaskDetail: taskDetail,
            hasMessages: true,
            disabled: false,
            clearVersion: 0,
          })
        },
        {
          initialProps: { taskDetail: task100, taskId: '100' },
        }
      )

      // Initial selection
      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(1)
      })

      // Rapidly switch to task 200
      act(() => {
        rerender({ taskDetail: task200, taskId: '200' })
      })

      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(2)
      })

      // Rapidly switch to task 300
      act(() => {
        rerender({ taskDetail: task300, taskId: '300' })
      })

      await waitFor(() => {
        expect(result.current.selectedTeam?.id).toBe(3)
      })
    })
  })
})
