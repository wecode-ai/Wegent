import { createStandInOpenedReceipt } from '@/telemetry/standInOpenedReceipt'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Ref,
  type ReactNode,
} from 'react'
import { Folder, Plus, Trash2 } from 'lucide-react'
import { dequal } from 'dequal'
import { createTagDraft } from '@wegent/collaboration'
import { useFocusRequest } from '@wegent/collaboration/dom-events'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import {
  connectionChangeEnablesIdentity,
  standInRoleName,
  roleIncludesProject,
  roleSelectsProject,
  disconnectStandInProject,
  type PersonalStandInSettings,
  type StandInRole,
} from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo } from '@/types/api'
import { useTranslation } from '@/hooks/useTranslation'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { usePersonalStandIn } from './usePersonalStandIn'
import { StandInProjectSetup } from './StandInProjectSetup'
import {
  StandInConnectionSettings,
  type StandInConnectionNavigationHandle,
} from './StandInConnectionSettings'
import { StandInDeviceSelect } from './StandInDeviceSelect'
import {
  StandInSettingsHeader,
  StandInSettingsActions,
  StandInSettingsEntry,
  StandInSettingsError,
} from './StandInSettingsLayout'
import { StandInRequirements } from './StandInRequirements'
import { StandInComposer } from './StandInComposer'
import { useStandInRuntimeWork } from './useStandInRuntimeWork'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { saveStandInRoleDevice } from './saveStandInRoleDevice'
import { createStandInRoleDraft } from './standInRoleDraft'

type View = 'project' | 'main' | 'connections' | 'advanced' | 'create'
export interface StandInSettingsHandle {
  requestClose(): void
  requestLeave(action: () => void): void
}

