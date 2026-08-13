import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Bell,
  ChevronDown,
  Circle,
  CircleAlert,
  ClipboardList,
  FileSearch,
  Loader2,
  Menu,
  Plus,
  Search,
} from 'lucide-react'
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
import { isCloudDevice } from '@/lib/device-capabilities'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { cn } from '@/lib/utils'
import { track } from '@/telemetry/client'
import type { RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import type {
  Automation,
  AutomationMutation,
  AutomationRun,
  AutomationSchedule,
  AutomationSource,
} from '@/types/automation'

type StatusFilter = 'all' | 'active' | 'paused'

export function AutomationsPage() {
  const { t, i18n } = useTranslation('common')
  const { logout } = useAuth()
  const isMobile = useIsMobile()
  const isTauri = isTauriRuntime()
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
    getDeviceHomeDirectory,
    getProjectWorkspaceRoot,
    listDeviceDirectories,
    createDeviceDirectory,
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
    () => state.devices.filter(device => !isCloudDevice(device)),
    [state.devices]
  )
  const cloudDevices = useMemo(
    () => state.devices.filter(device => isCloudDevice(device)),
    [state.devices]
  )
  const loadAutomations = useCallback(async () => {
    if (!automationApi) {
      setError(t('workbench.automations_unavailable', '当前运行环境不支持自动化'))
      setLoading(false)
      return
    }
    try {
      const response = await automationApi.listAutomations()
      setAutomations(response.items)
      const shouldSelectInitialAutomation = !initialAutomationLoadCompletedRef.current
      initialAutomationLoadCompletedRef.current = true
      if (shouldSelectInitialAutomation && response.items[0]) {
        setSelectedAutomationId(response.items[0].id)
        setEditing(response.items[0])
        setDraft(automationDraftFromAutomation(response.items[0]))
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
  }, [automationApi, t])

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
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
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
  ) => {
    const device = localDevices[0]
    const deviceId = device?.device_id ?? state.standaloneDeviceId ?? 'local-device'
    const nextDraft = emptyAutomationDraft(
      'local',
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
  }

  const selectAutomation = (automation: Automation) => {
    setSelectedAutomationId(automation.id)
    setEditing(automation)
    setDraft(automationDraftFromAutomation(automation))
    setDirty(false)
  }

  const updateDraft = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => {
    setDraft(current => (current ? { ...current, [key]: value } : current))
    setDirty(true)
  }

  const changeSource = (source: AutomationSource) => {
    if (!draft || editing) return
    const devices = source === 'cloud' ? cloudDevices : localDevices
    const deviceId = devices[0]?.device_id ?? ''
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
      throw new Error(t('workbench.automation_target_task_required', '请选择一个已固定的本地任务'))
    }
    if (!draft.deviceId) {
      throw new Error(t('workbench.automation_target_required', '请选择设备'))
    }
    const team = state.defaultTeam
    if (!team) {
      throw new Error(t('workbench.automation_team_unavailable', '无法获取运行所需的默认智能体'))
    }
    const taskRequest: RuntimeTaskCreateRequest = {
      deviceId: draft.deviceId,
      ...automationWorkspaceTarget(draft.workspacePath),
      teamId: team.id,
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

  const closeDetail = () => {
    setSelectedAutomationId(null)
    setEditing(null)
    setDraft(null)
    setDirty(false)
  }
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
      return (
        <MobileSettingsPage
          onBack={() => setSettingsOpen(false)}
          onOpenPlugins={() => navigateTo('/plugins')}
        />
      )
    }
    return <ConnectionsSettingsPage onBack={() => setSettingsOpen(false)} />
  }

  const hasWorkspace = automations.length > 0 || Boolean(draft)

  return (
    <div className="relative flex h-full overflow-hidden bg-background text-text-primary">
      {!isMobile ? (
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
          onOpenPlugins={() => navigateTo('/plugins')}
          onOpenSites={() => navigateTo('/sites')}
          onOpenAutomation={() => navigateTo('/automations')}
          onRefreshDevices={refreshDevices}
          onUpdateProjectName={updateProjectName}
          onRemoveProject={removeProject}
          onGetDeviceHomeDirectory={getDeviceHomeDirectory}
          onListDeviceDirectories={listDeviceDirectories}
          onCreateDeviceDirectory={createDeviceDirectory}
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
        {!isMobile && isTauri && (
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
                automation={editing}
                runs={runs}
                locale={locale}
                devices={draft.source === 'cloud' ? cloudDevices : localDevices}
                projects={state.runtimeWork?.projects ?? []}
                models={projectChat.models}
                currentRuntimeTask={state.currentRuntimeTask}
                runtimeWork={state.runtimeWork}
                localDeviceIds={localDevices.map(device => device.device_id)}
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
            ) : (
              <div className="hidden min-w-0 flex-1 items-center justify-center text-sm text-text-tertiary md:flex">
                {t('workbench.automation_select_hint', '选择一个任务查看详情')}
              </div>
            )}
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

function AutomationListPane({
  automations,
  allAutomations,
  query,
  statusFilter,
  selectedAutomationId,
  locale,
  loading,
  error,
  mobileDetailOpen,
  onQueryChange,
  onFilterChange,
  onSelect,
  onCreate,
  onClearError,
}: {
  automations: Automation[]
  allAutomations: Automation[]
  query: string
  statusFilter: StatusFilter
  selectedAutomationId: string | null
  locale: string
  loading: boolean
  error: string | null
  mobileDetailOpen: boolean
  onQueryChange: (query: string) => void
  onFilterChange: (filter: StatusFilter) => void
  onSelect: (automation: Automation) => void
  onCreate: (
    template?: Pick<AutomationDraft, 'name' | 'prompt' | 'cronExpression' | 'cronTime'>
  ) => void
  onClearError: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <aside
      data-testid="automation-list-pane"
      className={cn(
        'w-full shrink-0 overflow-y-auto border-r border-border bg-background md:w-[430px] xl:w-[500px]',
        mobileDetailOpen && 'hidden md:block'
      )}
    >
      <div className="px-4 pb-10 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            {(['all', 'active', 'paused'] as const).map(filter => (
              <button
                key={filter}
                type="button"
                data-testid={`automation-filter-${filter}`}
                onClick={() => onFilterChange(filter)}
                className={cn(
                  'h-8 rounded-lg px-2.5 text-sm transition-colors',
                  statusFilter === filter
                    ? 'bg-surface font-medium'
                    : 'text-text-secondary hover:bg-surface'
                )}
              >
                {filter === 'all'
                  ? t('workbench.all', '全部')
                  : filter === 'active'
                    ? t('workbench.automation_filter_active', '已开启')
                    : t('workbench.automation_filter_paused', '已暂停')}
              </button>
            ))}
          </div>
          <button
            type="button"
            data-testid="create-automation-button"
            onClick={() => onCreate()}
            className="inline-flex h-8 items-center gap-1.5 rounded-xl bg-text-primary px-3 text-sm font-medium text-background transition-opacity hover:opacity-85"
          >
            {t('workbench.automation_create', '创建')}
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="relative mb-5 mt-5">
          <Search className="pointer-events-none absolute left-3 top-2 h-4 w-4 text-text-secondary" />
          <input
            data-testid="automation-search-input"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            placeholder={t('workbench.automations_search', '搜索已安排任务')}
            className="h-8 w-full rounded-full border border-border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
          />
        </div>
        {error ? <AutomationError error={error} onClear={onClearError} /> : null}
        {loading ? (
          <div className="flex h-40 items-center justify-center" data-testid="automations-loading">
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </div>
        ) : automations.length ? (
          <section className="flex flex-col gap-1" data-testid="automation-list">
            {automations.map(automation => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                locale={locale}
                selected={selectedAutomationId === automation.id}
                onOpen={() => onSelect(automation)}
              />
            ))}
          </section>
        ) : (
          <p className="py-12 text-center text-sm text-text-secondary">
            {t('workbench.automations_no_results', '没有匹配的自动化')}
          </p>
        )}
        {statusFilter === 'all' && !query && allAutomations.length > 0 ? (
          <>
            <div className="my-4 border-t border-border" />
            <AutomationSuggestions onSelect={onCreate} compact />
          </>
        ) : null}
      </div>
    </aside>
  )
}

function AutomationEmptyState({
  loading,
  error,
  query,
  onQueryChange,
  onCreate,
  onClearError,
}: {
  loading: boolean
  error: string | null
  query: string
  onQueryChange: (query: string) => void
  onCreate: (
    template?: Pick<AutomationDraft, 'name' | 'prompt' | 'cronExpression' | 'cronTime'>
  ) => void
  onClearError: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <div className="relative min-w-0 flex-1 overflow-y-auto">
      <button
        type="button"
        data-testid="create-automation-button"
        onClick={() => onCreate()}
        className="absolute right-4 top-[max(8px,env(safe-area-inset-top))] z-chrome inline-flex h-11 items-center gap-1.5 rounded-full bg-text-primary px-4 text-sm font-medium text-background hover:opacity-85 md:top-4 md:h-8 md:px-3.5"
      >
        {t('workbench.automation_create', '创建')}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <div className="mx-auto w-full max-w-[660px] px-5 pb-16 pt-[61px] md:px-0">
        <header className="mb-[23px]">
          <h1 className="text-heading-lg font-normal tracking-[-0.02em]">
            {t('workbench.automations_title', '已安排的任务')}
          </h1>
          <p className="mt-0.5 text-base text-text-secondary">
            {t('workbench.automations_description', '让 Wework 安排任务、设置提醒或监测更新')}
          </p>
        </header>
        <div className="relative mb-[26px]">
          <Search className="pointer-events-none absolute left-3 top-[7px] h-4 w-4 text-text-secondary" />
          <input
            data-testid="automation-search-input"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            placeholder={t('workbench.automations_search', '搜索已安排任务')}
            className="h-[30px] w-full rounded-full border border-border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
          />
        </div>
        {error ? <AutomationError error={error} onClear={onClearError} /> : null}
        {loading ? (
          <div className="flex h-40 items-center justify-center" data-testid="automations-loading">
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </div>
        ) : (
          <AutomationSuggestions onSelect={onCreate} />
        )}
      </div>
    </div>
  )
}

function AutomationError({ error, onClear }: { error: string; onClear: () => void }) {
  return (
    <button
      type="button"
      data-testid="automation-error"
      onClick={onClear}
      className="mb-4 flex w-full items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-left text-sm text-red-600 dark:text-red-400"
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
    </button>
  )
}

function AutomationSuggestions({
  onSelect,
  compact = false,
}: {
  onSelect: (
    template: Pick<AutomationDraft, 'name' | 'prompt' | 'cronExpression' | 'cronTime'>
  ) => void
  compact?: boolean
}) {
  const { t } = useTranslation('common')
  const suggestions = [
    {
      name: t('workbench.automation_daily_brief', '每日简报'),
      description: t(
        'workbench.automation_daily_brief_prompt',
        '给我一份晨间简报，包含我的日程安排、重要未读邮件，以及今天需要我关注的事项。'
      ),
      schedule: t('workbench.automation_daily_brief_schedule', '工作日 8:00'),
      cronExpression: '0 8 * * 1-5',
      cronTime: '08:00',
      icon: Bell,
      iconClassName: 'text-blue-500',
    },
    {
      name: t('workbench.automation_weekly_review', '每周回顾'),
      description: t(
        'workbench.automation_weekly_review_prompt',
        '每周五将你最近的工作整理成简明的状态更新'
      ),
      schedule: t('workbench.automation_weekly_review_schedule', '星期五（时间：16:00）'),
      cronExpression: '0 16 * * 5',
      cronTime: '16:00',
      icon: ClipboardList,
      iconClassName: 'text-violet-500',
    },
    {
      name: t('workbench.automation_follow_up', '跟进监控'),
      description: t(
        'workbench.automation_follow_up_prompt',
        '查看最近的电子邮箱和日历活动，并标记需要你关注的事项'
      ),
      schedule: t('workbench.automation_follow_up_schedule', '工作日 9:00'),
      cronExpression: '0 9 * * 1-5',
      cronTime: '09:00',
      icon: FileSearch,
      iconClassName: 'text-emerald-600',
    },
  ]
  return (
    <section data-testid="automation-suggestions">
      <h2 className="mb-2 px-1 text-sm font-medium text-text-secondary">
        {t('workbench.automation_suggestions', '建议')}
      </h2>
      <div className="flex flex-col gap-0.5">
        {suggestions.slice(compact ? 1 : 0).map((suggestion, index) => {
          const Icon = suggestion.icon
          return (
            <button
              key={suggestion.name}
              type="button"
              data-testid={`automation-suggestion-${compact ? index + 1 : index}`}
              onClick={() =>
                onSelect({
                  name: suggestion.name,
                  prompt: suggestion.description,
                  cronExpression: suggestion.cronExpression,
                  cronTime: suggestion.cronTime,
                })
              }
              className="group flex min-h-[65px] w-full items-center gap-3 rounded-lg px-1.5 py-2 text-left hover:bg-surface"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                <Icon className={cn('h-[18px] w-[18px]', suggestion.iconClassName)} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{suggestion.name}</span>
                  <span className="truncate text-xs text-text-tertiary">{suggestion.schedule}</span>
                </span>
                <span className="block truncate text-xs text-text-secondary">
                  {suggestion.description}
                </span>
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
                <Plus className="h-4 w-4" />
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function AutomationRow({
  automation,
  locale,
  selected,
  onOpen,
}: {
  automation: Automation
  locale: string
  selected: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <article data-testid={`automation-row-${automation.id}`}>
      <button
        type="button"
        data-testid={`automation-open-${automation.id}`}
        onClick={onOpen}
        className={cn(
          'flex min-h-[58px] w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-surface',
          selected && 'bg-surface'
        )}
      >
        <Circle
          className={cn(
            'mt-1 h-3.5 w-3.5 shrink-0',
            automation.enabled ? 'text-text-secondary' : 'text-text-tertiary'
          )}
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{automation.name}</span>
          <span className="block truncate text-xs text-text-tertiary">
            {formatScheduleSummary(automation.schedule, locale)}
            {' · '}
            {t('workbench.automation_next_run', '下次运行')}{' '}
            {formatRelativeDate(automation.nextRunAt)}
          </span>
        </span>
      </button>
    </article>
  )
}

function formatScheduleSummary(schedule: AutomationSchedule, locale: string): string {
  if (schedule.type === 'interval') {
    return locale.startsWith('zh')
      ? `每 ${schedule.value} ${schedule.unit === 'minutes' ? '分钟' : schedule.unit === 'hours' ? '小时' : '天'}`
      : `Every ${schedule.value} ${schedule.unit}`
  }
  if (schedule.type === 'one_time') {
    return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(schedule.executeAt)
    )
  }
  const parts = schedule.expression.trim().split(/\s+/)
  if (parts.length === 5 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
    const time = `${String(Number(parts[1])).padStart(2, '0')}:${String(Number(parts[0])).padStart(2, '0')}`
    if (parts[4] === '1-5') return locale.startsWith('zh') ? `工作日 ${time}` : `Weekdays ${time}`
    if (parts[4] === '*') return locale.startsWith('zh') ? `每天 ${time}` : `Daily ${time}`
  }
  return schedule.expression
}

function formatRelativeDate(value: string | null | undefined): string {
  if (!value) return '—'
  const hours = Math.max(0, Math.round((new Date(value).getTime() - Date.now()) / 3_600_000))
  return hours < 24 ? `${hours}h` : `${Math.round(hours / 24)}d`
}
