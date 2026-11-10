import { StandInImConnections } from './StandInImConnections'
import { useStandInPanelNavigation } from './useStandInPanelNavigation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useStandInOpened } from '@/telemetry/useStandInOpened'
import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
  type ReactNode,
} from 'react'
import { ChevronRight, Folder, Plus, Trash2 } from 'lucide-react'
import { dequal } from 'dequal'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
} from '@wegent/collaboration'
import {
  connectionChangeEnablesIdentity,
  newStandInRole,
  standInRoleName,
  roleIncludesProject,
  disconnectStandInProject,
  type PersonalStandInSettings,
  type StandInRole,
} from '@/api/personalStandIn'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { DeviceInfo, RuntimeWorkListResponse } from '@/types/api'
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
} from './StandInSettingsLayout'
import { StandInRequirements } from './StandInRequirements'
import { StandInComposer } from './StandInComposer'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { StandInCreationDevice } from './StandInCreationDevice'
import { useStableEvent } from '@/features/workbench/useStableEvent'
import { StandInBindingContext } from './StandInBindingContext'

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
  onRequestCreate?(): void
}

/** Resolve the creation device before opening an editor and preserve the unsaved-edit guard. */
export function StandInSettingsPage({ ref, ...props }: StandInSettingsPageProps) {
  const cloud = useContext(CloudConnectionContext)
  const binding = useContext(StandInBindingContext)
  const cloudCreation =
    !binding && cloud?.isConnected === true && props.initialProject?.project_store !== 'local'
  const [creation, setCreation] = useState(() => ({
    active: props.initialCreate ?? false,
    cloud: cloudCreation,
    userId: Number(cloud?.user?.id ?? props.userId),
  }))
  const editor = useRef<StandInSettingsHandle>(null)
  useImperativeHandle(ref, () => ({
    requestClose: () => (editor.current ? editor.current.requestClose() : props.onCancel?.()),
    requestLeave: action => (editor.current ? editor.current.requestLeave(action) : action()),
  }))
  const renderEditor = (deviceId = props.initialDeviceId, local = false) => (
    <StandInSettingsEditor
      key={`${deviceId ?? 'default'}:${creation.active ? 'create' : 'edit'}`}
      {...props}
      ref={editor}
      initialDeviceId={deviceId}
      userId={creation.active && creation.cloud && !local ? creation.userId : props.userId}
      initialCreate={creation.active}
      onRequestCreate={
        cloudCreation
          ? () =>
              setCreation({
                active: true,
                cloud: true,
                userId: Number(cloud?.user?.id ?? props.userId),
              })
          : undefined
      }
    />
  )
  return creation.active && creation.cloud ? (
    <StandInCreationDevice
      devices={props.devices}
      services={props.services}
      requestLeave={action => (editor.current ? editor.current.requestLeave(action) : action())}
    >
      {renderEditor}
    </StandInCreationDevice>
  ) : (
    renderEditor()
  )
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
  onRequestCreate,
  ref,
}: StandInSettingsPageProps) {
  useStandInOpened('settings', initialProfileId === '@primary' ? 'primary' : 'role')
  const { t } = useTranslation('common')
  const state = usePersonalStandIn(services, userId, initialDeviceId)
  const { draft, saved, setDraft, updateRole, loading, saving, setError } = state
  const [confirmDelete, setConfirmDelete] = useState(false)
  const executionDeviceId = draft?.executionDeviceId
  const [selectedId, setSelectedId] = useState(initialProfileId ?? '')
  const [view, setView] = useState<View>(
    initialCalendar ? 'connections' : initialProject ? 'project' : 'main'
  )
  const [history, setHistory] = useState<{ view: View; draft: PersonalStandInSettings | null }[]>(
    []
  )
  const [notice, setNotice] = useState(false)
  const [roleNameError, setRoleNameError] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [runtimeWork, setRuntimeWork] = useState<RuntimeWorkListResponse | null>(null)
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
  const [scheduleDirty, setScheduleDirty] = useState(false)
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
  const dirty = Boolean(draft && saved && !dequal(draft, saved)) || scheduleDirty
  useEffect(() => {
    onSavingChange?.(saving)
  }, [saving, onSavingChange])
  useEffect(() => {
    if (view !== 'advanced' || !executionDeviceId || !services.runtimeWorkApi) return
    let active = true
    void services.runtimeWorkApi
      .listRuntimeWork({ deviceId: executionDeviceId })
      .then(value => {
        if (active) setRuntimeWork(value)
      })
      .catch(cause => {
        if (active) setError(getStandInErrorMessage(cause))
      })
    return () => {
      active = false
    }
  }, [view, executionDeviceId, services, setError])

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
      const previous = entry?.draft ?? saved
      if (previous) setDraft(previous)
      setSelectedId(previous?.roles.some(row => row.id === selectedId) ? selectedId : '')
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
      connectionRef.current.requestLeave(() => navigation.requestLeave(action))
    else navigation.requestLeave(action)
  })
  const close = () =>
    connectionRef.current ? connectionRef.current.requestLeave(closeView) : closeView()
  const closeSettings = () => requestLeave(() => onCancel?.())
  const dialogRef = useDialogKeyboard<HTMLElement>(
    close,
    Boolean(initialCreate || initialProfileId) && !confirmDiscard
  )
  useImperativeHandle(ref, () => ({
    requestClose: closeSettings,
    requestLeave,
  }))
  const save = async (disconnectProject = false) => {
    if (!draft || !role) return
    if (view === 'create' && !role.name.trim()) {
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
    if (!initialCreate && onRequestCreate) {
      requestLeave(onRequestCreate)
      return
    }
    if (!draft) return
    const added = newStandInRole(draft.executionDeviceId)
    added.enabled = true
    if (projectRef && initialProject) {
      added.name = t('standIn.personal.project_role_name', { project: initialProject.name })
      added.collaboration = {
        ...added.collaboration,
        enabled: true,
        allProjects: false,
        projects: [projectRef],
      }
    }
    setRoleNameError(false)
    const roles = draft.roles.map((row, index) =>
      row.name
        ? row
        : {
            ...row,
            name: standInRoleName(row, index, t('standIn.personal.default_role')),
          }
    )
    setHistory(current => [...current, { view, draft }])
    setDraft({ ...draft, roles: [...roles, added] })
    setSelectedId(added.id)
    setView('create')
    setNotice(false)
  }, [
    draft,
    initialCreate,
    initialProject,
    onRequestCreate,
    projectRef,
    requestLeave,
    setDraft,
    t,
    view,
  ])
  const createdInitialRole = useRef(false)
  useEffect(() => {
    if (initialCreate && draft && !loading && !createdInitialRole.current) {
      createdInitialRole.current = true
      createRole()
    }
  }, [initialCreate, loading, draft, createRole])
  const availableProjects = projects.filter(
    project =>
      project.project_store !== 'local' || draft?.executionDeviceId === state.currentDeviceId
  )
  const included = role
    ? availableProjects.filter(project =>
        roleIncludesProject(role, {
          id: project.id,
          store: project.project_store === 'local' ? 'local' : 'cloud',
        })
      )
    : []
  const title = view === 'main' ? 'personal.settings_title' : `personal.${view}_title`

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
                className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-text-muted hover:bg-muted disabled:opacity-40"
              >
                <Plus className="h-4 w-4" />
                {t('standIn.personal.add_role')}
              </button>
            )
          }
        />
        {loading ? (
          <p role="status" className="px-5 py-8 text-text-muted">
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
                    className="min-h-9 rounded-md border border-border bg-background px-2"
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
                    {role.collaboration.enabled || role.connections?.length ? (
                      <div
                        className="flex items-start gap-3 py-2 text-sm text-text-secondary"
                        data-testid="stand-in-source-summary"
                      >
                        <Folder className="mt-0.5 h-4 w-4 shrink-0" />
                        <div>
                          {role.collaboration.enabled && (
                            <>
                              <p>{t('standIn.personal.collaboration')}</p>
                              <p className="mt-1 text-xs text-text-muted">
                                {t(
                                  role.collaboration.allProjects
                                    ? 'standIn.personal.connected_all'
                                    : 'standIn.personal.connected_selected',
                                  { count: included.length }
                                )}
                              </p>
                            </>
                          )}
                          {!!role.connections?.length && (
                            <p className="mt-1 text-xs text-text-muted">
                              {t('standIn.workspace.source_connections', {
                                count: role.connections.length,
                              })}
                            </p>
                          )}
                        </div>
                      </div>
                    ) : (
                      <p className="text-sm text-text-muted" data-testid="stand-in-sources-empty">
                        {t('standIn.personal.no_sources')}
                      </p>
                    )}
                  </div>
                </>
              )}
              {view === 'main' && (
                <StandInImConnections
                  services={services}
                  devices={devices}
                  deviceId={draft.executionDeviceId}
                  roleId={role.id}
                  disabled={saving}
                />
              )}
              {(view === 'main' || view === 'create') && (
                <>
                  <button
                    type="button"
                    data-testid="stand-in-advanced-open"
                    disabled={saving}
                    onClick={() => openView('advanced')}
                    className="flex w-full items-center gap-2 border-t border-border pt-4 text-left"
                  >
                    <span className="flex-1 font-medium">{t('standIn.personal.more')}</span>
                    <span className="text-xs text-text-muted">
                      {t('standIn.personal.more_summary')}
                    </span>
                    <ChevronRight className="h-4 w-4" />
                  </button>
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
                  projects={projects}
                  focusedProjectId={initialProject?.id}
                  disabled={saving}
                  onChange={changeRole}
                  api={services.standInApi}
                  deviceId={draft.executionDeviceId}
                  localDeviceId={state.currentDeviceId}
                />
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
                  deviceControl={
                    initialCreate ? null : (
                      <StandInDeviceSelect
                        value={draft.executionDeviceId}
                        currentDeviceId={state.currentDeviceId}
                        devices={devices}
                        disabled={saving || dirty}
                        onChange={value => {
                          setHistory(current => current.map(entry => ({ ...entry, draft: null })))
                          setSelectedId('')
                          setNotice(false)
                          state.setDeviceId(value)
                        }}
                      />
                    )
                  }
                />
              )}
              {state.error && (
                <div role="alert" className="text-sm text-error">
                  <p>{state.error}</p>
                  <button
                    type="button"
                    data-testid="stand-in-reload"
                    disabled={saving}
                    onClick={state.reload}
                    className="mt-1 underline"
                  >
                    {t('standIn.reload')}
                  </button>
                </div>
              )}
              {notice && (
                <p role="status" data-testid="stand-in-saved" className="text-sm text-text-muted">
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
                  setConfirmDiscard(false)
                  navigation.confirmLeave(() => onCancel?.())
                }}
              />
            </div>
            {view === 'main' && management}
            {!scheduleDirty && (
              <StandInSettingsActions
                prefix="stand-in"
                leading={footerLeading}
                disabled={saving}
                saveDisabled={saving || scheduleDirty || (view === 'project' && !projectRoleId)}
                onCancel={close}
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
                      className="inline-flex min-h-9 items-center gap-2 rounded-md px-2 text-sm text-error hover:bg-muted"
                    >
                      <Trash2 className="h-4 w-4" />
                      {t('standIn.personal.delete_role')}
                    </button>
                  )}
                <span className="mr-auto text-xs text-text-muted">
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
                    className="min-h-8 rounded-md px-3 hover:bg-muted"
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
                    className="min-h-8 rounded-md bg-text-primary px-3 text-background disabled:opacity-50"
                  >
                    {t('standIn.personal.confirm_delete_role')}
                  </button>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="px-5 pb-5" role="alert">
            <p className="text-error">{state.error}</p>
            <button
              type="button"
              data-testid="stand-in-reload"
              onClick={state.reload}
              className="mt-2 underline"
            >
              {t('standIn.reload')}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
