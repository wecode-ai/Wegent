import type { PersonalStandInSettings, StandInRole } from '@/api/personalStandIn'
import {
  connectionChangeEnablesIdentity,
  disconnectStandInProject,
  roleIncludesProject,
  roleSelectsProject,
  standInRoleName,
} from '@/api/personalStandIn'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createStandInOpenedReceipt } from '@/telemetry/standInOpenedReceipt'
import type { DeviceInfo } from '@/types/api'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import { createTagDraft } from '@wegent/collaboration'
import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { dequal } from 'dequal'
import { Trash2 } from 'lucide-react'
import type { ReactNode, Ref } from 'react'
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { saveStandInRoleDevice } from './saveStandInRoleDevice'
import { StandInComposer } from './StandInComposer'
import type { StandInConnectionNavigationHandle } from './StandInConnectionSettings'
import { StandInConnectionSettings } from './StandInConnectionSettings'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import { StandInProjectSetup } from './StandInProjectSetup'
import { StandInRequirements } from './StandInRequirements'
import { StandInSelfLearningSetting } from './StandInSelfLearningSetting'
import { StandInTaskPermissionSettings } from './StandInTaskPermissionSettings'
import { createStandInRoleDraft } from './standInRoleDraft'
import {
  StandInSettingsActions,
  StandInSettingsEntry,
  StandInSettingsError,
  StandInSettingsHeader,
  StandInSettingsPanel,
  StandInSettingsShortcuts,
  type StandInSettingsShortcut,
} from './StandInSettingsLayout'
import { usePersonalStandIn } from './usePersonalStandIn'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { useStandInRuntimeWork } from './useStandInRuntimeWork'

type View =
  | 'project'
  | 'main'
  | 'connections'
  | 'advanced'
  | 'create'
  | StandInSettingsShortcut['id']
export interface StandInSettingsHandle {
  requestClose(): void
  requestLeave(action: () => void): void
}

interface StandInSettingsPageProps {
  shortcuts?: StandInSettingsShortcut[]
  footerLeading?: ReactNode
  api: SharedWorkspaceApi
  projects: CollaborationProject[]
  services: WorkbenchServices
  devices: DeviceInfo[]
  userId: number
  initialDeviceId?: string
  initialProfileId?: string
  initialCreate?: boolean
  initialProject?: CollaborationProject
  onCancel?(): void
  onSaved?(settings: WorkspaceStandInSettings): void
  onDeleted?(): void
  onSavingChange?(saving: boolean): void
  onOpenPersonalSettings?(roleId: string, deviceId: string): void
  initialCalendar?: boolean
  onCalendarViewChange?(open: boolean): void
  ref?: Ref<StandInSettingsHandle>
}

/** Role configuration selects its own execution device. */
export function StandInSettingsPage({ ref, ...props }: StandInSettingsPageProps) {
  return <StandInSettingsEditor {...props} ref={ref} />
}

