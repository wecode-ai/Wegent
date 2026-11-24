import { useRuntimeTaskOwnerKey } from '@/features/workbench/useRuntimeTaskOwnerKey'
import { useMemo } from 'react'
import { WorkItemComposerGuide } from '@/features/todo/WorkItemComposerGuide'
import {
  DEFAULT_WORK_ITEM_PROJECT_ID,
  DEFAULT_WORK_ITEM_PROJECT_KEY,
  isDefaultWorkItemProject,
  type CloudProject,
} from '@/api/deliveries'
import type { useDesktopPaneContext } from './useDesktopPaneContext'
import type { useDesktopPanePanelActions } from './useDesktopPanePanelActions'
export function useDesktopPaneProjectGuide(
  paneContext: ReturnType<typeof useDesktopPaneContext>,
  openRightPanelTab: ReturnType<typeof useDesktopPanePanelActions>['openRightPanelTab']
) {
  const taskOwnerKey = useRuntimeTaskOwnerKey(
    paneContext.currentRuntimeTask,
    paneContext.state.devices
  )
  const {
    t,
    cloudProjects,
    currentProjectSpaceRuntimeTask: task,
    boundCloudItem: item,
    boundProjectSpaceApi: api,
    handleSelectCloudProject: onSelectProject,
    removeCloudProjectContext,
    clearPendingProjectContext,
    openBoundProjectSpaceTask,
    paneSession: { goal, goalDraftActive, status },
  } = paneContext
  const userId = paneContext.state.user?.id ?? 0
  const defaultWorkItemPreviewProject = useMemo<CloudProject>(
    () => ({
      id: DEFAULT_WORK_ITEM_PROJECT_ID,
      public_id: DEFAULT_WORK_ITEM_PROJECT_ID,
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: t('workbench.default_work_item_board', '我的任务'),
      description: '',
      project_store: 'local',
      task_provider: 'local',
      provider_config: {},
      created_by_user_id: userId,
      status: 'active',
      tags: [],
      version: 1,
      created_at: '',
      updated_at: '',
      metadata: { system_kind: 'default_work_items' },
    }),
    [t, userId]
  )
  const currentWorkItemGuideProject =
    paneContext.boundCloudProject ??
    paneContext.pendingCloudProject ??
    paneContext.defaultProject ??
    (paneContext.defaultProjectSpace ? null : defaultWorkItemPreviewProject)
  const onRemoveProject = task ? removeCloudProjectContext : clearPendingProjectContext
  const onOpenBoard = item ? openBoundProjectSpaceTask : undefined
  const goalPresent = Boolean(task && goal && !goalDraftActive)
  const refreshKey = item
    ? `${status.taskExecution.running}:${status.taskExecution.status ?? ''}`
    : undefined
  return useMemo(() => {
    const project = currentWorkItemGuideProject
    if (!project) return null
    const projects = (cloudProjects.length ? cloudProjects : [project]).filter(
      candidate => !isDefaultWorkItemProject(candidate)
    )
    return (
      <WorkItemComposerGuide
        taskOwnerKey={taskOwnerKey}
        integrated
        toolbar={!task}
        project={project}
        item={item}
        api={api}
        currentTask={task}
        projects={projects}
        onSelectProject={onSelectProject}
        onRemoveProject={onRemoveProject}
        goalPresent={goalPresent}
        refreshKey={refreshKey}
        onOpen={item ? () => openRightPanelTab('work-item') : undefined}
        onOpenBoard={onOpenBoard}
      />
    )
  }, [
    currentWorkItemGuideProject,
    cloudProjects,
    taskOwnerKey,
    task,
    item,
    api,
    onSelectProject,
    onRemoveProject,
    goalPresent,
    refreshKey,
    openRightPanelTab,
    onOpenBoard,
  ])
}
