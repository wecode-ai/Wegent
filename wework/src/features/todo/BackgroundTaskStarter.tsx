import { useEffect, useMemo, useRef } from 'react'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { createRuntimeUserMessage } from '@/features/workbench/runtimeUserMessage'
import type { ProjectWithTasks, RuntimeTaskAddress } from '@/types/api'
import { useProjectRuntimeTaskComposer } from './useProjectRuntimeTaskComposer'
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'

interface BackgroundTaskStarterProps {
  project: CloudProject
  localProjects: ProjectWithTasks[]
  task: CloudLoopItem
  input: string
  initialLocalProjectId?: number | null
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
  inheritFromTask = null,
  workflowNodeId,
  prepareTask,
  onTaskCreated,
  onAddressChange,
  onError,
}: BackgroundTaskStarterProps) {
  const startedRef = useRef(false)
  const addressReportedRef = useRef(false)
  const selectedLocalProject = useMemo(
    () =>
      localProjects.find(candidate => candidate.id === initialLocalProjectId) ??
      localProjects.find(candidate => String(candidate.id) === String(project.id)) ??
      localProjects[0] ??
      null,
    [initialLocalProjectId, localProjects, project.id]
  )
  const runtimeContext = useMemo(
    () => buildWorkItemRuntimeContext(project, task, workflowNodeId),
    [project, task, workflowNodeId]
  )
  const createConversation = useProjectRuntimeTaskComposer({
    project: selectedLocalProject,
    workspaceSource: inheritFromTask,
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
