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
  panelActions: ReturnType<typeof useDesktopPanePanelActions>
) {
  const taskOwnerKey = useRuntimeTaskOwnerKey(
    paneContext.currentRuntimeTask,
    paneContext.state.devices
  )
  const defaultWorkItemPreviewProject = useMemo<CloudProject>(
    () => ({
      id: DEFAULT_WORK_ITEM_PROJECT_ID,
      public_id: DEFAULT_WORK_ITEM_PROJECT_ID,
      project_key: DEFAULT_WORK_ITEM_PROJECT_KEY,
      name: paneContext.t('workbench.default_work_item_board', '我的任务'),
      description: '',
      project_store: 'local',
      task_provider: 'local',
      provider_config: {},
      created_by_user_id: paneContext.state.user?.id ?? 0,
      status: 'active',
      tags: [],
      version: 1,
      created_at: '',
      updated_at: '',
      metadata: { system_kind: 'default_work_items' },
    }),
    [paneContext]
  )
  const currentWorkItemGuideProject =
    paneContext.boundCloudProject ??
    paneContext.pendingCloudProject ??
    paneContext.defaultProject ??
    (paneContext.defaultProjectSpace ? null : defaultWorkItemPreviewProject)
  const availableWorkItemProjects =
    paneContext.cloudProjects.length > 0
      ? paneContext.cloudProjects.filter(project => !isDefaultWorkItemProject(project))
      : currentWorkItemGuideProject
        ? isDefaultWorkItemProject(currentWorkItemGuideProject)
          ? []
          : [currentWorkItemGuideProject]
        : []
  const projectSpaceContext = currentWorkItemGuideProject ? (
    <WorkItemComposerGuide
      taskOwnerKey={taskOwnerKey}
      integrated
      toolbar={!paneContext.currentProjectSpaceRuntimeTask}
      project={currentWorkItemGuideProject}
      item={paneContext.boundCloudItem}
      api={paneContext.boundProjectSpaceApi}
      currentTask={paneContext.currentProjectSpaceRuntimeTask}
      projects={availableWorkItemProjects}
      onSelectProject={paneContext.handleSelectCloudProject}
      onRemoveProject={
        paneContext.currentProjectSpaceRuntimeTask
          ? paneContext.removeCloudProjectContext
          : paneContext.clearPendingProjectContext
      }
      goalPresent={Boolean(
        paneContext.currentProjectSpaceRuntimeTask &&
        paneContext.paneSession.goal &&
        !paneContext.paneSession.goalDraftActive
      )}
      refreshKey={
        paneContext.boundCloudItem
          ? `${paneContext.paneSession.status.taskExecution.running}:${paneContext.paneSession.status.taskExecution.status ?? ''}`
          : undefined
      }
      onOpen={
        paneContext.boundCloudItem ? () => panelActions.openRightPanelTab('work-item') : undefined
      }
      onOpenBoard={paneContext.boundCloudItem ? paneContext.openBoundProjectSpaceTask : undefined}
    />
  ) : null
  return { projectSpaceContext, availableWorkItemProjects }
}
