import { useContext, useState } from 'react'
import {
  ArrowLeft,
  ArrowUpRight,
  CheckCircle2,
  Circle,
  CircleAlert,
  LoaderCircle,
  Settings,
} from 'lucide-react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { WorkbenchContext } from '@/features/workbench/useWorkbench'
import type { RuntimeTaskAddress } from '@/types/api'
import { standInOrigin, standInState } from '@/features/notifications/standInNotifications'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import { mergeStandInWorkItems, standInWorkRole } from './standInWork'
import { useStandInInbox } from './useStandInInbox'
import { roleIncludesProject, type PersonalStandInSettings } from '@/api/personalStandIn'
import type { CollaborationProject } from '@wegent/collaboration'
import { StandInHomeSetupPrompt } from './StandInHomeSetup'
import type { PersonalHomeCollaborationWork } from './WeworkPersonalHome'
import { pendingIssueHumanRequests } from '@wegent/collaboration'

type Props = {
  services: WorkbenchServices
  userId: number
  deviceId: string
  localDeviceId: string
  active: boolean
  settings: PersonalStandInSettings
  projects: CollaborationProject[]
  collaborationWork?: PersonalHomeCollaborationWork
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
}

/** The collaboration home lists only Issue-related assistant work. */
export function StandInHomeWorkspace(props: Props) {
  const { services, userId, deviceId, active, settings, projects } = props
  const { t } = useTranslation('common')
  const workbench = useContext(WorkbenchContext)
  const inbox = useStandInInbox(services.standInApi, userId, deviceId, active)
  const [view, setView] = useState('list')
  const [opened, setOpened] = useState<
    Array<{ key: string; title: string; address: RuntimeTaskAddress }>
  >([])
  const items = mergeStandInWorkItems(
    workbench?.runtimeTaskReminders.items ?? [],
    inbox.items,
    deviceId,
    projects
  )
    .filter(item => {
      const origin = standInOrigin(item)
      return (
        origin &&
        origin.userId === userId &&
        item.address.deviceId === deviceId &&
        projects.some(
          project =>
            project.id === origin.cloudProjectId &&
            (project.project_store === 'local') === (origin.projectStore === 'local')
        )
      )
    })
    .sort((a, b) => standInState(b).updatedAt.localeCompare(standInState(a).updatedAt))
  const connected = [settings.primary, ...settings.roles].some(
    identity =>
      identity?.enabled &&
      identity.collaboration &&
      projects.some(project =>
        roleIncludesProject(
          { collaboration: identity.collaboration! },
          { id: project.id, store: project.project_store === 'local' ? 'local' : 'cloud' }
        )
      )
  )
  const roleIds = [...new Set(items.map(item => standInWorkRole(item)!))]
  const roleName = (id: string) =>
    id === '@primary' || id === 'default'
      ? t('personalHome.assistantRole')
      : settings.roles.find(role => role.id === id)?.name || t('personalHome.otherRole')
  const openTask = (address: RuntimeTaskAddress, title: string) => {
    const key = `${address.deviceId}:${address.taskId}`
    setOpened(previous =>
      previous.some(item => item.key === key) ? previous : [...previous, { key, title, address }]
    )
    setView(key)
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="personal-home-workspace">
      <header className="flex min-h-11 items-center gap-2 border-b border-border px-4 py-2">
        {view !== 'list' && (
          <button
            type="button"
            data-testid="personal-home-work-back"
            aria-label={t('personalHome.workList')}
            onClick={() => setView('list')}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md hover:bg-muted md:h-8 md:w-8"
          >
            <ArrowLeft aria-hidden="true" className="h-4 w-4" />
          </button>
        )}
        <h2 className="min-w-0 flex-1 truncate font-medium">
          {view === 'list'
            ? t('personalHome.workList')
            : opened.find(item => item.key === view)?.title}
        </h2>
        {view === 'list' && (
          <button
            type="button"
            data-testid="personal-home-assistant-settings"
            onClick={() => navigateTo('/stand-in?profileId=@primary')}
            className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted md:min-h-8"
          >
            <Settings aria-hidden="true" className="h-4 w-4" />
            {t('personalHome.assistantSettings')}
          </button>
        )}
      </header>
      <div
        className={view === 'list' ? 'min-h-0 flex-1 overflow-auto' : 'hidden'}
        inert={view !== 'list'}
        data-testid="personal-home-work-list"
      >
        {!connected && <StandInHomeSetupPrompt />}
        {!!props.collaborationWork?.pendingIssues.length && (
          <section className="p-4" data-testid="personal-home-collaboration-pending">
            <h3 className="mb-2 font-medium">{t('personalHome.needsInput')}</h3>
            {props.collaborationWork.pendingIssues.map(issue => (
              <button
                type="button"
                key={issue.id}
                data-testid={`personal-home-pending-${issue.id}`}
                onClick={() => props.collaborationWork?.onOpenIssue(issue)}
                className="block min-h-11 w-full border-b border-border/50 py-3 text-left transition-colors hover:bg-text-primary/[0.025]"
              >
                <span className="block font-medium">{issue.title}</span>
                <span className="mt-1 line-clamp-3 block text-sm text-text-secondary">
                  {pendingIssueHumanRequests(issue)[0]?.question}
                </span>
              </button>
            ))}
          </section>
        )}
        {inbox.error && (
          <div role="alert" className="p-4 text-sm text-error">
            {inbox.error}
            <button
              type="button"
              data-testid="personal-home-work-retry"
              onClick={inbox.refresh}
              className="ml-2 min-h-11 underline md:min-h-8"
            >
              {t('standIn.reload')}
            </button>
          </div>
        )}
        {!inbox.scope && !inbox.error && (
          <p role="status" className="p-4 text-sm text-text-muted">
            {t('standIn.loading')}
          </p>
        )}
        {connected && inbox.scope && !items.length && !inbox.error && (
          <div className="px-4 py-6">
            <p className="text-base font-medium text-text-secondary">
              {t('personalHome.assistantEmpty')}
            </p>
            <p className="mt-2 max-w-xs text-sm leading-5 text-text-muted">
              {t('personalHome.assistantEmptyHint')}
            </p>
          </div>
        )}
        {roleIds.map(roleId => (
          <section
            key={roleId}
            data-testid={`personal-home-role-${roleId}`}
            className="border-b border-border/50 py-4 last:border-b-0"
          >
            <h3 className="px-4 pb-2 text-sm font-medium text-text-secondary">
              {roleName(roleId)}
            </h3>
            {(['processing', 'completed'] as const).map(group => {
              const grouped = items.filter(
                item =>
                  standInWorkRole(item) === roleId &&
                  ['completed', 'failed', 'cancelled'].includes(standInState(item).status) ===
                    (group === 'completed')
              )
              return (
                <div key={group} data-testid={`personal-home-role-${roleId}-${group}`}>
                  <h4 className="flex items-center gap-2 px-4 py-2 text-sm font-medium">
                    {t(`personalHome.${group}`)}
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-text-muted">
                      {grouped.length}
                    </span>
                  </h4>
                  {grouped.map(item => {
                    const taskState = standInState(item).status
                    const Icon =
                      taskState === 'completed'
                        ? CheckCircle2
                        : taskState === 'running'
                          ? LoaderCircle
                          : taskState === 'failed'
                            ? CircleAlert
                            : Circle
                    const work = inbox.items.find(work => work.taskId === item.task.taskId)
                    const status =
                      work && work.status !== 'sent'
                        ? t(`standIn.workspace.inbox_${work.status}`)
                        : standInState(item).status === 'waiting'
                          ? t('personalHome.waitingInput')
                          : t(`standIn.personal.activity_${standInState(item).status}`)
                    return (
                      <button
                        type="button"
                        key={item.key}
                        data-testid={`personal-home-work-${item.task.taskId}`}
                        onClick={() => openTask(item.address, item.task.title)}
                        className="group/work flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-text-primary/[0.025] keyboard:focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30"
                      >
                        <Icon
                          aria-hidden="true"
                          className={`mt-0.5 h-4 w-4 shrink-0 ${taskState === 'completed' ? 'text-emerald-600 dark:text-emerald-400' : 'text-text-muted'} ${taskState === 'running' ? 'motion-safe:animate-spin' : ''}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium">{item.task.title}</span>
                          <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-text-muted">
                            <span className="shrink-0">{status}</span>
                            {item.projectName && (
                              <>
                                <span aria-hidden="true">·</span>
                                <span className="truncate">{item.projectName}</span>
                              </>
                            )}
                          </span>
                        </span>
                        <ArrowUpRight
                          aria-hidden="true"
                          className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted opacity-50 transition-opacity group-hover/work:opacity-100 group-focus-visible/work:opacity-100"
                        />
                      </button>
                    )
                  })}
                </div>
              )
            })}
          </section>
        ))}
      </div>
      {opened.map(item => (
        <div
          key={item.key}
          className={view === item.key ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
          inert={view !== item.key}
        >
          <TemporaryChatPanel
            currentProject={null}
            source={null}
            instanceId={`stand-in-work:${item.key}`}
            testId="personal-home-task-conversation"
            initialAddress={item.address}
            controlledAddress={item.address}
            nativeConversation
            sendEphemeral={false}
            markReadWhenActive
            coordinateUserInput
            expanded
            active={active && view === item.key}
            onOpenRuntimeTask={props.onOpenTask}
          />
        </div>
      ))}
    </div>
  )
}
