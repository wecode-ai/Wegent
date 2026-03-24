// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useCallback } from 'react'
import { useToast } from '@/hooks/use-toast'
import { useTranslation } from '@/hooks/useTranslation'
import {
  executeGraderTask,
  retryGraderTask,
  publishGraderTask,
  batchExecuteGraderTasks,
  batchPublishGraderTasks,
} from '@wecode/api/evaluation'

interface UseGradingActionsOptions {
  onSuccess?: () => void
}

interface UseGradingActionsReturn {
  executing: boolean
  publishing: boolean
  executeTask: (taskId: number, modelId?: string, forceOverride?: boolean) => Promise<void>
  retryTask: (taskId: number) => Promise<void>
  publishTask: (taskId: number) => Promise<void>
  batchExecute: (taskIds: number[]) => Promise<void>
  batchPublish: (taskIds: number[]) => Promise<void>
}

/**
 * Hook for managing grading task actions.
 * Provides execute, retry, publish, and batch operations with toast notifications.
 */
export function useGradingActions(options: UseGradingActionsOptions = {}): UseGradingActionsReturn {
  const { onSuccess } = options
  const { toast } = useToast()
  const { t } = useTranslation('evaluation')

  const [executing, setExecuting] = useState(false)
  const [publishing, setPublishing] = useState(false)

  const handleSuccess = useCallback(() => {
    onSuccess?.()
  }, [onSuccess])

  const executeTask = useCallback(
    async (taskId: number, modelId?: string, forceOverride?: boolean) => {
      setExecuting(true)
      try {
        const requestData = {
          model_id: modelId,
          force_override_bot_model: forceOverride,
        }
        await executeGraderTask(taskId, requestData)
        toast({
          title: t('grading.execute_success'),
          description: '',
        })
        handleSuccess()
      } catch (_error) {
        toast({
          title: t('errors.execute_failed'),
          description: '',
          variant: 'destructive',
        })
        throw _error
      } finally {
        setExecuting(false)
      }
    },
    [toast, t, handleSuccess]
  )

  const retryTask = useCallback(
    async (taskId: number) => {
      setExecuting(true)
      try {
        // Retry with topic's original config - graders cannot modify anything
        await retryGraderTask(taskId)
        toast({
          title: t('grading.execute_success'),
          description: '',
        })
        handleSuccess()
      } catch (_error) {
        toast({
          title: t('errors.retry_failed'),
          description: '',
          variant: 'destructive',
        })
        throw _error
      } finally {
        setExecuting(false)
      }
    },
    [toast, t, handleSuccess]
  )

  const publishTask = useCallback(
    async (taskId: number) => {
      setPublishing(true)
      try {
        await publishGraderTask(taskId)
        toast({
          title: t('grading.publish_success'),
          description: '',
        })
        handleSuccess()
      } catch (_error) {
        toast({
          title: t('errors.publish_failed'),
          description: '',
          variant: 'destructive',
        })
        throw _error
      } finally {
        setPublishing(false)
      }
    },
    [toast, t, handleSuccess]
  )

  const batchExecute = useCallback(
    async (taskIds: number[]) => {
      if (taskIds.length === 0) return

      setExecuting(true)
      try {
        const result = await batchExecuteGraderTasks(taskIds)
        toast({
          title: t('grading.execute_success'),
          description: `${result.executed_count} ${t('grading.tasks').toLowerCase()}`,
        })
        handleSuccess()
      } catch (_error) {
        toast({
          title: t('errors.execute_failed'),
          description: '',
          variant: 'destructive',
        })
        throw _error
      } finally {
        setExecuting(false)
      }
    },
    [toast, t, handleSuccess]
  )

  const batchPublish = useCallback(
    async (taskIds: number[]) => {
      if (taskIds.length === 0) return

      setPublishing(true)
      try {
        const result = await batchPublishGraderTasks(taskIds)
        toast({
          title: t('grading.publish_success'),
          description: `${result.published_count} ${t('grading.tasks').toLowerCase()}`,
        })
        handleSuccess()
      } catch (_error) {
        toast({
          title: t('errors.publish_failed'),
          description: '',
          variant: 'destructive',
        })
        throw _error
      } finally {
        setPublishing(false)
      }
    },
    [toast, t, handleSuccess]
  )

  return {
    executing,
    publishing,
    executeTask,
    retryTask,
    publishTask,
    batchExecute,
    batchPublish,
  }
}
