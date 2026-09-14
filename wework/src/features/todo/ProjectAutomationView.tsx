import { useMemo } from 'react'
import type { CloudProject } from '@/api/deliveries'
import type { createProjectIncomingHookApi } from '@/api/projectIncomingHooks'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import {
  createSharedWorkspaceAutomationPorts,
  ProjectAutomationRulesView,
} from '@wegent/collaboration/automation-ui'
import type { SharedWorkspaceApi } from '@wegent/collaboration'
import { createWeworkAutomationSharedWorkspaceApi } from '@/features/collaboration'
import { weworkAutomationUiHost } from './weworkAutomationUiHost'

interface ProjectAutomationViewProps {
  api?: NonNullable<WorkbenchServices['deliveryApi']>
  workspaceApi?: SharedWorkspaceApi
  project: CloudProject
  projectAgents?: Array<{ id: string; name: string }>
  projectAutomationApi?: WorkbenchServices['projectAutomationApi']
  projectIncomingHookApi?: ReturnType<typeof createProjectIncomingHookApi>
  currentUserId?: string | number
  canManageAgents: boolean
  onProjectUpdated?: (project: CloudProject) => void
  onOpenIssue?: (issueId: string) => void
}

export function ProjectAutomationView({
  api,
  workspaceApi,
  project,
  projectAgents = [],
  projectAutomationApi,
  projectIncomingHookApi,
  currentUserId = project.current_user_id,
  canManageAgents,
  onProjectUpdated,
  onOpenIssue,
}: ProjectAutomationViewProps) {
  const { i18n } = useTranslation('common')
  const projectId = String(project.id)
  const automationWorkspaceApi = useMemo(() => {
    if (workspaceApi) return workspaceApi
    if (!api) return null
    return createWeworkAutomationSharedWorkspaceApi(
      api,
      projectAutomationApi,
      projectIncomingHookApi
    )
  }, [api, projectAutomationApi, projectIncomingHookApi, workspaceApi])
  const sharedPorts = useMemo(
    () =>
      automationWorkspaceApi
        ? createSharedWorkspaceAutomationPorts<CloudProject>(automationWorkspaceApi)
        : null,
    [automationWorkspaceApi]
  )

  if (!sharedPorts) return null

  return (
    <ProjectAutomationRulesView
      automationApi={sharedPorts.automationApi}
      automationCacheSource={workspaceApi ?? projectAutomationApi}
      projectApi={sharedPorts.projectApi}
      incomingHooksApi={sharedPorts.incomingHooksApi}
      locale={i18n.language}
      uiHost={weworkAutomationUiHost}
      project={project}
      projectAgents={projectAgents}
      currentUserId={currentUserId}
      canManage={canManageAgents}
      onProjectUpdated={onProjectUpdated}
      onOpenIssue={onOpenIssue}
      onRunRefreshError={refreshError => {
        console.error('[Wework project automation] run history refresh failed', {
          projectId,
          error: refreshError,
        })
      }}
    />
  )
}
