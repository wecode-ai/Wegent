// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useRef, useEffect } from 'react'
import { useSocket } from '@/contexts/SocketContext'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import type { SkillRef, UseSkillSelectorReturn } from './useSkillSelector'

interface UseSkillUpdateOptions {
  /** Current task ID (undefined for new chats) */
  taskId: number | undefined
  /** Skill selector instance */
  skillSelector: UseSkillSelectorReturn
}

interface UseSkillUpdateReturn {
  /** Toggle skill with automatic WebSocket update for active tasks */
  toggleSkill: (skillName: string) => void
  /** Add skill with automatic WebSocket update for active tasks */
  addSkill: (skillName: string) => void
  /** Remove skill with automatic WebSocket update for active tasks */
  removeSkill: (skillName: string) => void
}

/**
 * Hook for managing skill updates with WebSocket synchronization.
 *
 * When skills are modified in an active conversation, this hook automatically
 * emits a `skill:update` WebSocket event to sync the skill configuration
 * with the backend.
 *
 * For Chat Shell tasks:
 * - Skills are stored in task metadata and read at next AI response
 *
 * For other shell types (ClaudeCode, Agno) on local devices:
 * - Skills are stored in task metadata
 * - Backend emits skill:sync to device to download new skills
 */
export function useSkillUpdate({
  taskId,
  skillSelector,
}: UseSkillUpdateOptions): UseSkillUpdateReturn {
  const { t } = useTranslation('chat')
  const { toast } = useToast()
  const { updateTaskSkills, isConnected } = useSocket()

  // Track previous skills to detect changes
  const prevSkillsRef = useRef<SkillRef[]>([])
  // Track if initial sync has been done (to avoid toast on initial load)
  const initialSyncDoneRef = useRef(false)

  /**
   * Send skill update to backend via WebSocket
   */
  const sendSkillUpdate = useCallback(
    async (skills: SkillRef[]) => {
      if (!taskId || !isConnected) {
        return
      }

      console.log('[useSkillUpdate] Sending skill update:', { taskId, skills })

      const result = await updateTaskSkills(taskId, skills)

      if (result.success) {
        toast({
          title: t('skill_update_success'),
          duration: 2000,
        })
      } else {
        console.error('[useSkillUpdate] Failed to update skills:', result.error)
        toast({
          title: t('skill_update_error'),
          description: result.error,
          variant: 'destructive',
          duration: 3000,
        })
      }
    },
    [taskId, isConnected, updateTaskSkills, toast, t]
  )

  // Monitor skill changes and emit update for active tasks
  useEffect(() => {
    // Skip if no task
    if (!taskId) {
      initialSyncDoneRef.current = false
      prevSkillsRef.current = []
      return
    }

    const currentSkills = skillSelector.selectedSkills

    // Skip initial sync (when first loading a task)
    if (!initialSyncDoneRef.current) {
      initialSyncDoneRef.current = true
      prevSkillsRef.current = currentSkills
      return
    }

    // Check if skills actually changed
    const prevSkillNames = new Set(prevSkillsRef.current.map(s => s.name))
    const currentSkillNames = new Set(currentSkills.map(s => s.name))

    const hasChanges =
      prevSkillNames.size !== currentSkillNames.size ||
      [...prevSkillNames].some(name => !currentSkillNames.has(name))

    if (hasChanges) {
      sendSkillUpdate(currentSkills)
      prevSkillsRef.current = currentSkills
    }
  }, [taskId, skillSelector.selectedSkills, sendSkillUpdate])

  // Reset initial sync flag when task changes
  useEffect(() => {
    initialSyncDoneRef.current = false
    prevSkillsRef.current = []
  }, [taskId])

  // Wrap skill operations to trigger update
  const toggleSkill = useCallback(
    (skillName: string) => {
      skillSelector.toggleSkill(skillName)
    },
    [skillSelector]
  )

  const addSkill = useCallback(
    (skillName: string) => {
      skillSelector.addSkill(skillName)
    },
    [skillSelector]
  )

  const removeSkill = useCallback(
    (skillName: string) => {
      skillSelector.removeSkill(skillName)
    },
    [skillSelector]
  )

  return {
    toggleSkill,
    addSkill,
    removeSkill,
  }
}

export type { UseSkillUpdateReturn }
