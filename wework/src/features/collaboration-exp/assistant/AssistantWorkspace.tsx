import { useMemo, useState, type ReactNode } from 'react'
import { MarkdownServicesProvider } from '@wegent/collaboration/markdown'
import type { CollaborationProject } from '@wegent/collaboration'
import type { StandInBindingTarget } from '@/api/standIn'
import { StandInOnboarding } from '@/features/todo/StandInOnboarding'
import { usePersonalStandIn } from '@/features/todo/usePersonalStandIn'
import { useCollaborationMarkdownServices } from '@/features/todo/useCollaborationMarkdownServices'
import { useOptionalCloudConnection } from '@/features/cloud-connection/useCloudConnection'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useOptionalWorkspaceTabs } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type { DeviceInfo } from '@/types/api'
import { COLLABORATION_EXP_TAB_ID } from '../collaborationExpFeature'
import { useExperienceSources } from '../data/useExperienceSources'
import { useExperienceTasks } from '../data/useExperienceTasks'
import { buildCollaborationExpRoute } from '../integration/deepLinks'
import { selectTaskRows } from '../model'
import { ExperiencePanes, type ExperiencePane } from '../shell'
import { ExperienceThemeProvider } from '../shell/ExperienceThemeProvider'
import { AssistantConversationPane } from './AssistantConversationPane'
import { AssistantHome } from './AssistantHome'
import { AssistantHomeToolbar } from './AssistantHomeToolbar'
import { AssistantSourceContext, useAssistantSourceState } from './useAssistantSources'
import type { AssistantHomePanel } from './types'
import '../shell/ExperienceTheme.css'

interface AssistantWorkspaceProps {
  active: boolean
  binding: StandInBindingTarget
  conversation?: { deviceId: string; taskId: string }
  projects: CollaborationProject[]
  localDeviceId: string
  devices: DeviceInfo[]
  headerActions?: ReactNode
  onClose(): void
}

/** The main assistant entry uses the same work, proposals and conversations as the experience. */
export default function AssistantWorkspace(props: AssistantWorkspaceProps) {
  const markdown = useCollaborationMarkdownServices()
  const { services } = useWorkbench()
  const api = services.standInApi
  const onboarding = usePersonalStandIn(
    services,
    props.binding.userId,
    props.binding.deviceId,
    props.localDeviceId,
    { active: props.active }
  )
  const content = (
    <ExperienceThemeProvider>
      <div
        className="collaboration-exp-app h-full min-h-0 min-w-0 overflow-hidden bg-background text-text-primary"
        data-testid="collaboration-exp-app"
      >
        <AssistantWorkspaceContent {...props} />
      </div>
    </ExperienceThemeProvider>
  )
  return (
    <div className="min-h-0 min-w-0 flex-1" data-testid="stand-in-experience">
      <MarkdownServicesProvider value={markdown}>
        {api ? (
          <StandInOnboarding
            api={api}
            userId={props.binding.userId}
            deviceId={props.binding.deviceId}
            active={props.active}
            bypass={Boolean(props.conversation)}
            configuration={{
              settings: onboarding.saved,
              loading: onboarding.loading,
              error: onboarding.error,
              projects: props.projects,
              localDeviceId: props.localDeviceId,
              devices: props.devices,
              services,
              onSave: onboarding.save,
              onReload: onboarding.reload,
            }}
            onClose={props.onClose}
          >
            {content}
          </StandInOnboarding>
        ) : (
          content
        )}
      </MarkdownServicesProvider>
    </div>
  )
}

function AssistantWorkspaceContent({
  active,
  binding,
  conversation,
  headerActions,
}: AssistantWorkspaceProps) {
  const { state, services } = useWorkbench()
  const tabs = useOptionalWorkspaceTabs()
  const cloud = useOptionalCloudConnection()
  const { t, i18n } = useTranslation('collaborationExp')
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const sources = useExperienceSources(services, state.user, cloud.isConnected, locale)
  const viewer = Number(state.user?.id ?? binding.userId)
  const viewers = useMemo(() => [...new Set([viewer, binding.userId])], [viewer, binding.userId])
  const tasks = useExperienceTasks(sources, viewers, active && Boolean(state.user), 'related')
  const conversations = selectTaskRows(
    { projects: tasks.projects, viewer, runtimeWork: state.runtimeWork },
    { relevance: 'all' }
  ).flatMap(row => row.conversations.items)
  const [panel, setPanel] = useState<AssistantHomePanel>(null)
  const assistantSource = useAssistantSourceState(active, true, binding)
  const taskSearch = tabs?.tabs
    .find(tab => tab.id === COLLABORATION_EXP_TAB_ID)
    ?.contentRoute.split('?')[1]
  const openIssue = (
    projectId: string,
    projectStore: string,
    issueId: string,
    discussion?: string
  ) =>
    navigateTo(
      buildCollaborationExpRoute(taskSearch, {
        view: 'tasks',
        projectId,
        projectStore,
        issueId,
        discussion,
        nodeId: null,
        commentId: null,
        focusRequest: null,
        inspector: null,
        timelineFilter: null,
        projectView: null,
        assistantDeviceId: null,
        assistantTaskId: null,
      })
    )
  const panes: ExperiencePane[] = [
    {
      id: 'assistant',
      title: t('assistant.pageTitle'),
      scroll: false,
      minWidth: 280,
      defaultWidth: 900,
      actions: (
        <>
          <AssistantHomeToolbar panel={panel} onPanelChange={setPanel} />
          {headerActions}
        </>
      ),
      content: (
        <AssistantHome
          active={active}
          panel={panel}
          onPanelChange={setPanel}
          projects={tasks.projects}
          conversations={conversations}
          onOpenIssue={(project, issueId) => openIssue(project.id, project.store, issueId)}
          onOpenConversation={({ issueSource, key, address }) => {
            if (issueSource) {
              openIssue(issueSource.projectId, issueSource.projectStore, issueSource.issueId, key)
              return
            }
            const params = new URLSearchParams({
              userId: String(binding.userId),
              assistantDeviceId: address.deviceId,
              assistantTaskId: address.taskId,
            })
            navigateTo(`/stand-in?${params}`)
          }}
        />
      ),
    },
  ]
  if (conversation)
    panes.push({
      id: 'assistant-conversation',
      title: t('private.title'),
      scroll: false,
      minWidth: 320,
      defaultWidth: 560,
      onBack: () => navigateTo('/stand-in'),
      content: <AssistantConversationPane active={active} address={conversation} />,
    })
  return (
    <AssistantSourceContext.Provider value={assistantSource}>
      <ExperiencePanes panes={panes} />
    </AssistantSourceContext.Provider>
  )
}
