import { useCallback } from 'react'

import type { RuntimeTaskComposerCreateOptions } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type {
  ProjectWithTasks,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
} from '@/types/api'

interface UseProjectRuntimeTaskComposerOptions {
  project: ProjectWithTasks | null
  deviceWorkspaceId?: number | null
  workspaceSource?: RuntimeTaskAddress | null
  taskRequest?: RuntimeTaskCreateRequest | null
  runtimeContext: Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'>
  prepareTask?: (
    address: RuntimeTaskAddress,
    project: ProjectWithTasks | null
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  onTaskCreated?: (
    address: RuntimeTaskAddress,
    project: ProjectWithTasks | null
  ) => Promise<void> | void
}

export function useProjectRuntimeTaskComposer({
  project,
  deviceWorkspaceId,
  workspaceSource,
  taskRequest,
  runtimeContext,
  prepareTask,
  onTaskCreated,
}: UseProjectRuntimeTaskComposerOptions) {
  const { createProjectRuntimeTask } = useWorkbenchPaneContext()

  return useCallback(
    async (message: string, options: RuntimeTaskComposerCreateOptions) => {
      const address = await createProjectRuntimeTask(message, {
        project,
        deviceWorkspaceId,
        workspaceSource,
        taskRequest,
        runtime: 'codex',
        attachments: options.attachments,
        optimisticUserMessage: options.optimisticUserMessage,
        executionModel: options.executionModel,
        collaborationMode: 'default',
        ...runtimeContext,
        onError: options.onError,
        prepareRuntimeTask: prepareTask ? address => prepareTask(address, project) : undefined,
        onRuntimeTaskOptimisticOpen: options.onRuntimeTaskOptimisticOpen,
      })
      if (address) {
        await onTaskCreated?.(address, project)
      }
      return address
    },
    [
      createProjectRuntimeTask,
      deviceWorkspaceId,
      onTaskCreated,
      prepareTask,
      project,
      runtimeContext,
      taskRequest,
      workspaceSource,
    ]
  )
}
