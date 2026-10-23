import {
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import { ArrowLeft, Bot, ChevronRight, Folder, Plus, X } from 'lucide-react'
import { dequal } from 'dequal'
import type {
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceStandInSettings,
  WorkspaceProjectAgent,
} from '@wegent/collaboration'
import {
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
import { useStandInProjectAgents, projectAgentChoiceValue } from './useStandInProjectAgents'
import { usePersonalStandIn } from './usePersonalStandIn'
import { StandInProjectSetup } from './StandInProjectSetup'
import { StandInConnections } from './StandInConnections'
import { StandInDingTalkConnections } from './StandInDingTalkConnections'
import { StandInRoleScheduling } from './StandInRoleScheduling'
import { StandInRequirements } from './StandInRequirements'
import { StandInComposer } from './StandInComposer'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'

type View = 'project' | 'main' | 'connections' | 'scheduling' | 'advanced' | 'create'
export interface StandInSettingsHandle {
  requestClose(): void
}

export function StandInSettingsPage({
  api,
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
  onSavingChange,
  onOpenPersonalSettings,
  ref,
}: {
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
  onSavingChange?(saving: boolean): void
  onOpenPersonalSettings?(roleId: string, deviceId: string): void
  ref?: Ref<StandInSettingsHandle>
}) {
  const { t } = useTranslation('common')
  const cloudConnection = useContext(CloudConnectionContext)
  const canLoadPersonalAgents = cloudConnection?.isConnected ?? true
  const state = usePersonalStandIn(services, userId, initialDeviceId, canLoadPersonalAgents)
  const { draft, saved, setDraft, updateRole, loading, saving, setError } = state
  const executionDeviceId = draft?.executionDeviceId
  const [selectedId, setSelectedId] = useState(initialProfileId ?? '')
  const [view, setView] = useState<View>(initialProject ? 'project' : 'main')
  const [history, setHistory] = useState<{ view: View; draft: PersonalStandInSettings | null }[]>(
    []
  )
  const [notice, setNotice] = useState(false)
  const [roleNameError, setRoleNameError] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [personalAgentDetail, setPersonalAgentDetail] = useState<{
    id: number
    agent: WorkspaceProjectAgent
  } | null>(null)
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
  const firstProjectRole =
    projectRef &&
    draft?.roles.find(
      row =>
        !row.agentProject ||
        (row.agentProject.id === projectRef.id && row.agentProject.store === projectRef.store)
    )
  const projectRoleId = selectedId || connectedRole?.id || firstProjectRole?.id || ''
  const role =
    draft?.roles.find(role => role.id === (initialProject ? projectRoleId : selectedId)) ??
    (initialProject &&
      draft?.roles.find(role =>
        roleIncludesProject(role, {
          id: initialProject.id,
          store: initialProject.project_store === 'local' ? 'local' : 'cloud',
        })
      )) ??
    draft?.roles[0]
  const selectedResourceId = role?.agentResourceId
  useEffect(() => {
    if (view !== 'advanced' || !selectedResourceId || !services.agentResourceApi) return
    let active = true
    void services.agentResourceApi
      .getAgent(selectedResourceId)
      .then(detail => {
        if (active)
          setPersonalAgentDetail({
            id: selectedResourceId,
            agent: {
              id: String(detail.teamId),
              name: detail.displayName || detail.name,
              runtime: detail.runtime ?? undefined,
              modelPolicy: detail.modelPolicy,
              executionPolicy: detail.executionPolicy,
            },
          })
      })
      .catch(cause => {
        if (active) setError(String(cause))
      })
    return () => {
      active = false
    }
  }, [view, selectedResourceId, services, setError])
  const multiple = Boolean(draft && draft.roles.length > 1)
  const dirty = Boolean(draft && saved && !dequal(draft, saved))
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
        if (active) setError(String(cause))
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
    setSelectedId(value.id)
    updateRole(value.id, () => value)
  }
  const close = () => {
    if (saving) return
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
  const closeSettings = () => {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else onCancel?.()
  }
  const dialogRef = useDialogKeyboard<HTMLElement>(
    close,
    Boolean(initialCreate || initialProfileId)
  )
  useImperativeHandle(ref, () => ({ requestClose: closeSettings }))
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
    if (initialProject && ['project', 'main', 'create'].includes(view))
      onSaved?.(result.roles.find(row => row.id === role.id) ?? result.roles[0])
    else if (view !== 'main') setView('main')
    else onSaved?.(result.roles.find(row => row.id === role.id) ?? result.roles[0])
  }
  const createRole = useCallback(() => {
    if (!draft) return
    const added = newStandInRole(draft.executionDeviceId)
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
  }, [draft, initialProject, projectRef, setDraft, t, view])
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
  const projectCatalog = useStandInProjectAgents(
    api,
    initialProject
      ? availableProjects.filter(
          project =>
            project.id === initialProject.id &&
            project.project_store === initialProject.project_store
        )
      : availableProjects
  )
  const selectedProjectValue =
    role?.agentId && role.agentProject
      ? projectAgentChoiceValue({ id: role.agentId, project: role.agentProject })
      : 'project-reference'
  const included = role
    ? availableProjects.filter(project =>
        roleIncludesProject(role, {
          id: project.id,
          store: project.project_store === 'local' ? 'local' : 'cloud',
        })
      )
    : []
  const selectedAgentMissing =
    role?.agentResourceId && !state.agents.some(agent => agent.id === role.agentResourceId)
  const title = view === 'main' ? 'personal.settings_title' : `personal.${view}_title`
  const agentField = role && (
    <div
      className={
        initialProject && view === 'create'
          ? 'space-y-2'
          : 'grid grid-cols-[7rem_minmax(0,1fr)] items-start gap-x-3 gap-y-1'
      }
    >
      <label htmlFor="stand-in-agent" className="flex min-h-8 items-center text-text-secondary">
        {t('standIn.personal.execution_agent')}
      </label>
      <div className="min-w-0">
        <div className="flex min-h-8 items-center gap-2 rounded-md border border-border px-2">
          <Bot className="h-4 w-4 shrink-0 text-text-muted" />
          <select
            id="stand-in-agent"
            data-testid="stand-in-agent"
            disabled={saving}
            value={role.agentResourceId ?? (role.agentId ? selectedProjectValue : '')}
            onChange={event => {
              const selected = projectCatalog.choices.find(
                choice => projectAgentChoiceValue(choice) === event.target.value
              )
              changeRole({
                ...role,
                agentResourceId:
                  selected || !event.target.value ? null : Number(event.target.value),
                agentId: selected?.id ?? null,
                agentProject: selected?.project,
                model: null,
                collaboration: selected
                  ? {
                      ...role.collaboration,
                      enabled: true,
                      allProjects: false,
                      projects: [selected.project],
                      excludedProjects: [],
                    }
                  : role.collaboration,
              })
            }}
            className="min-h-8 min-w-0 flex-1 bg-transparent text-sm outline-none"
          >
            <option value="">{t('standIn.default_agent')}</option>
            {role.agentId &&
              !projectCatalog.choices.some(
                choice => projectAgentChoiceValue(choice) === selectedProjectValue
              ) && (
                <option value={selectedProjectValue}>{t('standIn.personal.project_agent')}</option>
              )}
            {selectedAgentMissing && (
              <option value={role.agentResourceId!}>{t('standIn.agent_unavailable')}</option>
            )}
            {state.agents.map(agent => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
            {projectCatalog.choices.length > 0 && (
              <optgroup label={t('standIn.personal.project_agents')}>
                {projectCatalog.choices.map(choice => (
                  <option
                    key={projectAgentChoiceValue(choice)}
                    value={projectAgentChoiceValue(choice)}
                  >
                    {choice.name} · {choice.projectName}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        {role.agentProject && (
          <p data-testid="stand-in-project-agent-scope" className="mt-2 text-xs text-text-muted">
            {t('standIn.personal.project_agent_scope', {
              project:
                projects.find(project => project.id === role.agentProject?.id)?.name ??
                role.agentProject.id,
            })}
          </p>
        )}
        {canLoadPersonalAgents && state.agentError && (
          <p className="mt-1 text-xs text-text-muted" role="status">
            {t('standIn.personal.catalog_unavailable')}
            <button
              type="button"
              data-testid="stand-in-agents-retry"
              disabled={saving}
              onClick={state.reloadAgents}
              className="ml-2 underline"
            >
              {t('standIn.reload')}
            </button>
          </p>
        )}
      </div>
    </div>
  )

  return (
    <section
      ref={dialogRef}
      className={`min-h-0 overflow-y-auto text-base text-text-primary ${initialProject ? '' : 'h-full bg-muted/30 p-5'}`}
      data-testid="stand-in-page"
    >
      <div
        className={`mx-auto w-full max-w-xl ${initialProject ? '' : 'rounded-2xl border border-border bg-background shadow-sm'}`}
        data-testid="stand-in-settings"
      >
        <header className="flex items-start gap-3 px-5 pb-5 pt-5">
          {view !== (initialProject ? 'project' : 'main') && (
            <button
              type="button"
              onClick={close}
              disabled={saving}
              data-testid="stand-in-back"
              aria-label={t('standIn.personal.back')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0 flex-1">
            <h1 className="heading-sm">
              {initialProject && (view === 'project' || view === 'create')
                ? t('standIn.personal.project_title', { project: initialProject.name })
                : t(`standIn.${title}`)}
            </h1>
            <p className="mt-1 text-sm text-text-muted">
              {t(
                initialProject && (view === 'project' || view === 'create')
                  ? 'standIn.personal.project_description'
                  : view === 'main'
                    ? 'standIn.personal.description'
                    : view === 'connections'
                      ? 'standIn.personal.connections_help'
                      : view === 'scheduling'
                        ? 'standIn.personal.scheduling_help'
                        : view === 'create'
                          ? 'standIn.personal.create_help'
                          : 'standIn.personal.advanced_help',
                { project: initialProject?.name }
              )}
            </p>
          </div>
          {view === 'main' && !initialProject && (
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
          )}
          {onCancel && (
            <button
              type="button"
              data-testid="stand-in-close"
              disabled={saving}
              aria-label={t('standIn.close')}
              onClick={closeSettings}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </header>
        {!initialProject && !!draft?.selectionErrors?.length && (
          <div
            role="alert"
            data-testid="stand-in-selection-errors"
            className="m-5 rounded-lg border border-border p-3"
          >
            <p>{t('standIn.personal.selection_failed')}</p>
            {draft.selectionErrors.map(item => (
              <p key={item.issueId} className="mt-1 text-xs text-text-muted">
                {item.title}
              </p>
            ))}
            <button
              type="button"
              data-testid="stand-in-selection-retry"
              disabled={saving}
              onClick={() => void state.save()}
              className="mt-2 text-primary"
            >
              {t('standIn.personal.selection_retry')}
            </button>
          </div>
        )}
        {loading ? (
          <p role="status" className="px-5 py-8 text-text-muted">
            {t('standIn.loading')}
          </p>
        ) : draft && role ? (
          <>
            <div className="space-y-5 px-5 pb-5">
              {multiple && view === 'main' && !initialProject && (
                <label className="grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3">
                  <span className="text-text-secondary">{t('standIn.personal.current_role')}</span>
                  <select
                    data-testid="stand-in-role-select"
                    value={role.id}
                    disabled={saving}
                    onChange={event => setSelectedId(event.target.value)}
                    className="min-h-9 rounded-md border border-border bg-transparent px-2"
                  >
                    {draft.roles.map((row, index) => (
                      <option key={row.id} value={row.id}>
                        {standInRoleName(row, index, t('standIn.personal.default_role'))}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {initialProject && (view === 'project' || view === 'create') && (
                <StandInProjectSetup
                  project={initialProject}
                  roles={draft.roles.filter(row => view !== 'create' || row.id !== role.id)}
                  projectRoleId={projectRoleId}
                  role={role}
                  agents={state.agents}
                  projectAgents={projectCatalog.choices}
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
              {view === 'create' && (
                <label
                  className={
                    initialProject
                      ? 'flex flex-col gap-2'
                      : 'grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-3'
                  }
                >
                  <span className="text-text-secondary">
                    {t(
                      initialProject
                        ? 'standIn.personal.stand_in_name'
                        : 'standIn.personal.role_name'
                    )}
                  </span>
                  <input
                    autoFocus
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
                    placeholder={t('standIn.personal.role_name_placeholder')}
                  />
                  {roleNameError && (
                    <span
                      id="stand-in-role-name-error"
                      role="alert"
                      className="col-start-2 text-xs text-error"
                    >
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
              {(view === 'main' || view === 'create') && agentField}
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
                  <div className="border-t border-border pt-4">
                    <div className="mb-3 flex items-center justify-between gap-3">
                      <h2 className="font-medium">{t('standIn.personal.sources')}</h2>
                      <button
                        type="button"
                        data-testid="stand-in-connections-open"
                        disabled={saving}
                        onClick={() => openView('connections')}
                        className="flex min-h-8 items-center gap-1 text-text-secondary hover:text-text-primary"
                      >
                        {t('standIn.personal.manage')}
                        <ChevronRight className="h-4 w-4" />
                      </button>
                    </div>
                    {role.collaboration.enabled || role.dingtalk?.length ? (
                      <div
                        className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-4"
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
                          {!!role.dingtalk?.length && (
                            <p className="mt-1 text-xs text-text-muted">
                              {t('standIn.workspace.dingtalk_connections', {
                                count: role.dingtalk.length,
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
                    <button
                      type="button"
                      data-testid="stand-in-add-source"
                      disabled={saving}
                      onClick={() => openView('connections')}
                      className="mt-2 inline-flex min-h-9 items-center gap-1 text-primary"
                    >
                      <Plus className="h-4 w-4" />
                      {t('standIn.personal.add_source')}
                    </button>
                  </div>
                </>
              )}
              {(view === 'main' || view === 'create') && (
                <>
                  <div className="border-t border-border pt-4">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">{t('standIn.workspace.receive_new')}</span>
                      <button
                        type="button"
                        role="switch"
                        data-testid="stand-in-auto"
                        aria-label={t('standIn.personal.automatic')}
                        aria-checked={role.enabled}
                        disabled={saving}
                        onClick={() => changeRole({ ...role, enabled: !role.enabled })}
                        className={`inline-flex h-6 w-10 shrink-0 items-center rounded-full p-0.5 ${role.enabled ? 'bg-text-primary' : 'bg-border'}`}
                      >
                        <span
                          className={`h-5 w-5 rounded-full bg-background transition-transform ${role.enabled ? 'translate-x-4' : ''}`}
                        />
                      </button>
                    </div>
                    <p
                      className="mt-1 text-xs text-text-muted"
                      data-testid={dirty ? 'stand-in-pending-save' : undefined}
                    >
                      {t('standIn.workspace.pause_help')}
                    </p>
                  </div>
                  {multiple && view === 'main' && (
                    <button
                      type="button"
                      data-testid="stand-in-scheduling-open"
                      disabled={saving}
                      onClick={() => openView('scheduling')}
                      className="flex w-full items-center gap-2 border-t border-border pt-4 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="font-medium">{t('standIn.personal.scheduling')}</span>
                        <span className="mt-1 block text-xs text-text-muted">
                          {t('standIn.personal.shared_scheduling')}
                        </span>
                      </span>
                      <span className="text-xs text-text-muted">
                        {t(
                          draft.autoSelect
                            ? 'standIn.personal.ai_selection'
                            : 'standIn.personal.order_selection'
                        )}
                      </span>
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  )}
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
                <>
                  <StandInConnections
                    role={role}
                    projects={availableProjects}
                    focusedProjectId={initialProject?.id}
                    disabled={saving}
                    onChange={changeRole}
                  />
                  {services.standInApi && (
                    <StandInDingTalkConnections
                      role={role}
                      api={services.standInApi}
                      deviceId={draft.executionDeviceId}
                      localDeviceId={state.currentDeviceId}
                      disabled={saving}
                      onChange={changeRole}
                    />
                  )}
                </>
              )}
              {view === 'scheduling' && (
                <StandInRoleScheduling settings={draft} onChange={setDraft} disabled={saving} />
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
                  controls={null}
                  selectedAgent={
                    role.agentResourceId
                      ? personalAgentDetail?.id === role.agentResourceId
                        ? personalAgentDetail.agent
                        : undefined
                      : projectCatalog.choices.find(
                          choice => projectAgentChoiceValue(choice) === selectedProjectValue
                        )?.agent
                  }
                  showPrompt={false}
                  runtimeWork={runtimeWork}
                  devices={devices}
                  services={services}
                  deviceControl={
                    <select
                      data-testid="stand-in-device"
                      aria-label={t('standIn.device')}
                      value={draft.executionDeviceId}
                      disabled={saving || dirty}
                      onChange={event => {
                        setHistory(current => current.map(entry => ({ ...entry, draft: null })))
                        setSelectedId('')
                        setNotice(false)
                        state.setDeviceId(event.target.value)
                      }}
                      className="min-h-8 max-w-full bg-transparent px-2"
                    >
                      <option value={state.currentDeviceId}>{t('standIn.current_device')}</option>
                      {devices
                        .filter(
                          device =>
                            device.device_id !== state.currentDeviceId &&
                            device.app_device_id !== state.currentDeviceId
                        )
                        .map(device => (
                          <option
                            key={device.device_id}
                            value={device.device_id}
                            disabled={device.status === 'offline'}
                          >
                            {device.name}
                          </option>
                        ))}
                    </select>
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
              {confirmDiscard && (
                <div role="alert" className="rounded-md border border-border p-3">
                  <p>{t('standIn.personal.discard_help')}</p>
                  <div className="mt-2 flex gap-3">
                    <button
                      type="button"
                      data-testid="stand-in-discard"
                      onClick={() => {
                        setDraft(saved)
                        setConfirmDiscard(false)
                        onCancel?.()
                      }}
                      className="min-h-8 rounded-md border border-border px-2"
                    >
                      {t('standIn.personal.discard')}
                    </button>
                    <button
                      type="button"
                      data-testid="stand-in-keep-editing"
                      onClick={() => setConfirmDiscard(false)}
                      className="min-h-8 px-2"
                    >
                      {t('standIn.personal.keep_editing')}
                    </button>
                  </div>
                </div>
              )}
            </div>
            <footer className="flex flex-wrap items-center gap-3 border-t border-border px-5 py-4">
              <span className="mr-auto text-xs text-text-muted">
                {view === 'scheduling' ? (
                  t('standIn.personal.shared_scheduling')
                ) : view === 'connections' ? (
                  t('standIn.personal.connections_only')
                ) : initialProject && view === 'create' ? (
                  <span data-testid="stand-in-project-auto-connect">
                    {t('standIn.personal.project_connect_help', { project: initialProject.name })}
                  </span>
                ) : (
                  ''
                )}
              </span>
              <button
                type="button"
                data-testid="stand-in-cancel"
                disabled={saving}
                onClick={close}
                className="min-h-9 rounded-md px-3 text-text-secondary hover:bg-muted"
              >
                {t('standIn.cancel')}
              </button>
              <button
                type="button"
                data-testid="stand-in-save"
                disabled={saving || (view === 'project' && !projectRoleId)}
                onClick={() => void save(view === 'project' && projectEnabled)}
                className="min-h-9 rounded-md bg-text-primary px-4 font-medium text-background disabled:opacity-40"
              >
                {t(
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
              </button>
            </footer>
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
