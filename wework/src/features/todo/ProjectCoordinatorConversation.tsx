import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Brain, ListTodo, MessageSquare, Settings, X } from 'lucide-react'
import type {
  CollaborationGroup,
  CollaborationProject,
  SharedWorkspaceApi,
} from '@wegent/collaboration'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { TemporaryChatPanel } from '@/components/layout/workspace-panels/TemporaryChatPanel'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { localRuntimeAttachments } from '@/lib/runtime-attachments'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import { StandInMemoryPanel } from './StandInMemoryPanel'
import type { StandInSettingsHandle } from './StandInSettingsPage'

export function ProjectCoordinatorConversation({
  api,
  project,
  services,
  userId,
  devices,
  onOpenTask,
  onOpenGroupSettings,
}: {
  api: SharedWorkspaceApi
  project: CollaborationProject
  services: WorkbenchServices
  userId: number
  devices: DeviceInfo[]
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
  onOpenGroupSettings(): void
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [groups, setGroups] = useState<CollaborationGroup[] | null>(null)
  const [selectedGroup, setSelectedGroup] = useState('')
  const [localDeviceId, setLocalDeviceId] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const [memory, setMemory] = useState(false)
  const memoryRef = useRef<StandInSettingsHandle>(null)
  const runtime = services.standInApi
  const group = groups?.find(row => row.id === selectedGroup)
  const dialogRef = useDialogKeyboard<HTMLElement>(() => setOpen(false), open && !memory)
  const storage = project.project_store === 'local' ? 'local' : 'cloud'
  useEffect(() => {
    if (!open) return
    let active = true
    void Promise.all([
      api.projects.listCollaborationGroups?.(project.id) ?? Promise.resolve([]),
      services.getLocalRuntimeSidebarIdentity?.(),
    ])
      .then(([rows, identity]) => {
        if (!active) return
        setGroups(rows)
        setSelectedGroup(current =>
          rows.some(row => row.id === current) ? current : rows.length === 1 ? rows[0].id : ''
        )
        if (identity?.deviceId) {
          setLocalDeviceId(identity.deviceId)
          setDeviceId(current => current || identity.deviceId)
        }
        setError(identity?.deviceId ? null : t('standIn.errors.workspace_unavailable'))
      })
      .catch(cause => {
        if (active) setError(getStandInErrorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [api, project.id, services, open, retry, t])
  const configure = () => {
    setOpen(false)
    onOpenGroupSettings()
  }
  return (
    <>
      <button
        type="button"
        data-testid="project-coordinator-open"
        onClick={() => setOpen(true)}
        disabled={!runtime}
        className="inline-flex min-h-8 items-center gap-2 rounded-md px-2 text-sm hover:bg-muted disabled:opacity-40"
      >
        <MessageSquare className="h-4 w-4" />
        {t('standIn.project_coordinator.open')}
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-modal flex justify-end bg-black/20"
            data-testid="project-coordinator-backdrop"
            onClick={event => {
              if (event.target === event.currentTarget) {
                if (memory) memoryRef.current?.requestClose()
                else setOpen(false)
              }
            }}
          >
            <section
              ref={dialogRef}
              role="dialog"
              aria-modal="true"
              aria-label={t('standIn.project_coordinator.title', { project: project.name })}
              className="flex h-full w-full max-w-5xl min-w-0 flex-col border-l border-border bg-background shadow-xl"
              data-testid="project-coordinator-dialog"
            >
              <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-border px-5 py-3">
                <div className="min-w-0 flex-1">
                  <h2 className="heading-sm truncate">
                    {t('standIn.project_coordinator.title', { project: project.name })}
                  </h2>
                  <p className="text-xs text-text-muted">
                    {t('standIn.project_coordinator.private_context')}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="project-coordinator-work-list"
                  disabled={memory}
                  onClick={() => {
                    if (memory) memoryRef.current?.requestClose()
                    else setOpen(false)
                  }}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted"
                >
                  <ListTodo className="h-4 w-4" />
                  {t('standIn.workspace.work_list')}
                </button>
                <button
                  type="button"
                  data-testid="project-coordinator-memory"
                  onClick={() => setMemory(true)}
                  disabled={!deviceId || memory}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted disabled:opacity-40"
                >
                  <Brain className="h-4 w-4" />
                  {t('standIn.memory.title')}
                </button>
                <button
                  type="button"
                  data-testid="project-coordinator-settings"
                  disabled={memory}
                  onClick={configure}
                  className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-sm hover:bg-muted"
                >
                  <Settings className="h-4 w-4" />
                  {t('standIn.settings')}
                </button>
                <button
                  type="button"
                  data-testid="project-coordinator-close"
                  aria-label={t('standIn.close')}
                  onClick={() => {
                    if (memory) memoryRef.current?.requestClose()
                    else setOpen(false)
                  }}
                  className="flex h-8 w-8 items-center justify-center rounded-md hover:bg-muted"
                >
                  <X className="h-4 w-4" />
                </button>
              </header>
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
                      <select
                        data-testid="project-coordinator-group"
                        value={selectedGroup}
                        onChange={event => setSelectedGroup(event.target.value)}
                        className="min-h-9 min-w-0 flex-1 bg-background outline-none"
                      >
                        <option value="">{t('standIn.project_coordinator.choose_group')}</option>
                        {groups?.map(row => (
                          <option key={row.id} value={row.id}>
                            {row.name}
                            {row.leader.name ? ` · ${row.leader.name}` : ''}
                          </option>
                        ))}
                      </select>
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
                  {error ? (
                    <div role="alert" className="p-5 text-sm text-error">
                      <p>{error}</p>
                      <button
                        type="button"
                        data-testid="project-coordinator-retry"
                        onClick={() => setRetry(value => value + 1)}
                        className="min-h-9 underline"
                      >
                        {t('standIn.reload')}
                      </button>
                    </div>
                  ) : groups === null ? (
                    <p role="status" className="p-5 text-sm text-text-muted">
                      {t('standIn.loading')}
                    </p>
                  ) : !groups.length ? (
                    <div className="p-5 text-sm text-text-muted">
                      <p>{t('standIn.project_coordinator.no_group')}</p>
                      <button
                        type="button"
                        data-testid="project-coordinator-configure-group"
                        onClick={configure}
                        className="min-h-9 underline"
                      >
                        {t('standIn.project_coordinator.configure')}
                      </button>
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
                    />
                  ) : (
                    <p className="p-5 text-sm text-text-muted">
                      {t('standIn.project_coordinator.choose_group')}
                    </p>
                  )}
                </>
              )}
            </section>
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
}: {
  api: NonNullable<WorkbenchServices['standInApi']>
  userId: number
  project: CollaborationProject
  group: CollaborationGroup
  deviceId: string
  onOpenTask?(address: RuntimeTaskAddress): Promise<void> | void
}) {
  const { t } = useTranslation('common')
  const [initial, setInitial] = useState<{ taskId: string; address: RuntimeTaskAddress | null }>()
  const [error, setError] = useState<string | null>(null)
  const [retry, setRetry] = useState(0)
  const storage = project.project_store === 'local' ? 'local' : 'cloud'
  useEffect(() => {
    let active = true
    void api
      .projectConversation(userId, deviceId, project.id, storage, group.id)
      .then(result => {
        if (active) {
          setInitial(result)
          setError(null)
        }
      })
      .catch(cause => {
        if (active) setError(getStandInErrorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [api, userId, deviceId, project.id, storage, group.id, retry])
  if (error)
    return (
      <div role="alert" className="p-5 text-sm text-error">
        <p>{error}</p>
        <button
          type="button"
          data-testid="project-coordinator-chat-retry"
          onClick={() => {
            setInitial(undefined)
            setError(null)
            setRetry(value => value + 1)
          }}
          className="min-h-9 underline"
        >
          {t('standIn.reload')}
        </button>
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
