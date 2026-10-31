import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type Ref,
} from 'react'
import { Menu } from 'lucide-react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { DesktopCollapsedSidebarToggle } from '@/components/layout/DesktopCollapsedSidebarToggle'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { WorkbenchSearchDialog } from '@/components/layout/WorkbenchSearchDialog'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { AutomationDetailWorkspace } from '@/features/automations/AutomationDetailWorkspace'
import {
  automationModelFields,
  automationDraftFromAutomation,
  automationWorkspaceTarget,
  buildAutomationProjectOptions,
  emptyAutomationDraft,
  initialGoalFromAutomationDraft,
  scheduleFromAutomationDraft,
  type AutomationDraft,
} from '@/features/automations/automationDraft'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { canUseForProjectCreation, isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { getWorkbenchDeviceIds } from '@/lib/workbench-device'
import { track } from '@/telemetry/client'
import type { RuntimeSendRequest, RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import type {
  Automation,
  AutomationMutation,
  AutomationRun,
  AutomationSource,
} from '@/types/automation'
import { WORKBENCH_AUTOMATIONS_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'

import { AutomationListPane, AutomationEmptyState, type StatusFilter } from './AutomationListPane'

export interface AutomationNavigationHandle {
  requestLeave(action: () => void): void
}

export function AutomationsPage({
  embedded = false,
  standInOwner,
  standInDeviceId,
  onDirtyChange,
  ref,
}: {
  embedded?: boolean
  ref?: Ref<AutomationNavigationHandle>
  onDirtyChange?(dirty: boolean): void
  standInDeviceId?: string
  standInOwner?: { userId: number; roleId: string }
} = {}) {
  const { t, i18n } = useTranslation('common')
  const { logout } = useAuth()
  const isMobile = useIsMobile()
  const isDesktop = isElectronRuntime()
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const {
    state,
    services,
    projectChat,
    cloudWorkStatus,
    selectProject,
    startNewChat,
    startStandaloneChat,
    startNewProjectChat,
    openRuntimeTask,
    renameRuntimeTask,
    archiveRuntimeTask,
    archiveProjectConversations,
    archiveProjectsConversations,
    archiveChatConversations,
    selectStandaloneDevice,
    openStandaloneWorkspace,
    getRemoteDeviceStartupCommand,
    refreshDevices,
    createProject,
    createGitWorkspaceProject,
    prepareDeviceWorkspace,
    deleteDeviceWorkspace,
    searchRuntimeWork,
    listGitRepositories,
    listGitBranches,
    updateProjectName,
    removeProject,
    setRuntimeTaskPinned,
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
    cloneGitRepository,
    refreshWorkLists,
  } = useWorkbench()
  const [automations, setAutomations] = useState<Automation[]>([])
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [selectedAutomationId, setSelectedAutomationId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Automation | null>(null)
  const [draft, setDraft] = useState<AutomationDraft | null>(null)
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [pendingNavigation, setPendingNavigation] = useState<(() => void) | null>(null)
  const requestLeave = (action: () => void) => {
    if (saving) return
    if (dirty) setPendingNavigation(() => action)
    else action()
  }
  useImperativeHandle(ref, () => ({ requestLeave }))
  useEffect(() => {
    onDirtyChange?.(dirty)
  }, [dirty, onDirtyChange])
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange])
  const [runningId, setRunningId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const initialAutomationLoadCompletedRef = useRef(false)
  const runListSignatureRef = useRef('')
  const refreshWorkListsRef = useRef(refreshWorkLists)
  const locale = i18n.language
  const automationApi = services.automationApi

  useEffect(() => {
    refreshWorkListsRef.current = refreshWorkLists
  }, [refreshWorkLists])

  const localDevices = useMemo(
    () => state.devices.filter(device => !isCloudDevice(device) && !isRemoteDevice(device)),
    [state.devices]
  )
  const cloudDevices = useMemo(
    () => state.devices.filter(device => isCloudDevice(device) || isRemoteDevice(device)),
    [state.devices]
  )
  const ownerUserId = standInOwner?.userId
  const ownerRoleId = standInOwner?.roleId
  const loadAutomations = useCallback(async () => {
    if (!automationApi) {
      setError(t('workbench.automations_unavailable', '当前运行环境不支持自动化'))
      setLoading(false)
      return
    }
    try {
      const response = await automationApi.listAutomations()
      const items = response.items.filter(item => {
        if (ownerUserId === undefined) return true
        const owner = item.taskRequest?.standInOwner
        if (owner)
          return (
            owner.userId === ownerUserId &&
            (ownerRoleId === '@primary' || owner.roleId === ownerRoleId)
          )
        return ownerRoleId === '@primary'
      })
      setAutomations(items)
      const shouldSelectInitialAutomation = !initialAutomationLoadCompletedRef.current
      initialAutomationLoadCompletedRef.current = true
      if (shouldSelectInitialAutomation && items[0]) {
        setSelectedAutomationId(items[0].id)
        setEditing(items[0])
        setDraft(automationDraftFromAutomation(items[0], state.runtimeWork))
        setDirty(false)
      }
      setError(null)
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : t('workbench.automations_load_failed', '自动化加载失败')
      )
    } finally {
      setLoading(false)
    }
  }, [automationApi, state.runtimeWork, t, ownerUserId, ownerRoleId])

  const loadRuns = useCallback(
    async (automationId: string) => {
      if (!automationApi) return
      try {
        const response = await automationApi.listAutomationRuns(automationId)
        const signature = response.items
          .map(run => `${run.id}:${run.status}:${run.updatedAt}`)
          .join('|')
        if (signature !== runListSignatureRef.current) {
          runListSignatureRef.current = signature
          setRuns(response.items)
          await refreshWorkListsRef.current()
        }
      } catch (loadError) {
        setError(
          loadError instanceof Error
            ? loadError.message
            : t('workbench.automation_runs_load_failed', '运行记录加载失败')
        )
      }
    },
    [automationApi, t]
  )

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void loadAutomations(), 0)
    const timer = window.setInterval(() => void loadAutomations(), 30_000)
    const handleAutomationsChanged = () => void loadAutomations()
    window.addEventListener(WORKBENCH_AUTOMATIONS_CHANGED_EVENT, handleAutomationsChanged)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
      window.removeEventListener(WORKBENCH_AUTOMATIONS_CHANGED_EVENT, handleAutomationsChanged)
    }
  }, [loadAutomations])

  useEffect(() => {
    if (!selectedAutomationId) return
    runListSignatureRef.current = ''
    const load = window.setTimeout(() => void loadRuns(selectedAutomationId), 0)
    const timer = window.setInterval(() => void loadRuns(selectedAutomationId), 2_000)
    return () => {
      window.clearTimeout(load)
      window.clearInterval(timer)
    }
  }, [loadRuns, selectedAutomationId])

  const filteredAutomations = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    return automations.filter(automation => {
      const matchesFilter =
        statusFilter === 'all' ||
        (statusFilter === 'active' ? automation.enabled : !automation.enabled)
      const matchesQuery =
        !normalized ||
        `${automation.name} ${automation.description} ${automation.prompt}`
          .toLowerCase()
          .includes(normalized)
      return matchesFilter && matchesQuery
    })
  }, [automations, query, statusFilter])

  const defaultWorkspacePathForDevice = useCallback(
    (deviceId: string) => {
      if (
        state.currentRuntimeTask?.deviceId === deviceId &&
        state.currentRuntimeTask.workspacePath
      ) {
        return state.currentRuntimeTask.workspacePath
      }
      if (state.standaloneDeviceId === deviceId && state.standaloneWorkspacePath) {
        return state.standaloneWorkspacePath
      }
      const currentProjectWork = state.currentProject
        ? state.runtimeWork?.projects.find(
            project => runtimeProjectUiId(project.project) === state.currentProject?.id
          )
        : null
      return currentProjectWork
        ? (buildAutomationProjectOptions([currentProjectWork], deviceId)[0]?.workspacePath ?? '')
        : ''
    },
    [
      state.currentProject,
      state.currentRuntimeTask,
      state.runtimeWork?.projects,
      state.standaloneDeviceId,
      state.standaloneWorkspacePath,
    ]
  )

  const openCreate = (
    template?: Pick<AutomationDraft, 'name' | 'prompt' | 'cronExpression' | 'cronTime'>
  ) =>
    requestLeave(() => {
      const device = standInDeviceId
        ? state.devices.find(item => item.device_id === standInDeviceId)
        : localDevices.find(canUseForProjectCreation)
      const deviceId = device?.device_id ?? ''
      const nextDraft = emptyAutomationDraft(
        device && (isCloudDevice(device) || isRemoteDevice(device)) ? 'cloud' : 'local',
        deviceId,
        defaultWorkspacePathForDevice(deviceId),
        projectChat.selectedModel,
        projectChat.selectedModelOptions
      )
      if (template) Object.assign(nextDraft, template)
      setSelectedAutomationId(null)
      setEditing(null)
      setDraft(nextDraft)
      setDirty(true)
    })

  const selectAutomation = (automation: Automation) =>
    requestLeave(() => {
      setSelectedAutomationId(automation.id)
      setEditing(automation)
      setDraft(automationDraftFromAutomation(automation, state.runtimeWork))
      setDirty(false)
    })

  const updateDraft = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => {
    setDraft(current => (current ? { ...current, [key]: value } : current))
    setDirty(true)
  }

  const changeSource = (source: AutomationSource) => {
    if (!draft || editing) return
    const devices = source === 'cloud' ? cloudDevices : localDevices
    const deviceId = devices.find(canUseForProjectCreation)?.device_id ?? ''
    setDraft(current =>
      current
        ? {
            ...current,
            source,
            deviceId,
            workspacePath: defaultWorkspacePathForDevice(deviceId),
            conversationMode: 'independent',
          }
        : current
    )
    setDirty(true)
  }

  const changeModel = (model: (typeof projectChat.models)[number] | null) => {
    if (!draft) return
    const reasoningEffort = draft.modelOptions.reasoningEffort ?? 'medium'
    const modelFields = automationModelFields(model, model ? { reasoningEffort } : {})
    setDraft(current => (current ? { ...current, ...modelFields } : current))
    setDirty(true)
  }

  const buildMutation = (): AutomationMutation => {
    if (!draft) throw new Error('Automation draft is missing')
    if (!draft.name.trim() || !draft.prompt.trim()) {
      throw new Error(t('workbench.automation_name_prompt_required', '请填写名称和任务说明'))
    }
    const initialGoal = initialGoalFromAutomationDraft(draft)
    if (draft.conversationMode === 'continue_thread' && !draft.continuationAddress) {
      throw new Error(t('workbench.automation_target_task_required', '请选择一个可用的已固定任务'))
    }
    if (!draft.deviceId) {
      throw new Error(t('workbench.automation_target_required', '请选择设备'))
    }
    const projectTarget =
      draft.conversationMode === 'independent'
        ? buildAutomationProjectOptions(state.runtimeWork?.projects ?? [], draft.deviceId).find(
            option => option.workspacePath === draft.workspacePath
          )?.target
        : null
    const taskRequest: RuntimeTaskCreateRequest = {
      schemaVersion: 2,
      ...(standInOwner
        ? { standInOwner }
        : editing?.taskRequest?.standInOwner
          ? { standInOwner: editing.taskRequest.standInOwner }
          : {}),
      deviceId: draft.deviceId,
      ...automationWorkspaceTarget(projectTarget),
      runtime: 'codex',
      message: draft.prompt.trim(),
      title: draft.name.trim(),
      ...(initialGoal ? { initialGoal } : {}),
      ...(draft.modelId
        ? {
            modelId: draft.modelId,
            modelType: draft.modelType as RuntimeTaskCreateRequest['modelType'],
            modelOptions: draft.modelOptions,
          }
        : {}),
    }
    const continuationPayload =
      draft.conversationMode === 'continue_thread' && draft.continuationAddress
        ? {
            address: draft.continuationAddress,
            message: draft.prompt.trim(),
            ...(initialGoal ? { initialGoal } : {}),
            ...(draft.modelId
              ? {
                  modelId: draft.modelId,
                  modelType: draft.modelType as RuntimeSendRequest['modelType'],
                  modelOptions: draft.modelOptions,
                }
              : {}),
          }
        : null
    return {
      id: editing?.id,
      version: editing?.version,
      source: draft.source,
      name: draft.name.trim(),
      description: '',
      prompt: draft.prompt.trim(),
      schedule: scheduleFromAutomationDraft(draft),
      timezone: draft.timezone,
      enabled: editing?.enabled ?? true,
      conversationMode: draft.conversationMode,
      notificationPolicy: draft.notificationPolicy,
      taskRequest,
      continuationPayload,
    }
  }

  const saveAutomation = async () => {
    if (!automationApi) return
    setSaving(true)
    try {
      const mutation = buildMutation()
      const response = editing
        ? await automationApi.updateAutomation(editing.id, mutation)
        : await automationApi.createAutomation(mutation)
      setSelectedAutomationId(response.automation.id)
      setEditing(response.automation)
      setDraft(automationDraftFromAutomation(response.automation))
      setDirty(false)
      await loadAutomations()
      track('automation_action_completed', { action: editing ? 'update' : 'create' })
    } catch (saveError) {
      track('operation_failed', { operation: 'automation_save' })
      setError(
        saveError instanceof Error
          ? saveError.message
          : t('workbench.automation_save_failed', '保存自动化失败')
      )
    } finally {
      setSaving(false)
    }
  }

  const toggleAutomation = async (automation: Automation) => {
    if (!automationApi) return
    try {
      const response = await automationApi.toggleAutomation(automation.id, !automation.enabled)
      setEditing(response.automation)
      await loadAutomations()
      track('automation_action_completed', {
        action: response.automation.enabled ? 'enable' : 'disable',
      })
    } catch (toggleError) {
      track('operation_failed', { operation: 'automation_toggle' })
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    }
  }

  const runNow = async (automation: Automation) => {
    if (!automationApi) return
    setRunningId(automation.id)
    try {
      await automationApi.runAutomationNow(automation.id)
      await Promise.all([loadAutomations(), loadRuns(automation.id), refreshWorkLists()])
      setSelectedAutomationId(automation.id)
      track('automation_action_completed', { action: 'run' })
    } catch (runError) {
      track('operation_failed', { operation: 'automation_run' })
      setError(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setRunningId(null)
    }
  }

  const deleteAutomation = async (automation: Automation) => {
    if (!automationApi) return
    if (!window.confirm(t('workbench.automation_delete_confirm', '删除这个自动化？'))) return
    try {
      await automationApi.deleteAutomation(automation.id)
      setSelectedAutomationId(null)
      setEditing(null)
      setDraft(null)
      setDirty(false)
      await loadAutomations()
      track('automation_action_completed', { action: 'delete' })
    } catch (deleteError) {
      track('operation_failed', { operation: 'automation_delete' })
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    }
  }

  const closeDetail = () =>
    requestLeave(() => {
      setSelectedAutomationId(null)
      setEditing(null)
      setDraft(null)
      setDirty(false)
    })
  const handleOpenRuntimeTask = async (address: RuntimeTaskAddress) => {
    await openRuntimeTask(address)
    navigateTo(buildRuntimeTaskRoute(address))
  }
  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }
  const handleNewChat = () => {
    navigateTo('/')
    startNewChat()
  }
  const handleStandaloneChat = () => {
    navigateTo('/')
    startStandaloneChat()
  }

  if (settingsOpen) {
    if (isMobile) {
      return <MobileSettingsPage onBack={() => setSettingsOpen(false)} />
    }
    return <ConnectionsSettingsPage onBack={() => setSettingsOpen(false)} />
  }

  const hasWorkspace = automations.length > 0 || Boolean(draft)

  return (
    <div className="relative flex h-full overflow-hidden bg-background text-text-primary">
      <ConfirmDialog
        open={pendingNavigation !== null}
        onClose={() => setPendingNavigation(null)}
        title={t('standIn.personal.discard_help')}
        description={t('standIn.personal.discard_description')}
        confirmLabel={t('standIn.personal.discard')}
        cancelLabel={t('standIn.personal.keep_editing')}
        confirmTestId="automation-discard"
        cancelTestId="automation-keep-editing"
        onConfirm={() => {
          const action = pendingNavigation
          setPendingNavigation(null)
          action?.()
        }}
      />
      {embedded ? null : !isMobile ? (
        <DesktopSidebar
          user={state.user}
          projects={state.projects}
          devices={state.devices}
          runtimeWork={state.runtimeWork}
          currentRuntimeTask={state.currentRuntimeTask}
          cloudWorkStatus={cloudWorkStatus}
          standaloneDeviceId={state.standaloneDeviceId}
          standaloneWorkspacePath={state.standaloneWorkspacePath}
          preferredDeviceId={
            state.standaloneDeviceId ?? state.user?.preferences?.default_execution_target
          }
          activeItem="automation"
          collapsed={sidebarCollapsed}
          onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
          onNewChat={handleNewChat}
          onStartStandaloneChat={handleStandaloneChat}
          onOpenSearch={() => setSearchOpen(true)}
          onSelectProject={handleSelectProject}
          onStartNewProjectChat={projectId => {
            navigateTo('/')
            startNewProjectChat(projectId)
          }}
          onOpenRuntimeTask={handleOpenRuntimeTask}
          onRenameRuntimeTask={renameRuntimeTask}
          onArchiveRuntimeTask={archiveRuntimeTask}
          onArchiveProjectConversations={archiveProjectConversations}
          onArchiveProjectsConversations={archiveProjectsConversations}
          onArchiveChatConversations={archiveChatConversations}
          onOpenStandaloneWorkspace={openStandaloneWorkspace}
          onSelectStandaloneDevice={selectStandaloneDevice}
          onGetRemoteDeviceStartupCommand={getRemoteDeviceStartupCommand}
          onRefreshDevices={refreshDevices}
          onUpdateProjectName={updateProjectName}
          onRemoveProject={removeProject}
          onSetRuntimeTaskPinned={setRuntimeTaskPinned}
          onGetDeviceHomeDirectory={getDeviceHomeDirectory}
          onListDeviceDirectories={listDeviceDirectories}
          onCreateDeviceDirectory={createDeviceDirectory}
          onCloneGitRepository={cloneGitRepository}
          onOpenSettings={() => setSettingsOpen(true)}
          onLogout={logout}
        />
      ) : (
        <>
          <button
            type="button"
            data-testid="automations-mobile-menu"
            onClick={() => setDrawerOpen(true)}
            className="absolute left-4 top-[max(8px,env(safe-area-inset-top))] z-chrome flex h-11 min-w-11 items-center justify-center rounded-lg bg-surface"
            aria-label={t('workbench.open_menu', '打开菜单')}
          >
            <Menu className="h-5 w-5" />
          </button>
          <MobileDrawer
            open={drawerOpen}
            user={state.user}
            devices={state.devices}
            projects={state.projects}
            runtimeWork={state.runtimeWork}
            currentProjectId={state.currentProject?.id}
            currentRuntimeTask={state.currentRuntimeTask}
            activeItem="automation"
            onClose={() => setDrawerOpen(false)}
            onNewChat={handleNewChat}
            onStartStandaloneChat={handleStandaloneChat}
            onOpenSettings={() => setSettingsOpen(true)}
            onSelectProject={handleSelectProject}
            onOpenRuntimeTask={handleOpenRuntimeTask}
            onCreateProject={createProject}
            onCreateGitWorkspaceProject={createGitWorkspaceProject}
            onPrepareDeviceWorkspace={prepareDeviceWorkspace}
            onDeleteDeviceWorkspace={deleteDeviceWorkspace}
            onListGitRepositories={listGitRepositories}
            onListGitBranches={listGitBranches}
            onUpdateProjectName={updateProjectName}
            onRemoveProject={removeProject}
            onGetDeviceHomeDirectory={getDeviceHomeDirectory}
            onGetProjectWorkspaceRoot={getProjectWorkspaceRoot}
            onListDeviceDirectories={listDeviceDirectories}
            onCreateDeviceDirectory={createDeviceDirectory}
          />
        </>
      )}

      <main className="relative flex min-w-0 flex-1 overflow-hidden">
        {!embedded && !isMobile && isDesktop && (
          <DesktopCollapsedSidebarToggle
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(false)}
          />
        )}
        {hasWorkspace ? (
          <>
            <AutomationListPane
              automations={filteredAutomations}
              allAutomations={automations}
              query={query}
              statusFilter={statusFilter}
              selectedAutomationId={selectedAutomationId}
              locale={locale}
              loading={loading}
              error={error}
              detailOpen={Boolean(draft)}
              mobileDetailOpen={isMobile && Boolean(draft)}
              onQueryChange={setQuery}
              onFilterChange={setStatusFilter}
              onSelect={selectAutomation}
              onCreate={openCreate}
              onClearError={() => setError(null)}
            />
            {draft ? (
              <AutomationDetailWorkspace
                draft={draft}
                inheritStandIn={Boolean(standInOwner || editing?.taskRequest?.standInOwner)}
                automation={editing}
                runs={runs}
                locale={locale}
                devices={state.devices}
                projects={state.runtimeWork?.projects ?? []}
                models={projectChat.models}
                currentRuntimeTask={state.currentRuntimeTask}
                runtimeWork={state.runtimeWork}
                localDeviceIds={localDevices.flatMap(getWorkbenchDeviceIds)}
                cloudAvailable={cloudDevices.length > 0}
                saving={saving}
                dirty={dirty}
                running={Boolean(editing && runningId === editing.id)}
                onChange={updateDraft}
                onModelChange={changeModel}
                onSourceChange={changeSource}
                onClose={closeDetail}
                onSave={() => void saveAutomation()}
                onRun={() => editing && void runNow(editing)}
                onToggle={() => editing && void toggleAutomation(editing)}
                onDelete={() => editing && void deleteAutomation(editing)}
              />
            ) : null}
          </>
        ) : (
          <AutomationEmptyState
            loading={loading}
            error={error}
            query={query}
            onQueryChange={setQuery}
            onCreate={openCreate}
            onClearError={() => setError(null)}
          />
        )}
      </main>

      <WorkbenchSearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onSearchRuntimeWork={searchRuntimeWork}
        onOpenRuntimeTask={handleOpenRuntimeTask}
      />
    </div>
  )
}
