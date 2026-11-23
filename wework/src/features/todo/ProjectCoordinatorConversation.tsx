import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { localRuntimeAttachments } from '@/lib/runtime-attachments'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { createAsyncResource, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import type {
  CollaborationGroup,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Brain, ListTodo, MessageSquare, Send, Settings, X } from 'lucide-react'
import { useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { ProjectCoordinationPanel } from './ProjectCoordinationPanel'
import { ProjectCoordinatorPublication } from './ProjectCoordinatorPublication'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import { StandInMemoryPanel } from './StandInMemoryPanel'
import type { StandInSettingsHandle } from './StandInSettingsPage'

type ProjectCoordinatorConversationProps = {
  api: SharedWorkspaceApi
  project: CollaborationProject
  services: WorkbenchServices
  userId: number
  devices: DeviceInfo[]
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  onOpenGroupSettings(): void
  onOpenIssue(issueId: string): void
  onPublished(): void
}

export function ProjectCoordinatorConversation(props: ProjectCoordinatorConversationProps) {
  const [owner, setOwner] = useState({ api: props.api, services: props.services, revision: 0 })
  if (owner.api !== props.api || owner.services !== props.services) {
    setOwner({ api: props.api, services: props.services, revision: owner.revision + 1 })
  }
  return (
    <ProjectCoordinatorConversationContent
      key={JSON.stringify([
        owner.revision,
        props.userId,
        props.project.project_store,
        props.project.id,
      ])}
      {...props}
    />
  )
}

function ProjectCoordinatorConversationContent({
  api,
  project,
  services,
  userId,
  devices,
  onOpenTask,
  onOpenGroupSettings,
  onOpenIssue,
  onPublished,
}: ProjectCoordinatorConversationProps) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const catalogResource = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify([userId, project.project_store, project.id]),
        async () => {
          const [groups, identity] = await Promise.all([
            api.projects.listCollaborationGroups?.(project.id) ?? Promise.resolve([]),
            services.getLocalRuntimeSidebarIdentity?.(),
          ])
          return { groups, localDeviceId: identity?.deviceId ?? '' }
        },
        { refreshOnSubscribe: true }
      ),
    [api, services, userId, project.project_store, project.id]
  )
  const catalog = useSyncExternalStore(
    open ? catalogResource.subscribe : subscribeIdleResource,
    catalogResource.getSnapshot,
    catalogResource.getSnapshot
  )
  const groups = catalog.data?.groups ?? null
  const localDeviceId = catalog.data?.localDeviceId ?? ''
  const [chosenDeviceId, setDeviceId] = useState('')
  const deviceId = chosenDeviceId || localDeviceId
  const [selection, setSelection] = useState<{ id: string; receipt: unknown }>()
  const selectedGroup =
    selection &&
    (groups?.some(row => row.id === selection.id) ||
      (!selection.id && selection.receipt === catalog.data))
      ? selection.id
      : groups?.length === 1
        ? groups[0].id
        : ''
  const error =
    catalog.status === 'error' || catalog.error !== undefined
      ? getStandInErrorMessage(catalog.error)
      : catalog.data && !localDeviceId
        ? t('standIn.errors.workspace_unavailable')
        : null
  const [memory, setMemory] = useState(false)
  const [publication, setPublication] = useState(false)
  const memoryRef = useRef<StandInSettingsHandle>(null)
  const publicationRef = useRef<StandInSettingsHandle>(null)
  const runtime = services.standInApi
  const group = groups?.find(row => row.id === selectedGroup)
  const closeConversation = () => {
    setPublication(false)
    setMemory(false)
    setOpen(false)
  }
  const dialogRef = useRef<HTMLElement>(null)
  const leave = (action: () => void) => {
    if (publication) publicationRef.current?.requestLeave(action)
    else if (memory) memoryRef.current?.requestLeave(action)
    else action()
  }
  const storage = project.project_store === 'local' ? 'local' : 'cloud'
  const configure = () => {
    closeConversation()
    onOpenGroupSettings()
  }
  return (
    <>
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="project-coordinator-open"
        onClick={() => setOpen(true)}
        disabled={!runtime}
        className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted disabled:opacity-40"
      >
        <MessageSquare className="h-4 w-4" />
        {t('standIn.project_coordinator.open')}
      </ControlButton>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-modal flex justify-end bg-black/20"
            data-testid="project-coordinator-backdrop"
            onClick={event => {
              if (event.target === event.currentTarget) {
                leave(closeConversation)
              }
            }}
          >
            <DialogSurface
              onClose={() => leave(closeConversation)}
              render={
                <section
                  ref={dialogRef}
                  aria-label={t('standIn.project_coordinator.title', { project: project.name })}
                  className="flex h-full w-full max-w-5xl min-w-0 flex-col border-l border-border bg-background shadow-xl"
                  data-testid="project-coordinator-dialog"
                />
              }
            >
              <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-3">
                <div className="min-w-0 flex-1">
                  <h2 className="heading-sm truncate">
                    {group
                      ? t('standIn.project_coordinator.leader_title', {
                          group: group.name,
                          leader: group.leader.name || t('standIn.project_coordinator.leader'),
                        })
                      : t('standIn.project_coordinator.title', { project: project.name })}
                  </h2>
                  <p className="text-xs text-text-muted">
                    {t('standIn.project_coordinator.private_context')}
                  </p>
                </div>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="project-coordinator-work-list"
                  disabled={memory || publication}
                  onClick={() => {
                    leave(closeConversation)
                  }}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted"
                >
                  <ListTodo className="h-4 w-4" />
                  {t('standIn.workspace.work_list')}
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="project-coordinator-publish"
                  onClick={() => setPublication(true)}
                  disabled={memory || publication || group?.leader.kind !== 'agent'}
                  className="inline-flex min-h-11 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted disabled:opacity-40 md:min-h-8"
                >
                  <Send className="h-4 w-4" />
                  {t('standIn.project_coordinator.publish')}
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="project-coordinator-memory"
                  onClick={() => setMemory(true)}
                  disabled={!deviceId || memory || publication}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted disabled:opacity-40"
                >
                  <Brain className="h-4 w-4" />
                  {t('standIn.memory.title')}
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="project-coordinator-settings"
                  disabled={memory || publication}
                  onClick={configure}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted"
                >
                  <Settings className="h-4 w-4" />
                  {t('standIn.settings')}
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="project-coordinator-close"
                  aria-label={t('standIn.close')}
                  onClick={() => {
                    leave(closeConversation)
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                >
                  <X className="h-4 w-4" />
                </ControlButton>
              </header>
              {publication && (
                <ProjectCoordinatorPublication
                  ref={publicationRef}
                  api={api}
                  project={project}
                  onClose={() => setPublication(false)}
                  onPublished={onPublished}
                />
              )}
              <div
                hidden={publication}
                inert={publication}
                className={publication ? undefined : 'contents'}
              >
                {memory && runtime && deviceId ? (
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <StandInMemoryPanel
                      ref={memoryRef}
                      api={runtime}
                      settings={{ userId, executionDeviceId: deviceId, version: 0, roles: [] }}
                      projects={[project]}
                      fixedScope={{ kind: 'project_coordinator', id: project.id, store: storage }}
                      scopeLabel={project.name}
                      onClose={() => setMemory(false)}
                    />
                  </div>
                ) : (
                  <>
                    <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-border px-5 py-2">
                      <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                        <span className="shrink-0 text-text-muted">
                          {t('standIn.project_coordinator.group')}
                        </span>
                        <SelectRoot
                          value={normalizeSelectValue(selectedGroup)}
                          onValueChange={selectedValue => {
                            if (selectedValue !== null)
                              setSelection({ id: selectedValue, receipt: catalog.data })
                          }}
                        >
                          <SelectTrigger
                            data-testid="project-coordinator-group"
                            className="min-h-9 min-w-0 flex-1"
                          />
                          <SelectContent>
                            <SelectItem value="">
                              {t('standIn.project_coordinator.choose_group')}
                            </SelectItem>
                            {groups?.map(row => (
                              <SelectItem key={row.id} value={String(row.id)}>
                                {row.name}
                                {row.leader.name ? ` · ${row.leader.name}` : ''}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </SelectRoot>
                      </label>
                      {localDeviceId && (
                        <StandInDeviceSelect
                          value={deviceId}
                          currentDeviceId={localDeviceId}
                          devices={storage === 'local' ? [] : devices}
                          disabled={false}
                          onChange={setDeviceId}
                        />
                      )}
                    </div>
                    {group?.leader.kind === 'agent' && runtime && deviceId && (
                      <ProjectCoordinationPanel
                        key={`coordination:${userId}:${storage}:${project.id}:${group.id}:${deviceId}`}
                        api={runtime}
                        userId={userId}
                        deviceId={deviceId}
                        projectId={project.id}
                        projectStore={storage}
                        groupId={group.id}
                        leaderName={group.leader.name || t('standIn.project_coordinator.leader')}
                        onOpenIssue={issueId => {
                          closeConversation()
                          onOpenIssue(issueId)
                        }}
                      />
                    )}
                    {error ? (
                      <div role="alert" className="p-5 text-sm text-error">
                        <p>{error}</p>
                        <ControlButton
                          variant="unstyled"
                          type="button"
                          data-testid="project-coordinator-retry"
                          onClick={() => void catalogResource.reload()}
                          className="min-h-9 underline"
                        >
                          {t('standIn.reload')}
                        </ControlButton>
                      </div>
                    ) : groups === null ? (
                      <p role="status" className="p-5 text-sm text-text-muted">
                        {t('standIn.loading')}
                      </p>
                    ) : !groups.length ? (
                      <div className="p-5 text-sm text-text-muted">
                        <p>{t('standIn.project_coordinator.no_group')}</p>
                        <ControlButton
                          variant="unstyled"
                          type="button"
                          data-testid="project-coordinator-configure-group"
                          onClick={configure}
                          className="min-h-9 underline"
                        >
                          {t('standIn.project_coordinator.configure')}
                        </ControlButton>
                      </div>
                    ) : group?.leader.kind === 'human' ? (
                      <p className="p-5 text-sm text-text-muted">
                        {t('standIn.project_coordinator.human_leader')}
                      </p>
                    ) : group && runtime && deviceId ? (
                      <ProjectCoordinatorChat
                        key={`${userId}:${storage}:${project.id}:${group.id}:${deviceId}`}
                        api={runtime}
                        userId={userId}
                        project={project}
                        group={group}
                        deviceId={deviceId}
                        onOpenTask={onOpenTask}
                        active={!publication}
                      />
                    ) : (
                      <p className="p-5 text-sm text-text-muted">
                        {t('standIn.project_coordinator.choose_group')}
                      </p>
                    )}
                  </>
                )}
              </div>
            </DialogSurface>
          </div>,
          document.body
        )}
    </>
  )
}

function ProjectCoordinatorChat({
  api,
  userId,
  project,
  group,
  deviceId,
  onOpenTask,
  active,
}: {
  api: NonNullable<WorkbenchServices['standInApi']>
  userId: number
  project: CollaborationProject
  group: CollaborationGroup
  deviceId: string
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  active: boolean
}) {
  const { t } = useTranslation('common')
  const storage = project.project_store === 'local' ? 'local' : 'cloud'
  const resource = useMemo(
    () =>
      createAsyncResource(JSON.stringify([userId, deviceId, storage, project.id, group.id]), () =>
        api.projectConversation(userId, deviceId, project.id, storage, group.id)
      ),
    [api, userId, deviceId, storage, project.id, group.id]
  )
  const snapshot = useSyncExternalStore(
    active ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    resource.getSnapshot
  )
  const initial = snapshot.data
  const error = snapshot.status === 'error' ? getStandInErrorMessage(snapshot.error) : null
  if (error)
    return (
      <div role="alert" className="p-5 text-sm text-error">
        <p>{error}</p>
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="project-coordinator-chat-retry"
          onClick={() => {
            void resource.reload()
          }}
          className="min-h-9 underline"
        >
          {t('standIn.reload')}
        </ControlButton>
      </div>
    )
  if (!initial)
    return (
      <p role="status" className="p-5 text-sm text-text-muted">
        {t('standIn.loading')}
      </p>
    )
  return (
    <TemporaryChatPanel
      currentProject={null}
      source={null}
      instanceId={`project-coordinator:${userId}:${storage}:${project.id}:${group.id}:${deviceId}`}
      testId="project-coordinator-chat"
      initialAddress={initial.address}
      sendEphemeral={false}
      showExecutionTools={false}
      expanded
      active={active}
      emptyStateText={t('standIn.project_coordinator.empty', { project: project.name })}
      placeholder={t('standIn.project_coordinator.prompt')}
      onOpenRuntimeTask={onOpenTask}
      createTask={async (message, options) => {
        options.onRuntimeTaskOptimisticOpen({ deviceId, taskId: initial.taskId })
        try {
          const result = await api.projectConversation(
            userId,
            deviceId,
            project.id,
            storage,
            group.id,
            message,
            {
              ...options.executionModel,
              attachments: localRuntimeAttachments(options.attachments),
              clientUserMessageId: options.optimisticUserMessage.id,
            }
          )
          if (!result.address) throw new Error('project_coordinator_not_started')
          return result.address
        } catch (cause) {
          options.onError(getStandInErrorMessage(cause))
          return false
        }
      }}
    />
  )
}
