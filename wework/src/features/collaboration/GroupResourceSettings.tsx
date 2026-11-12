import { Activity, useMemo, useState } from 'react'
import {
  ProjectCollaborationGroups,
  ProjectAutomaticProcessing,
} from '@wegent/collaboration/project-manage'
import { Button } from '@/components/ui/button'
import { createGroupWorkspaceApi } from './groupWorkspaceApi'
import { GroupExecutionDevices } from './GroupExecutionDevices'
import {
  createCollaborationTranslator,
  ProjectAgentConfiguration,
  type CollaborationTranslate,
} from '@wegent/collaboration'
import type { ChatGroup } from '@/api/chatGroups'
import { groupWorkContainer } from '@/api/groupWorkContainer'
import { localAgentResourceContext } from '@/api/local/localAgentResourceContext'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { GroupSource } from './CollaborationGroupsSurface'
import { createWeworkProjectAgentConfigurationHost } from './WeworkProjectAgentConfigurationHost'

const groupLabels: Record<string, string> = {
  'todo.add_to_project': 'addToGroup',
  'todo.add_project_agent_description': 'groupAgentShareDescription',
  'todo.project_agents': 'groupAgentsTitle',
  'todo.project_agents_description': 'groupAgentsDescription',
  'todo.no_project_agents': 'noGroupAgents',
  'todo.agent_picker_description': 'groupAgentPickerDescription',
  'todo.load_project_agents_failed': 'groupAgentsLoadFailed',
  'todo.create_project_agent_failed': 'groupAgentCreateFailed',
  'todo.update_project_agent_failed': 'groupAgentUpdateFailed',
  'todo.archive_project_agent_failed': 'groupAgentArchiveFailed',
  'todo.automatic_processing_description': 'groupAutomaticProcessingDescription',
  'todo.project_members': 'groupMembers',
  'todo.automatic_processing_unavailable': 'groupAutomationUnavailable',
  'todo.automatic_processing_runner_hint': 'groupAutomationRunnerHint',
  'todo.project_available_environments': 'groupDevicesTitle',
  'todo.no_project_execution_environments': 'groupDevicesEmpty',
  'todo.execution_environment_empty_hint': 'groupDevicesHint',
  'todo.select_execution_device': 'groupDevicesSelect',
  'todo.select_project_environment': 'groupDevicesConsent',
  'todo.no_available_execution_environments': 'groupDevicesNoneAvailable',
}

export function GroupResourceSettings({
  group,
  source,
  services,
  locale,
  onChanged,
  currentUserId,
}: {
  group: ChatGroup
  source: GroupSource
  services: WorkbenchServices
  locale: 'zh-CN' | 'en'
  currentUserId: number
  onChanged(): void
}) {
  const { t } = useTranslation('collaboration')
  const [tab, setTab] = useState<'agents' | 'crews' | 'devices' | 'automation'>('agents')
  const api = useMemo(
    () =>
      createGroupWorkspaceApi(source.workspace, source.groups, group.id, source.store, onChanged),
    [source.workspace, source.groups, source.store, group.id, onChanged]
  )
  const work = useMemo(() => groupWorkContainer(group, source.store), [group, source.store])
  const canManage =
    group.status === 'active' && (group.role === 'Owner' || group.role === 'Maintainer')

  const translate = useMemo(() => {
    const shared = createCollaborationTranslator(locale)
    const localized: CollaborationTranslate = (key, fallback, options) =>
      groupLabels[key] ? t(groupLabels[key], options) : shared(key, fallback, options)
    localized.locale = locale
    return localized
  }, [locale, t])
  const localAgents = useMemo(
    () =>
      services.localProjectChatAgentApi && source.store === 'local'
        ? localAgentResourceContext(services.localProjectChatAgentApi, work)
        : services.localProjectChatAgentApi,
    [services.localProjectChatAgentApi, source.store, work]
  )
  const details = services.projectSpaceDetailServices?.[source.store]
  const host = useMemo(
    () =>
      createWeworkProjectAgentConfigurationHost(
        services.agentResourceApi,
        localAgents,
        source.store === 'local' ? details?.modelApi : undefined,
        services.pluginApi,
        services.deviceApi,
        source.store === 'cloud' && details
          ? { agents: source.workspace.agents, modelApi: details.modelApi, name: group.name }
          : undefined
      ),
    [
      services.agentResourceApi,
      localAgents,
      services.pluginApi,
      services.deviceApi,
      source.store,
      source.workspace.agents,
      details,
      group.name,
    ]
  )
  return (
    <section data-testid="group-resource-settings" className="space-y-5">
      <div className="flex gap-2" role="group" aria-label={t('groupResources')}>
        {(['agents', 'crews', 'devices', 'automation'] as const).map(value => (
          <Button
            key={value}
            variant="ghost"
            aria-pressed={tab === value}
            data-testid={`group-resource-tab-${value}`}
            className={tab === value ? 'bg-hover text-text-primary' : 'text-text-muted'}
            onClick={() => setTab(value)}
          >
            {t(
              value === 'agents'
                ? 'groupAgentsTitle'
                : value === 'crews'
                  ? 'groupCrewsTitle'
                  : value === 'devices'
                    ? 'groupDevicesTitle'
                    : 'groupAutomationTitle'
            )}
          </Button>
        ))}
      </div>
      <Activity mode={tab === 'agents' ? 'visible' : 'hidden'}>
        <ProjectAgentConfiguration
          scope="group"
          api={api}
          project={work}
          host={host}
          canManage={canManage}
          translate={translate}
          onAgentsChange={onChanged}
          onError={() => undefined}
        />
      </Activity>
      <Activity mode={tab === 'crews' ? 'visible' : 'hidden'}>
        <ProjectCollaborationGroups
          ownerType="chat_group"
          api={api}
          projectId={group.id}
          members={[]}
          agents={[]}
          locale={locale}
          currentUserId={source.store === 'local' ? 0 : currentUserId}
          canManage={canManage}
          location={source.store}
          agentConfiguration={host}
          onProjectChanged={onChanged}
        />
      </Activity>
      <Activity mode={tab === 'automation' ? 'visible' : 'hidden'}>
        <ProjectAutomaticProcessing
          api={api}
          project={work}
          members={[]}
          agents={[]}
          locale={locale}
          translate={translate}
        />
      </Activity>
      <Activity mode={tab === 'devices' ? 'visible' : 'hidden'}>
        <GroupExecutionDevices
          api={api}
          groupId={group.id}
          store={source.store}
          currentUserId={currentUserId}
          canManage={canManage}
          translate={translate}
        />
      </Activity>
    </section>
  )
}