/** Edit one device-owned stand-in draft and persist it only after an explicit save. */
function StandInSettingsEditor({
  shortcuts,
  footerLeading,
  projects,
  services,
  devices,
  userId,
  initialDeviceId,
  initialProfileId,
  initialCreate = false,
  initialProject,
  onCancel,
  onSaved,
  onDeleted,
  onSavingChange,
  onOpenPersonalSettings,
  initialCalendar = false,
  onCalendarViewChange,
  ref,
}: StandInSettingsPageProps) {
  const [recordOpened] = useState(createStandInOpenedReceipt)
  const openedIdentity = initialProfileId === '@primary' ? 'primary' : 'role'
  const { t } = useTranslation('common')
  const roleDraftRequest = useMemo(
    () => ({
      project: initialProject
        ? {
            id: initialProject.id,
            store:
              initialProject.project_store === 'local' ? ('local' as const) : ('cloud' as const),
          }
        : undefined,
      projectRoleName: initialProject
        ? t('standIn.personal.project_role_name', { project: initialProject.name })
        : undefined,
    }),
    [initialProject, t]
  )
  const state = usePersonalStandIn(services, userId, initialDeviceId, undefined, {
    onSavingChange,
    initialRole: initialCreate ? roleDraftRequest : undefined,
  })
  const {
    draft,
    saved,
    setDraft,
    updateRole,
    loading,
    saving,
    moving,
    setMoving,
    setError,
    initialRoleCreation,
  } = state
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [selectedId, setSelectedId] = useState(initialProfileId ?? '')
  const [view, setView] = useState<View>(
    initialCalendar ? 'connections' : initialProject ? 'project' : 'main'
  )
  const [history, setHistory] = useState<{ view: View; draft: PersonalStandInSettings | null }[]>(
    []
  )
  const [notice, setNotice] = useState(false)
  const [roleNameError, setRoleNameError] = useState(false)
  const [seenInitialRoleId, setSeenInitialRoleId] = useState<string>()
  if (initialRoleCreation && seenInitialRoleId !== initialRoleCreation.roleId) {
    setSeenInitialRoleId(initialRoleCreation.roleId)
    setHistory(current => [...current, { view, draft: initialRoleCreation.baseline }])
    setSelectedId(initialRoleCreation.roleId)
    setView('create')
    setRoleNameError(false)
    setNotice(false)
  }
  const roleNameInput = useRef<HTMLInputElement>(null)
  useFocusRequest(roleNameInput, view, { enabled: roleNameError })
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const projectRef = useMemo(
    () =>
      initialProject && {
        id: initialProject.id,
        store: initialProject.project_store === 'local' ? ('local' as const) : ('cloud' as const),
      },
    [initialProject]
  )
  const connectedRole = projectRef && draft?.roles.find(row => roleIncludesProject(row, projectRef))
  const projectEnabled = Boolean(
    projectRef && draft?.roles.some(row => row.enabled && roleIncludesProject(row, projectRef))
  )
  const projectRoleId = selectedId || connectedRole?.id || draft?.roles[0]?.id || ''
  const role =
    draft?.roles.find(role => role.id === (initialProject ? projectRoleId : selectedId)) ??
    draft?.roles[0]
  const previousRole = saved?.roles.find(row => row.id === role?.id)
  const changingDevice =
    role &&
    (previousRole
      ? role.executionDeviceId !== previousRole.executionDeviceId
      : role.executionDeviceId !== draft?.executionDeviceId &&
        role.executionDeviceId !== state.loadedDeviceId)
  const executionDeviceId = role?.executionDeviceId ?? draft?.executionDeviceId
  const [scheduleDirty, setScheduleDirty] = useState(false)
  const tagScope = JSON.stringify([userId, executionDeviceId, role?.id])
  const tagApi = services.standInApi
  const [tagOwner, setTagOwner] = useState(() => ({
    api: tagApi,
    scope: tagScope,
    store: createTagDraft(),
  }))
  if (tagOwner.api !== tagApi || tagOwner.scope !== tagScope) {
    setTagOwner({ api: tagApi, scope: tagScope, store: createTagDraft() })
  }
  const tagDraft = tagOwner.store
  const subscribeTagDraft = useCallback(
    (listener: () => void) => {
      const release = tagDraft.subscribe(listener)
      recordOpened('settings', openedIdentity)
      return release
    },
    [tagDraft, recordOpened, openedIdentity]
  )
  const connectionDraftDirty = useSyncExternalStore(
    subscribeTagDraft,
    tagDraft.getDirtySnapshot,
    tagDraft.getDirtySnapshot
  )
  const [calendarOpen, setCalendarOpen] = useState(initialCalendar)
  const [connectionDetailOpen, setConnectionDetailOpen] = useState(initialCalendar)
  const [connectionTitle, setConnectionTitle] = useState<string | null>(null)
  const [calendarEntry, setCalendarEntry] = useState(initialCalendar)
  const connectionRef = useRef<StandInConnectionNavigationHandle>(null)
  const calendarViewChanged = useCallback(
    (open: boolean) => {
      setCalendarOpen(open)
      onCalendarViewChange?.(open)
    },
    [onCalendarViewChange]
  )
  const dirty =
    Boolean(draft && saved && !dequal(draft, saved)) || scheduleDirty || connectionDraftDirty
  const { runtimeWork, runtimeError, retryRuntimeWork } = useStandInRuntimeWork(
    services.runtimeWorkApi,
    executionDeviceId,
    view === 'advanced' || ((view === 'main' || view === 'create') && Boolean(role?.workspace))
  )

  const shortcutPage = shortcuts?.find(shortcut => shortcut.id === view && !shortcut.onClick)
  const openView = (next: View) => {
    setRoleNameError(false)
    setHistory(current => [...current, { view, draft }])
    setView(next)
    setNotice(false)
  }
  const changeRole = (value: StandInRole) => {
    const baselineRole = saved?.roles.find(row => row.id === value.id) ?? role
    const connected = connectionChangeEnablesIdentity(baselineRole ?? {}, value)
    setSelectedId(value.id)
    // Explicit source connection replaces the removed extra intake switch, only on Save.
    updateRole(value.id, () => ({ ...value, enabled: Boolean(baselineRole?.enabled || connected) }))
  }
  const closeView = () => {
    if (saving) return
    setCalendarEntry(false)
    setRoleNameError(false)
    if (view !== (initialProject ? 'project' : 'main')) {
      const entry = history.at(-1)
      setHistory(current => current.slice(0, -1))
      setView(entry?.view ?? (initialProject ? 'project' : 'main'))
    } else if (dirty) setConfirmDiscard(true)
    else onCancel?.()
  }
  const navigation = useStandInPanelNavigation(
    Boolean(draft && saved && !dequal(draft, saved)),
    saving,
    () => setConfirmDiscard(true)
  )
  const requestLeave = useStableEvent((action: () => void) => {
    if (connectionRef.current)
      connectionRef.current.requestLeave(discarded =>
        discarded ? action() : navigation.requestLeave(action)
      )
    else navigation.requestLeave(action)
  })
  const close = () =>
    connectionRef.current ? connectionRef.current.requestLeave(closeView) : closeView()
  const closeSettings = () => requestLeave(() => onCancel?.())
  const cancelView = () => {
    const nestedCreation = view === 'create' && !initialCreate
    if (!nestedCreation && (onCancel || view === (initialProject ? 'project' : 'main'))) {
      closeSettings()
      return
    }
    const cancelChanges = () => {
      const entry = history.at(-1)
      const previous = entry?.draft ?? saved
      if (previous) setDraft(previous)
      setSelectedId(previous?.roles.some(row => row.id === selectedId) ? selectedId : '')
      setRoleNameError(false)
      setHistory(current => current.slice(0, -1))
      setView(entry?.view ?? (initialProject ? 'project' : 'main'))
    }
    if (connectionRef.current) connectionRef.current.requestLeave(cancelChanges)
    else cancelChanges()
  }
  useImperativeHandle(ref, () => ({
    requestClose: closeSettings,
    requestLeave,
  }))
  const save = async (disconnectProject = false) => {
    if (!draft || !role || moving || connectionDraftDirty) return
    if (!saved?.roles.some(value => value.id === role.id) && !role.name.trim()) {
      if (view === 'project') openView('create')
      else if (view === 'advanced' || view === 'connections') closeView()
      setRoleNameError(true)
      return
    }
    setRoleNameError(false)
    if (initialProject && view === 'advanced') {
      setView(history.at(-1)?.view ?? 'project')
      setHistory(current => current.slice(0, -1))
      return
    }
    if (view === 'project' && !projectRoleId) return
    const value =
      disconnectProject && projectRef
        ? { ...draft, roles: draft.roles.map(row => disconnectStandInProject(row, projectRef)) }
        : projectRef && (view === 'project' || view === 'create' || view === 'main')
          ? {
              ...draft,
              roles: draft.roles.map(row =>
                row.id !== role.id
                  ? row
                  : {
                      ...row,
                      enabled: view === 'project' ? true : row.enabled,
                      collaboration: {
                        ...row.collaboration,
                        enabled: true,
                        allProjects: row.collaboration.enabled && row.collaboration.allProjects,
                        projects: row.collaboration.projects.some(
                          item => item.id === projectRef.id && item.store === projectRef.store
                        )
                          ? row.collaboration.projects
                          : [...row.collaboration.projects, projectRef],
                        excludedProjects: row.collaboration.excludedProjects.filter(
                          item => item.id !== projectRef.id || item.store !== projectRef.store
                        ),
                      },
                    }
              ),
            }
          : draft
    const changedRole = value.roles.find(row => row.id === role.id)!
    if (changingDevice) {
      if (!services.standInApi || !saved) return
      setMoving(true)
      try {
        const result = await saveStandInRoleDevice(services.standInApi, {
          userId,
          sourceDevice: state.loadedDeviceId ?? value.executionDeviceId,
          source: saved,
          draft: value,
          role: changedRole,
        })
        onSaved?.(result)
      } catch (cause) {
        setError(getStandInErrorMessage(cause, 'save_settings_failed'))
      } finally {
        setMoving(false)
      }
      return
    }
    const result = await state.save(value)
    if (!result) return
    setHistory([])
    setNotice(true)
    if ((initialProject || initialCreate) && ['project', 'main', 'create'].includes(view))
      onSaved?.(result.roles.find(row => row.id === role.id) ?? result.roles[0])
    else if (view !== 'main') setView('main')
    else onSaved?.(result.roles.find(row => row.id === role.id) ?? result.roles[0])
  }
  const createRole = useCallback(() => {
    if (!draft) return
    const created = createStandInRoleDraft(draft, roleDraftRequest)
    setRoleNameError(false)
    setHistory(current => [...current, { view, draft }])
    setDraft(created.draft)
    setSelectedId(created.role.id)
    setView('create')
    setNotice(false)
  }, [draft, roleDraftRequest, setDraft, view])
  const availableProjects = projects.filter(
    project =>
      project.project_store !== 'local' || draft?.executionDeviceId === state.currentDeviceId
  )
  const included = role
    ? availableProjects.filter(project =>
        roleSelectsProject(role, {
          id: project.id,
          store: project.project_store === 'local' ? 'local' : 'cloud',
        })
      )
    : []
  const projectConfigured =
    role && (role.collaboration.allProjects || role.collaboration.projects.length > 0)
  const receivingSources = Boolean(
    role?.enabled && ((projectConfigured && role.collaboration.enabled) || role.connections?.length)
  )
  const canDeleteRole =
    initialProfileId &&
    !initialProject &&
    view === 'main' &&
    saved?.roles.some(row => row.id === role?.id)

  const deviceControl = role && (
    <StandInDeviceSelect
      testId="stand-in-role-device"
      ariaLabel={t('standIn.personal.execution_device')}
      value={role.executionDeviceId}
      currentDeviceId={state.currentDeviceId}
      devices={userId === 0 ? [] : devices}
      disabled={saving || moving}
      onChange={value => {
        if (value === role.executionDeviceId) return
        setNotice(false)
        updateRole(role.id, current => ({
          ...current,
          executionDeviceId: value,
          model: undefined,
          modelOptions: undefined,
          workspace: undefined,
        }))
      }}
    />
  )

  return (
    <StandInSettingsPanel
      testId="stand-in-page"
      contentTestId="stand-in-settings"
      onClose={close}
      active={Boolean(initialCreate || initialProfileId) && !confirmDiscard}
      embedded={Boolean(initialProject)}
      calendarOpen={calendarOpen}
    >
      <StandInSettingsHeader
        path={[
          {
            label: t('standIn.workspace.role_profile'),
            testId: 'stand-in-path-settings',
            onClick: view !== (initialProject ? 'project' : 'main') ? close : undefined,
          },
          ...(view === 'connections'
            ? [
                {
                  label: t('standIn.workspace.connections'),
                  testId: 'stand-in-path-connections',
                  onClick: connectionDetailOpen ? () => connectionRef.current?.back() : undefined,
                },
                ...(connectionTitle
                  ? [{ label: connectionTitle, testId: 'stand-in-path-source' }]
                  : []),
              ]
            : view === 'advanced'
              ? [
                  {
                    label: t('standIn.workspace.execution_settings'),
                    testId: 'stand-in-path-advanced',
                  },
                ]
              : shortcutPage
                ? [{ label: shortcutPage.label, testId: 'stand-in-path-tool' }]
                : []),
        ]}
        title={
          initialProject && (view === 'project' || view === 'create')
            ? t('standIn.personal.project_title', { project: initialProject.name })
            : t(
                view === 'create'
                  ? 'standIn.personal.create_title'
                  : 'standIn.workspace.role_profile'
              )
        }
        description={
          initialProject && (view === 'project' || view === 'create')
            ? t('standIn.personal.project_description', { project: initialProject.name })
            : view === 'create'
              ? t('standIn.personal.create_help')
              : undefined
        }
        disabled={saving}
        back={
          view !== (initialProject ? 'project' : 'main')
            ? {
                testId:
                  view === 'connections' && connectionDetailOpen
                    ? 'stand-in-connections-back'
                    : 'stand-in-back',
                onClick: () => {
                  if (view === 'connections' && connectionDetailOpen) connectionRef.current?.back()
                  else close()
                },
              }
            : onCancel
              ? { testId: 'stand-in-settings-back', onClick: closeSettings }
              : undefined
        }
        close={onCancel ? { testId: 'stand-in-close', onClick: closeSettings } : undefined}
      />
      {!loading && draft && initialProject && (view === 'project' || view === 'create') && (
        <div className={view === 'create' ? 'mb-4' : undefined}>
          <StandInProjectSetup
            project={initialProject}
            roles={draft.roles.filter(row => view !== 'create' || row.id !== role?.id)}
            projectRoleId={projectRoleId}
            role={role}
            onOpenSettings={
              onOpenPersonalSettings && role
                ? () => onOpenPersonalSettings(role.id, draft.executionDeviceId)
                : undefined
            }
            saving={saving}
            creating={view === 'create'}
            onChoose={value => {
              if (value === '__new') createRole()
              else {
                if (view === 'create') {
                  const previous = history.at(-1)?.draft
                  if (previous) setDraft(previous)
                  setHistory(current => current.slice(0, -1))
                }
                setSelectedId(value)
                setView('project')
              }
            }}
          />
        </div>
      )}
      {loading ? (
        <p role="status" className="px-5 py-8 text-text-secondary">
          {t('standIn.loading')}
        </p>
      ) : draft && role ? (
        <>
          <div className={calendarOpen ? 'flex min-h-0 flex-1 flex-col' : 'space-y-4'}>
            {(view === 'main' || view === 'create') && (
              <label className="grid gap-2">
                <span className="text-text-secondary">
                  {t(
                    initialProject ? 'standIn.personal.stand_in_name' : 'standIn.personal.role_name'
                  )}
                </span>
                <ControlInput
                  ref={roleNameInput}
                  autoFocus={view === 'create'}
                  data-testid="stand-in-role-name"
                  value={role.name}
                  disabled={saving}
                  aria-invalid={roleNameError}
                  aria-describedby={roleNameError ? 'stand-in-role-name-error' : undefined}
                  onChange={event => {
                    setRoleNameError(false)
                    changeRole({ ...role, name: event.target.value })
                  }}
                  className="min-h-11 placeholder:text-text-secondary md:min-h-9"
                  placeholder={
                    view === 'create'
                      ? t('standIn.personal.role_name_placeholder')
                      : standInRoleName(
                          role,
                          draft.roles.indexOf(role),
                          t('standIn.personal.unnamed_assistant')
                        )
                  }
                />
                {roleNameError && (
                  <span id="stand-in-role-name-error" role="alert" className="text-xs text-error">
                    {t('standIn.personal.role_name_required')}
                  </span>
                )}
              </label>
            )}
            {initialProject && (view === 'main' || view === 'connections') && (
              <p
                data-testid="stand-in-project-context"
                className="rounded-lg bg-muted px-3 py-2 text-text-secondary"
              >
                {t('standIn.personal.current_project', { project: initialProject.name })}
              </p>
            )}
            {(view === 'main' || view === 'create') && (
              <div className="space-y-2">
                <h2 className="font-medium">{t('standIn.personal.requirements')}</h2>
                <StandInRequirements
                  key={role.id}
                  role={role}
                  runtimeWork={runtimeWork}
                  services={services}
                  onChange={update => updateRole(role.id, update)}
                  disabled={saving}
                  onSave={() => void save()}
                />
              </div>
            )}
            {(view === 'main' || (view === 'create' && !initialProject)) && (
              <>
                <StandInSelfLearningSetting
                  enabled={role.selfLearningEnabled}
                  savedEnabled={saved?.roles.find(item => item.id === role.id)?.selfLearningEnabled}
                  disabled={saving}
                  onChange={selfLearningEnabled =>
                    updateRole(role.id, current => ({ ...current, selfLearningEnabled }))
                  }
                />
                <StandInSettingsEntry
                  label={t('standIn.workspace.connections')}
                  description={t('standIn.workspace.connections_help')}
                  testId="stand-in-connections-open"
                  disabled={saving}
                  onClick={() => openView('connections')}
                  summary={
                    <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs">
                      {(projectConfigured || !!role.connections?.length) && (
                        <span data-testid="stand-in-source-summary">
                          {projectConfigured &&
                            `${t('standIn.personal.collaboration')} · ${t(
                              role.collaboration.allProjects
                                ? 'standIn.personal.connected_all'
                                : 'standIn.personal.connected_selected',
                              { count: included.length }
                            )}`}
                          {projectConfigured && !!role.connections?.length && ' · '}
                          {!!role.connections?.length &&
                            t('standIn.workspace.source_connections', {
                              count: role.connections.length,
                            })}
                          {projectConfigured &&
                            !role.collaboration.enabled &&
                            receivingSources &&
                            ` · ${t('standIn.workspace.connection_receiving_paused')}`}
                        </span>
                      )}
                      {!receivingSources && (
                        <span data-testid="stand-in-sources-empty">
                          {t(
                            projectConfigured || role.connections?.length
                              ? 'standIn.personal.no_receiving_sources'
                              : 'standIn.personal.no_sources'
                          )}
                        </span>
                      )}
                    </span>
                  }
                />
              </>
            )}
            {(view === 'main' || view === 'create') && (
              <StandInSettingsEntry
                testId="stand-in-advanced-open"
                disabled={saving}
                onClick={() => openView('advanced')}
                label={t('standIn.workspace.execution_settings')}
                description={t('standIn.workspace.execution_settings_help')}
                footer={
                  <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-sm">
                    <span className="text-text-secondary">
                      {t('standIn.personal.execution_device')}
                    </span>
                    {deviceControl}
                  </div>
                }
              />
            )}
            {view === 'connections' && (
              <StandInConnectionSettings
                initialCalendar={calendarEntry}
                onDetailTitleChange={setConnectionTitle}
                onCalendarViewChange={calendarViewChanged}
                onDetailViewChange={setConnectionDetailOpen}
                hideHeading
                ref={connectionRef}
                onNavigate={navigation.requestLeave}
                role={role}
                savedConfiguration={saved?.roles.find(item => item.id === role.id)}
                scheduling={{ userId, roleId: role.id }}
                onScheduleDirtyChange={setScheduleDirty}
                tagDraft={tagDraft}
                projects={projects}
                focusedProjectId={initialProject?.id}
                disabled={saving}
                onChange={changeRole}
                api={services.standInApi}
                deviceId={executionDeviceId!}
                localDeviceId={state.currentDeviceId}
              />
            )}
            {view === 'advanced' && (
              <>
                <StandInComposer
                  key={role.id}
                  draft={role}
                  onChange={update =>
                    updateRole(role.id, current =>
                      typeof update === 'function'
                        ? (update(current) as StandInRole)
                        : (update as StandInRole)
                    )
                  }
                  onSave={async () => {
                    await save()
                  }}
                  disabled={saving}
                  submitDisabled={saving}
                  showPrompt={false}
                  deviceControl={deviceControl}
                  runtimeWork={runtimeWork}
                  devices={devices}
                  services={services}
                />
                <StandInTaskPermissionSettings
                  value={changingDevice ? undefined : role.taskPermissions}
                  disabled={saving || Boolean(changingDevice)}
                  onChange={taskPermissions =>
                    updateRole(role.id, current => ({ ...current, taskPermissions }))
                  }
                />
                <p className="text-xs text-text-secondary">
                  {t(
                    changingDevice
                      ? 'standIn.personal.device_change_permissions_help'
                      : 'standIn.personal.device_change_help'
                  )}
                </p>
                <StandInSettingsError
                  error={runtimeError}
                  retry={{ testId: 'stand-in-role-environment-retry', onClick: retryRuntimeWork }}
                />
              </>
            )}
            <StandInSettingsError
              error={state.error}
              retry={{
                testId: 'stand-in-reload',
                disabled: saving,
                onClick: () => requestLeave(state.reload),
              }}
            />
            {notice && (
              <p role="status" data-testid="stand-in-saved" className="text-sm text-text-secondary">
                {t('standIn.saved')}
              </p>
            )}
            <ConfirmDialog
              open={confirmDiscard}
              destructive
              title={t('standIn.personal.discard_help')}
              description={t('standIn.personal.discard_description')}
              cancelLabel={t('standIn.personal.keep_editing')}
              confirmLabel={t('standIn.personal.discard')}
              confirmTestId="stand-in-discard"
              cancelTestId="stand-in-keep-editing"
              onClose={() => {
                navigation.cancelLeave()
                setConfirmDiscard(false)
              }}
              onConfirm={() => {
                setDraft(saved)
                setSelectedId(saved?.roles.some(row => row.id === selectedId) ? selectedId : '')
                setRoleNameError(false)
                setConfirmDiscard(false)
                navigation.confirmLeave(() => onCancel?.())
              }}
            />
          </div>
          {view === 'main' && (
            <StandInSettingsShortcuts shortcuts={shortcuts} disabled={saving} onOpen={openView} />
          )}
          {shortcutPage?.content}
          {!scheduleDirty && !shortcutPage && (
            <StandInSettingsActions
              prefix="stand-in"
              busy={saving}
              leading={
                (footerLeading || canDeleteRole) && (
                  <>
                    {footerLeading}
                    {canDeleteRole && (
                      <ControlButton
                        type="button"
                        data-testid="stand-in-role-delete"
                        disabled={saving || loading}
                        onClick={() => setConfirmDelete(true)}
                        variant="destructive-ghost"
                        size="sm"
                      >
                        <Trash2 className="h-4 w-4" />
                        {t('standIn.personal.delete_role')}
                      </ControlButton>
                    )}
                  </>
                )
              }
              disabled={saving}
              saveDisabled={
                saving ||
                moving ||
                scheduleDirty ||
                connectionDraftDirty ||
                (view === 'project' && !projectRoleId)
              }
              onCancel={cancelView}
              onSave={() => void save(view === 'project' && projectEnabled)}
              saveLabel={t(
                saving
                  ? 'standIn.saving'
                  : view === 'project'
                    ? projectEnabled
                      ? 'standIn.personal.disable_project'
                      : 'standIn.personal.enable_and_use'
                    : view === 'create' && !initialProject
                      ? 'standIn.personal.create_title'
                      : view === 'connections'
                        ? 'standIn.personal.save_connections'
                        : 'standIn.save'
              )}
            >
              {view === 'connections' ? (
                <span className="mr-auto text-xs text-text-secondary">
                  {t('standIn.personal.connections_only')}
                </span>
              ) : initialProject && view === 'create' ? (
                <span
                  data-testid="stand-in-project-auto-connect"
                  className="mr-auto text-xs text-text-secondary"
                >
                  {t('standIn.personal.project_connect_help', { project: initialProject.name })}
                </span>
              ) : null}
            </StandInSettingsActions>
          )}
          {confirmDelete && saved && (
            <DialogSurface
              kind="alertdialog"
              onClose={() => {
                if (!saving) (() => setConfirmDelete(false))()
              }}
              modal={false}
              render={
                <div
                  aria-label={t('standIn.personal.delete_role')}
                  className="border-t border-border px-5 py-4"
                />
              }
            >
              <p className="text-sm">
                {t('standIn.personal.delete_role_help', {
                  name: role.name || t('standIn.personal.unnamed_assistant'),
                })}
              </p>
              <div className="mt-3 flex justify-end gap-2">
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="stand-in-role-delete-cancel"
                  disabled={saving}
                  onClick={() => setConfirmDelete(false)}
                  className="min-h-11 rounded-md px-3 hover:bg-muted md:min-h-8"
                >
                  {t('standIn.cancel')}
                </ControlButton>
                <ControlButton
                  variant="destructive"
                  size="sm"
                  type="button"
                  data-testid="stand-in-role-delete-confirm"
                  disabled={saving}
                  onClick={async () => {
                    const result = await state.save({
                      ...saved,
                      roles: saved.roles.filter(row => row.id !== role.id),
                    })
                    if (result) {
                      setConfirmDelete(false)
                      onDeleted?.()
                      onCancel?.()
                    }
                  }}
                >
                  {t('standIn.personal.confirm_delete_role')}
                </ControlButton>
              </div>
            </DialogSurface>
          )}
        </>
      ) : (
        <div className="px-5 pb-5">
          <StandInSettingsError
            error={state.error}
            retry={{ testId: 'stand-in-reload', onClick: state.reload }}
          />
        </div>
      )}
    </StandInSettingsPanel>
  )
}
