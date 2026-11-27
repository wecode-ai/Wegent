import { useMemo } from 'react'

import type { RuntimeTaskComposerCreateOptions } from '@/types/workbench'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import type {
  ProjectWithTasks,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeTaskCreateRequest,
} from '@/types/api'

export interface UseProjectRuntimeTaskComposerOptions {
  resolveDeviceId?: () => Promise<string>
  resolveTaskInput?: (message: string) => Promise<{ message: string; wegentTeamId?: number }>
  project: ProjectWithTasks | null
  deviceWorkspaceId?: number | null
  workspaceExecution?: RuntimeTaskCreateRequest['execution'] | null
  workspaceSource?: RuntimeTaskAddress | null
  taskRequest?: RuntimeTaskCreateRequest | null
  runtimeContext: Pick<RuntimeSendRequest, 'cloudProjectId' | 'origin' | 'additionalContext'>
  prepareTask?: (
    address: RuntimeTaskAddress,
    project: ProjectWithTasks | null
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  onTaskCreated?: (
    address: RuntimeTaskAddress,
    project: ProjectWithTasks | null,
    deviceWorkspaceId: number | null
  ) => Promise<void> | void
}

export function createProjectRuntimeTaskComposer(
  createProjectRuntimeTask: ReturnType<typeof useWorkbenchPaneContext>['createProjectRuntimeTask'],
  {
    resolveDeviceId,
    resolveTaskInput,
    project,
    deviceWorkspaceId,
    workspaceExecution,
    workspaceSource,
    taskRequest,
    runtimeContext,
    prepareTask,
    onTaskCreated,
  }: UseProjectRuntimeTaskComposerOptions
) {
  return async (message: string, options: RuntimeTaskComposerCreateOptions) => {
    let deviceId: string | undefined
    let input: { message: string; wegentTeamId?: number } = { message }
    try {
      deviceId = await resolveDeviceId?.()
      if (resolveTaskInput) input = await resolveTaskInput(message)
    } catch (cause) {
      options.onError(cause instanceof Error ? cause.message : String(cause))
      return false
    }
    const address = await createProjectRuntimeTask(input.message, {
      ...(input.wegentTeamId ? { wegentTeamId: input.wegentTeamId } : {}),
      project,
      deviceWorkspaceId,
      ...(deviceId ? { deviceId, deviceWorkspaceId: null } : {}),
      ...(workspaceExecution !== undefined ? { workspaceExecution } : {}),
      workspaceSource,
      ...(taskRequest !== undefined ? { taskRequest } : {}),
      runtime: 'codex',
      attachments: options.attachments,
      ...(options.initialGoal ? { initialGoal: options.initialGoal } : {}),
      optimisticUserMessage: options.optimisticUserMessage,
      executionModel: options.executionModel,
      collaborationMode: 'default',
      ...runtimeContext,
      onError: options.onError,
      prepareRuntimeTask: prepareTask ? address => prepareTask(address, project) : undefined,
      onRuntimeTaskOptimisticOpen: options.onRuntimeTaskOptimisticOpen,
    })
    if (address) {
      await onTaskCreated?.(address, project, deviceWorkspaceId ?? null)
    }
    return address
  }
}

export function useProjectRuntimeTaskComposer(options: UseProjectRuntimeTaskComposerOptions) {
  const { createProjectRuntimeTask } = useWorkbenchPaneContext()
  const {
    resolveDeviceId,
    resolveTaskInput,
    project,
    deviceWorkspaceId,
    workspaceExecution,
    workspaceSource,
    taskRequest,
    runtimeContext,
    prepareTask,
    onTaskCreated,
  } = options
  return useMemo(
    () =>
      createProjectRuntimeTaskComposer(createProjectRuntimeTask, {
        resolveDeviceId,
        resolveTaskInput,
        project,
        deviceWorkspaceId,
        workspaceExecution,
        workspaceSource,
        taskRequest,
        runtimeContext,
        prepareTask,
        onTaskCreated,
      }),
    [
      createProjectRuntimeTask,
      resolveDeviceId,
      resolveTaskInput,
      project,
      deviceWorkspaceId,
      workspaceExecution,
      workspaceSource,
      taskRequest,
      runtimeContext,
      prepareTask,
      onTaskCreated,
    ]
  )
}
