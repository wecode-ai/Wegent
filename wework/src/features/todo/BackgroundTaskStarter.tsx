import { useEffect, useMemo, useRef } from 'react'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { resolveRuntimeTaskProjects } from '@/lib/runtime-project'
import { runtimeTaskProjectUiId } from '@/lib/runtime-task-workspace-binding'
import type { ProjectWithTasks, RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import { useProjectRuntimeTaskComposer } from './useProjectRuntimeTaskComposer'
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'

interface BackgroundTaskStarterProps {
  project: CloudProject
  localProjects: ProjectWithTasks[]
  task: CloudLoopItem
  input: string
  initialLocalProjectId?: number | null
  taskRequest?: RuntimeTaskCreateRequest | null
  inheritFromTask?: RuntimeTaskAddress | null
  workflowNodeId?: string
  prepareTask?: (
    address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null
  ) => void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>
  onTaskCreated?: (
    address: RuntimeTaskAddress,
    localProject: ProjectWithTasks | null
  ) => Promise<void> | void
  onAddressChange: (address: RuntimeTaskAddress) => void
  onError: (message: string) => void
}

export function BackgroundTaskStarter({
  project,
  localProjects,
  task,
  input,
  initialLocalProjectId = null,
  taskRequest = null,
  inheritFromTask = null,
  workflowNodeId,
  prepareTask,
  onTaskCreated,
  onAddressChange,
  onError,
}: BackgroundTaskStarterProps) {
  const { state } = useWorkbenchPaneContext()
  const startedRef = useRef(false)
  const addressReportedRef = useRef(false)
  const runtimeTaskProjects = useMemo(
    () => resolveRuntimeTaskProjects(localProjects, state?.runtimeWork),
    [localProjects, state?.runtimeWork]
  )
  const selectedLocalProject = useMemo(() => {
    const requestedProjectId = runtimeTaskProjectUiId(state?.runtimeWork, taskRequest)
    return (
      runtimeTaskProjects.find(candidate => candidate.id === requestedProjectId) ??
      runtimeTaskProjects.find(candidate => candidate.id === initialLocalProjectId) ??
      runtimeTaskProjects.find(candidate => String(candidate.id) === String(project.id)) ??
      runtimeTaskProjects[0] ??
      null
    )
  }, [initialLocalProjectId, project.id, runtimeTaskProjects, state?.runtimeWork, taskRequest])
  const runtimeContext = useMemo(
    () => buildWorkItemRuntimeContext(project, task, workflowNodeId),
    [project, task, workflowNodeId]
  )
  const createConversation = useProjectRuntimeTaskComposer({
    project: selectedLocalProject,
    workspaceSource: inheritFromTask,
    taskRequest,
    runtimeContext,
    prepareTask,
    onTaskCreated,
  })

  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    const reportAddress = (address: RuntimeTaskAddress) => {
      if (addressReportedRef.current) return
      addressReportedRef.current = true
      onAddressChange(address)
    }
    void createConversation(input, {
      attachments: [],
      executionModel: {},
      optimisticUserMessage: createRuntimeUserMessage(input, []),
      onError,
      onRuntimeTaskOptimisticOpen: reportAddress,
    }).then(address => {
      if (address) reportAddress(address)
    })
  }, [createConversation, input, onAddressChange, onError])

  return null
}