interface StandInSettingsPageProps {
  management?: ReactNode
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
  management,
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
      defaultRoleName: t('standIn.personal.default_role'),
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
    view === 'advanced'
  )

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
  const dialogRef = useDialogKeyboard<HTMLElement>(
    close,
    Boolean(initialCreate || initialProfileId) && !confirmDiscard
  )
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
    const previousRole = saved?.roles.find(row => row.id === role.id)
    const changingDevice = previousRole
      ? changedRole.executionDeviceId !== previousRole.executionDeviceId
      : changedRole.executionDeviceId !== value.executionDeviceId &&
        changedRole.executionDeviceId !== state.loadedDeviceId
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
  const title = view === 'main' ? 'personal.settings_title' : `personal.${view}_title`
  const projectConfigured =
    role && (role.collaboration.allProjects || role.collaboration.projects.length > 0)
  const receivingSources = Boolean(
    role?.enabled && ((projectConfigured && role.collaboration.enabled) || role.connections?.length)
  )

  return (
    <section
      ref={dialogRef}
      className={`min-h-0 px-5 text-base text-text-primary ${calendarOpen ? 'overflow-hidden' : 'overflow-y-auto'} ${initialProject ? '' : 'h-full'}`}
      data-testid="stand-in-page"
    >
      <div
        className={
          calendarOpen ? 'flex h-full min-h-0 w-full flex-col' : 'flex min-h-full w-full flex-col'
        }
        data-testid="stand-in-settings"
      >
        <StandInSettingsHeader
          path={[
            {
              label: t('standIn.personal.settings_title'),
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
                      label: t('standIn.personal.advanced_title'),
                      testId: 'stand-in-path-advanced',
                    },
                  ]
                : []),
          ]}
          title={
            initialProject && (view === 'project' || view === 'create')
              ? t('standIn.personal.project_title', { project: initialProject.name })
              : t(`standIn.${title}`)
          }
          description={t(
            initialProject && (view === 'project' || view === 'create')
              ? 'standIn.personal.project_description'
              : view === 'main'
                ? 'standIn.personal.description'
                : view === 'connections'
                  ? 'standIn.personal.connections_help'
                  : view === 'create'
                    ? 'standIn.personal.create_help'
                    : 'standIn.personal.advanced_help',
            { project: initialProject?.name }
          )}
          disabled={saving}
          back={
            view !== (initialProject ? 'project' : 'main')
              ? {
                  testId:
                    view === 'connections' && connectionDetailOpen
                      ? 'stand-in-connections-back'
                      : 'stand-in-back',
                  onClick: () => {
                    if (view === 'connections' && connectionDetailOpen)
                      connectionRef.current?.back()
                    else close()
                  },
                }
              : onCancel
                ? { testId: 'stand-in-settings-back', onClick: closeSettings }
                : undefined
          }
          close={onCancel ? { testId: 'stand-in-close', onClick: closeSettings } : undefined}
          actions={
            view === 'main' &&
            !initialProject && (
              <button
                type="button"
                data-testid="stand-in-list-configure"
                disabled={saving || loading}
                onClick={createRole}
                className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-md px-2 text-sm text-text-secondary hover:bg-muted disabled:opacity-40 md:min-h-8"
              >
                <Plus className="h-4 w-4" />
                {t('standIn.personal.add_role')}
              </button>
            )
          }
        />
        {loading ? (
          <p role="status" className="px-5 py-8 text-text-secondary">
            {t('standIn.loading')}
          </p>
        ) : draft && role ? (
          <>
            <div className={calendarOpen ? 'flex min-h-0 flex-1 flex-col' : 'space-y-5 pb-5'}>
              {initialProject && (view === 'project' || view === 'create') && (
                <StandInProjectSetup
                  project={initialProject}
                  roles={draft.roles.filter(row => view !== 'create' || row.id !== role.id)}
                  projectRoleId={projectRoleId}
                  role={role}
                  onOpenSettings={
                    onOpenPersonalSettings
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
              )}
              {(view === 'main' || view === 'create') && (
                <label className="grid gap-2">
                  <span className="text-text-secondary">
                    {t(
                      initialProject
                        ? 'standIn.personal.stand_in_name'
                        : 'standIn.personal.role_name'
                    )}
                  </span>
                  <input
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
                    className="min-h-11 rounded-md border border-border bg-background px-2 placeholder:text-text-secondary md:min-h-9"
                    placeholder={
                      view === 'create'
                        ? t('standIn.personal.role_name_placeholder')
                        : standInRoleName(
                            role,
                            draft.roles.indexOf(role),
                            t('standIn.personal.default_role')
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
                    services={services}
                    onChange={update => updateRole(role.id, update)}
                    disabled={saving}
                    onSave={() => void save()}
                  />
                </div>
              )}
              {(view === 'main' || (view === 'create' && !initialProject)) && (
                <>
                  <div>
                    <StandInSettingsEntry
                      label={t('standIn.workspace.connections')}
                      description={t('standIn.workspace.connections_help')}
                      testId="stand-in-connections-open"
                      disabled={saving}
                      onClick={() => openView('connections')}
                    />
                    {projectConfigured || role.connections?.length ? (
                      <div
                        className="flex items-start gap-3 py-2 text-sm text-text-secondary"
                        data-testid="stand-in-source-summary"
                      >
                        <Folder className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          {projectConfigured && (
                            <>
                              <p>{t('standIn.personal.collaboration')}</p>
                              <p className="mt-1 text-xs text-text-secondary">
                                {t(
                                  role.collaboration.allProjects
                                    ? 'standIn.personal.connected_all'
                                    : 'standIn.personal.connected_selected',
                                  { count: included.length }
                                )}
                              </p>
                              {!role.collaboration.enabled && receivingSources && (
                                <p className="mt-1 text-xs text-text-secondary">
                                  {t('standIn.workspace.connection_receiving_paused')}
                                </p>
                              )}
                            </>
                          )}
                          {!!role.connections?.length && (
                            <p className="mt-1 text-xs text-text-secondary">
                              {t('standIn.workspace.source_connections', {
                                count: role.connections.length,
                              })}
                            </p>
                          )}
                        </div>
                      </div>
                    ) : null}
                    {!receivingSources && (
                      <p
                        className="text-sm text-text-secondary"
                        data-testid="stand-in-sources-empty"
                      >
                        {t(
                          projectConfigured || role.connections?.length
                            ? 'standIn.personal.no_receiving_sources'
                            : 'standIn.personal.no_sources'
                        )}
                      </p>
                    )}
                  </div>
                </>
              )}
              {(view === 'main' || view === 'create') && (
                <>
                  <StandInSettingsEntry
                    testId="stand-in-advanced-open"
                    disabled={saving}
                    onClick={() => openView('advanced')}
                    label={t('standIn.personal.more')}
                    description={t('standIn.personal.more_summary')}
                  />
                </>
              )}
              {view === 'connections' && (
                <StandInConnectionSettings
                  initialCalendar={calendarEntry}
                  onDetailTitleChange={setConnectionTitle}
                  onCalendarViewChange={calendarViewChanged}
                  onDetailViewChange={setConnectionDetailOpen}
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
              {(view === 'main' || view === 'create' || view === 'advanced') && (
                <label className="grid gap-2 text-sm">
                  <span className="text-text-secondary">
                    {t('standIn.personal.execution_device')}
                  </span>
                  <StandInDeviceSelect
                    testId="stand-in-role-device"
                    ariaLabel={t('standIn.personal.execution_device')}
                    value={role.executionDeviceId}
                    currentDeviceId={state.currentDeviceId}
                    devices={userId === 0 ? [] : devices}
                    disabled={saving || moving}
                    onChange={value => {
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
                  <span className="text-xs text-text-secondary">
                    {t('standIn.personal.device_change_help')}
                  </span>
                </label>
              )}
              {view === 'advanced' && (
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
                  runtimeWork={runtimeWork}
                  devices={devices}
                  services={services}
                />
              )}
              {view === 'advanced' && (
                <StandInSettingsError
                  error={runtimeError}
                  retry={{ testId: 'stand-in-role-environment-retry', onClick: retryRuntimeWork }}
                />
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
                <p
                  role="status"
                  data-testid="stand-in-saved"
                  className="text-sm text-text-secondary"
                >
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
            {view === 'main' && management}
            {!scheduleDirty && (
              <StandInSettingsActions
                prefix="stand-in"
                busy={saving}
                leading={footerLeading}
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
                        ? 'standIn.personal.create_role'
                        : view === 'connections'
                          ? 'standIn.personal.save_connections'
                          : 'standIn.save'
                )}
              >
                {initialProfileId &&
                  !initialProject &&
                  view === 'main' &&
                  saved?.roles.some(row => row.id === role.id) && (
                    <button
                      type="button"
                      data-testid="stand-in-role-delete"
                      disabled={saving || loading}
                      onClick={() => setConfirmDelete(true)}
                      className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-sm text-error hover:bg-muted md:min-h-9"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('standIn.personal.delete_role')}
                    </button>
                  )}
                <span className="mr-auto text-xs text-text-secondary">
                  {view === 'connections' ? (
                    t('standIn.personal.connections_only')
                  ) : initialProject && view === 'create' ? (
                    <span data-testid="stand-in-project-auto-connect">
                      {t('standIn.personal.project_connect_help', { project: initialProject.name })}
                    </span>
                  ) : (
                    ''
                  )}
                </span>
              </StandInSettingsActions>
            )}
            {confirmDelete && saved && (
              <div
                role="alertdialog"
                aria-label={t('standIn.personal.delete_role')}
                className="border-t border-border px-5 py-4"
              >
                <p className="text-sm">
                  {t('standIn.personal.delete_role_help', {
                    name: role.name || t('standIn.personal.default_role'),
                  })}
                </p>
                <div className="mt-3 flex justify-end gap-2">
                  <button
                    type="button"
                    data-testid="stand-in-role-delete-cancel"
                    disabled={saving}
                    onClick={() => setConfirmDelete(false)}
                    className="min-h-11 rounded-md px-3 hover:bg-muted md:min-h-8"
                  >
                    {t('standIn.cancel')}
                  </button>
                  <button
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
                    className="min-h-11 rounded-md bg-text-primary px-3 text-background disabled:opacity-50 md:min-h-8"
                  >
                    {t('standIn.personal.confirm_delete_role')}
                  </button>
                </div>
              </div>
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
      </div>
    </section>
  )
}
