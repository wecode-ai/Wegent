import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useDialogRequests } from '@/components/common/useDialogRequests'
import { DesktopCollapsedSidebarToggle } from '@/components/layout/DesktopCollapsedSidebarToggle'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { MobileDrawer } from '@/components/layout/MobileDrawer'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { WorkbenchSearchDialog } from '@/components/layout/WorkbenchSearchDialog'
import { ConnectionsSettingsPage } from '@/components/settings/ConnectionsSettingsPage'
import { MobileSettingsPage } from '@/components/settings/MobileSettingsPage'
import { useAuth } from '@/features/auth/useAuth'
import { AutomationDetailWorkspace } from '@/features/automations/AutomationDetailWorkspace'
import {
  automationDraftFromAutomation,
  automationModelFields,
  automationWorkspaceTarget,
  buildAutomationProjectOptions,
  emptyAutomationDraft,
  initialGoalFromAutomationDraft,
  scheduleFromAutomationDraft,
  type AutomationDraft,
} from '@/features/automations/automationDraft'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { WORKBENCH_AUTOMATIONS_CHANGED_EVENT } from '@/features/workbench/workbenchCloudDataEvents'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { canUseForProjectCreation, isCloudDevice, isRemoteDevice } from '@/lib/device-capabilities'
import { buildRuntimeTaskRoute, navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { getWorkbenchDeviceIds } from '@/lib/workbench-device'
import { track } from '@/telemetry/client'
import type { RuntimeSendRequest, RuntimeTaskAddress, RuntimeTaskCreateRequest } from '@/types/api'
import type {
  Automation,
  AutomationMutation,
  AutomationRun,
  AutomationSource,
} from '@/types/automation'
import { getIdleResourceSnapshot, subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Menu } from 'lucide-react'
import {
  useCallback,
  useImperativeHandle,
  useMemo,
  useState,
  useSyncExternalStore,
  type Ref,
} from 'react'
import { createAutomationPageSource } from './automationPageSource'

import { AutomationEmptyState, AutomationListPane, type StatusFilter } from './AutomationListPane'
import { useAutomationRunNavigation } from './useAutomationRunNavigation'

const EMPTY_AUTOMATIONS: Automation[] = []
const EMPTY_AUTOMATION_RUNS: AutomationRun[] = []

export interface AutomationNavigationHandle {
  requestLeave(action: () => void): void
}

export function AutomationsPage({
  embedded = false,
  standInOwner,
  standInDeviceId,
  initialAutomationId,
  detailOnly = false,
  onClose,
  onDirtyChange,
  onNavigate,
  ref,
}: {
  embedded?: boolean
  ref?: Ref<AutomationNavigationHandle>
  onDirtyChange?(dirty: boolean): void
  onNavigate?(action: () => void): void
  standInDeviceId?: string
  initialAutomationId?: string
  detailOnly?: boolean
  onClose?(): void
  standInOwner?: { userId: number; roleId: string }
} = {}) {
  const { t, i18n } = useTranslation('common')
  const { confirm: requestConfirmation, dialogs: requestDialogs } = useDialogRequests(
    (key, fallback) => t(key, fallback)
  )

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
  const ownerUserId = standInOwner?.userId
  const ownerRoleId = standInOwner?.roleId
  const automationApi = services.automationApi
  const ownerKey = JSON.stringify([
    state.user?.id,
    ownerUserId,
    ownerRoleId,
    standInDeviceId,
    initialAutomationId,
  ])
  const [owner, setOwner] = useState(() => ({
    api: automationApi,
    key: ownerKey,
    source: createAutomationPageSource({
      api: automationApi,
      userId: ownerUserId,
      roleId: ownerRoleId,
      initialAutomationId,
    }),
  }))
  if (owner.api !== automationApi || owner.key !== ownerKey) {
    setOwner({
      api: automationApi,
      key: ownerKey,
      source: createAutomationPageSource({
        api: automationApi,
        userId: ownerUserId,
        roleId: ownerRoleId,
        initialAutomationId,
      }),
    })
  }
  const source = owner.source
  const subscribeDraft = useCallback(
    (notify: () => void) => source.subscribe(notify, onDirtyChange),
    [source, onDirtyChange]
  )
  const {
    selectedAutomationId,
    editing,
    draft,
    saving,
    dirty,
    pendingNavigation,
    runningId,
    error: operationError,
    draftError,
    dismissedReadErrors,
  } = useSyncExternalStore(subscribeDraft, source.getSnapshot, source.getSnapshot)
  const {
    setSelectedAutomationId,
    setEditing,
    setDraft,
    setSaving,
    setDirty,
    setPendingNavigation,
    setRunningId,
    setError,
    setDraftError,
    requestLeave,
    loadAutomations,
    loadRuns,
  } = source
  useImperativeHandle(ref, () => ({ requestLeave }), [requestLeave])
  const subscribeCatalog = useCallback(
    (notify: () => void) => source.subscribeCatalog(notify, state.runtimeWork),
    [source, state.runtimeWork]
  )
  const catalog = useSyncExternalStore(
    subscribeCatalog,
    source.catalog.getSnapshot,
    source.catalog.getSnapshot
  )
  const automations = catalog.data ?? EMPTY_AUTOMATIONS
  const loading =
    (catalog.status === 'idle' || catalog.status === 'loading') && catalog.data === undefined
  const runRead = source.runsFor(selectedAutomationId)
  const subscribeRuns = useCallback(
    (notify: () => void) =>
      runRead ? runRead.subscribe(notify, refreshWorkLists) : subscribeIdleResource(),
    [runRead, refreshWorkLists]
  )
  const runSnapshot = useSyncExternalStore(
    subscribeRuns,
    runRead?.getSnapshot ?? getIdleResourceSnapshot,
    getIdleResourceSnapshot
  )
  const runs = runSnapshot.data ?? EMPTY_AUTOMATION_RUNS
  const listError = !automationApi
    ? t('todo.automations_unavailable', '当前运行环境不支持自动化')
    : catalog.status === 'error' && !dismissedReadErrors.includes(catalog.error)
      ? catalog.error instanceof Error
        ? catalog.error.message
        : t('todo.automations_load_failed', '自动化加载失败')
      : null
  const runsError =
    runSnapshot.status === 'error' && !dismissedReadErrors.includes(runSnapshot.error)
      ? runSnapshot.error instanceof Error
        ? runSnapshot.error.message
        : t('todo.automation_runs_load_failed', '运行记录加载失败')
      : null
  const error = operationError ?? listError ?? runsError
  const [query, setQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const locale = i18n.language
  useDOMEvent('window', WORKBENCH_AUTOMATIONS_CHANGED_EVENT, () => {
    void loadAutomations()
  })

  const localDevices = useMemo(
    () => state.devices.filter(device => !isCloudDevice(device) && !isRemoteDevice(device)),
    [state.devices]
  )
  const cloudDevices = useMemo(
    () => state.devices.filter(device => isCloudDevice(device) || isRemoteDevice(device)),
    [state.devices]
  )
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

  const openCreate = (template?: Partial<AutomationDraft>) =>
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
      source.resolveInitialSelection()
      setSelectedAutomationId(null)
      setEditing(null)
      setDraft(nextDraft)
      setDirty(true)
    })

  const openReviewTemplate = async () => {
    if (!standInOwner || !standInDeviceId || !services.standInApi) return
    const existing = automations.find(
      item => item.taskRequest?.standInCalendar?.template === 'weekly_review'
    )
    if (existing) {
      selectAutomation(existing)
      return
    }
    const isCurrent = source.capture(true)
    try {
      const { reviewTemplate } = await services.standInApi.onboarding(
        standInOwner.userId,
        standInDeviceId,
        locale
      )
      if (!isCurrent()) return
      const template = automationDraftFromAutomation({ ...reviewTemplate, source: 'local' })
      openCreate({
        name: template.name,
        prompt: template.prompt,
        cronPreset: template.cronPreset,
        weeklyDay: template.weeklyDay,
        cronExpression: template.cronExpression,
        cronTime: template.cronTime,
        timezone: template.timezone,
        calendarTemplate: template.calendarTemplate,
      })
    } catch (cause) {
      if (!isCurrent()) return
      setError(getStandInErrorMessage(cause))
    }
  }

  const selectAutomation = (automation: Automation) =>
    requestLeave(() => {
      source.resolveInitialSelection()
      setSelectedAutomationId(automation.id)
      setEditing(automation)
      setDraft(automationDraftFromAutomation(automation, state.runtimeWork))
      setDirty(false)
    })

  const updateDraft = <K extends keyof AutomationDraft>(key: K, value: AutomationDraft[K]) => {
    if (key === 'name' || key === 'prompt') setDraftError(null)
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
    const owner = editing?.taskRequest?.standInOwner ?? standInOwner
    if (standInOwner) {
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
        conversationMode: 'independent',
        notificationPolicy: draft.notificationPolicy,
        taskRequest: {
          schemaVersion: 2,
          standInOwner: owner,
          standInCalendar: draft.calendarTemplate ? { template: draft.calendarTemplate } : {},
          deviceId: draft.deviceId,
          runtime: 'codex',
          message: draft.prompt.trim(),
          title: draft.name.trim(),
        },
        continuationPayload: null,
      }
    }
    const initialGoal = initialGoalFromAutomationDraft(draft)
    if (draft.conversationMode === 'continue_thread' && !draft.continuationAddress) {
      throw new Error(t('todo.automation_target_task_required', '请选择一个可用的已固定任务'))
    }
    if (!draft.deviceId) {
      throw new Error(t('todo.automation_target_required', '请选择设备'))
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
    if (!automationApi || !draft) return
    if (!draft.name.trim() || !draft.prompt.trim()) {
      setDraftError(t('todo.automation_name_prompt_required', '请填写名称和任务说明'))
      return
    }
    const isCurrent = source.capture()
    if (!isCurrent()) return
    setDraftError(null)
    setSaving(true)
    try {
      const mutation = buildMutation()
      const response = editing
        ? await automationApi.updateAutomation(editing.id, mutation)
        : await automationApi.createAutomation(mutation)
      if (!isCurrent()) return
      setSelectedAutomationId(response.automation.id)
      setEditing(response.automation)
      setDraft(automationDraftFromAutomation(response.automation))
      setDirty(false)
      await loadAutomations()
      if (!isCurrent()) return
      if (detailOnly) {
        onClose?.()
      } else if (standInOwner) {
        setSelectedAutomationId(null)
        setEditing(null)
        setDraft(null)
      }
      track('automation_action_completed', { action: editing ? 'update' : 'create' })
    } catch (saveError) {
      if (!isCurrent()) return
      track('operation_failed', { operation: 'automation_save' })
      setDraftError(
        saveError instanceof Error
          ? saveError.message
          : t('todo.automation_save_failed', '保存自动化失败')
      )
    } finally {
      setSaving(false)
    }
  }

  const toggleAutomation = async (automation: Automation) => {
    if (!automationApi) return
    const isCurrent = source.capture(true)
    if (!isCurrent()) return
    try {
      const response = await automationApi.toggleAutomation(automation.id, !automation.enabled)
      if (!isCurrent()) return
      setEditing(response.automation)
      await loadAutomations()
      track('automation_action_completed', {
        action: response.automation.enabled ? 'enable' : 'disable',
      })
    } catch (toggleError) {
      if (!isCurrent()) return
      track('operation_failed', { operation: 'automation_toggle' })
      setError(toggleError instanceof Error ? toggleError.message : String(toggleError))
    }
  }

  const runNow = async (automation: Automation) => {
    if (!automationApi) return
    const isCurrent = source.capture(true)
    if (!isCurrent()) return
    setRunningId(automation.id)
    try {
      await automationApi.runAutomationNow(automation.id)
      if (!isCurrent()) return
      await Promise.all([loadAutomations(), loadRuns(automation.id, refreshWorkLists)])
      if (!isCurrent()) return
      setSelectedAutomationId(automation.id)
      track('automation_action_completed', { action: 'run' })
    } catch (runError) {
      if (!isCurrent()) return
      track('operation_failed', { operation: 'automation_run' })
      setError(runError instanceof Error ? runError.message : String(runError))
    } finally {
      setRunningId(null)
    }
  }

  const deleteAutomation = async (automation: Automation) => {
    if (!automationApi) return
    if (!(await requestConfirmation(t('todo.automation_delete_confirm', '删除这个自动化？'))))
      return
    const isCurrent = source.capture(true)
    if (!isCurrent()) return
    try {
      await automationApi.deleteAutomation(automation.id)
      if (!isCurrent()) return
      setSelectedAutomationId(null)
      setEditing(null)
      setDraft(null)
      setDirty(false)
      const finishCurrent = source.capture(true)
      await loadAutomations()
      if (!finishCurrent()) return
      if (detailOnly) onClose?.()
      track('automation_action_completed', { action: 'delete' })
    } catch (deleteError) {
      if (!isCurrent()) return
      track('operation_failed', { operation: 'automation_delete' })
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError))
    }
  }

  const closeDetail = () =>
    requestLeave(() => {
      if (detailOnly) {
        onClose?.()
        return
      }
      source.resolveInitialSelection()
      setSelectedAutomationId(null)
      setEditing(null)
      setDraft(null)
      setDirty(false)
    })
  const handleOpenRuntimeTask = async (address: RuntimeTaskAddress) => {
    const isCurrent = source.capture()
    if (!isCurrent()) return
    await openRuntimeTask(address)
    if (isCurrent()) navigateTo(buildRuntimeTaskRoute(address))
  }
  const openRun = useAutomationRunNavigation({
    openRuntimeTask,
    requestLeave,
    onNavigate,
    onError: setError,
  })
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
        <>
          {' '}
          {requestDialogs} <MobileSettingsPage onBack={() => setSettingsOpen(false)} />{' '}
        </>
      )
    }
    return (
      <>
        {' '}
        {requestDialogs} <ConnectionsSettingsPage onBack={() => setSettingsOpen(false)} />{' '}
      </>
    )
  }

  const hasWorkspace = automations.length > 0 || Boolean(draft) || catalog.status === 'error'

  return (
    <>
      {' '}
      {requestDialogs}{' '}
      <div
        className={`relative flex min-h-0 overflow-hidden bg-background text-text-primary ${standInOwner && !draft ? 'shrink-0' : 'h-full flex-1'}`}
      >
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
            setDraftError(null)
            setDirty(false)
            setDraft(editing ? automationDraftFromAutomation(editing, state.runtimeWork) : null)
            if (!editing) setSelectedAutomationId(null)
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
            onOpenStandIn={() => requestLeave(() => navigateTo('/stand-in'))}
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
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="automations-mobile-menu"
              onClick={() => setDrawerOpen(true)}
              className="absolute left-4 top-[max(8px,env(safe-area-inset-top))] z-chrome flex h-11 min-w-11 items-center justify-center rounded-lg bg-surface"
              aria-label={t('workbench.open_menu', '打开菜单')}
            >
              <Menu className="h-5 w-5" />
            </ControlButton>
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
          {detailOnly && !draft ? (
            <div
              data-testid="automation-detail-status"
              className="p-4 text-sm text-text-secondary"
              role={loading ? 'status' : 'alert'}
            >
              {loading ? t('standIn.loading') : error || t('todo.automation_not_found')}
              {!loading && (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="automation-detail-retry"
                  onClick={() => void loadAutomations()}
                  className="ml-2 min-h-8 underline"
                >
                  {t('standIn.reload')}
                </ControlButton>
              )}
            </div>
          ) : hasWorkspace ? (
            <>
              {!detailOnly && (!standInOwner || !draft) && (
                <AutomationListPane
                  calendar={Boolean(standInOwner)}
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
                  onReviewTemplate={
                    standInOwner?.roleId === '@primary' &&
                    services.standInApi &&
                    !loading &&
                    !error &&
                    !automations.some(
                      item => item.taskRequest?.standInCalendar?.template === 'weekly_review'
                    )
                      ? () => void openReviewTemplate()
                      : undefined
                  }
                  onClearError={() => setError(null)}
                />
              )}
              {draft ? (
                <AutomationDetailWorkspace
                  dialogMode={detailOnly}
                  compact={Boolean(standInOwner)}
                  validationError={draftError || (detailOnly ? error : null)}
                  draft={draft}
                  calendarMode={Boolean(standInOwner)}
                  inheritStandIn={Boolean(standInOwner || editing?.taskRequest?.standInOwner)}
                  automation={editing}
                  runs={runs}
                  onOpenRun={openRun}
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
              calendar={Boolean(standInOwner)}
              loading={loading}
              error={error}
              query={query}
              onQueryChange={setQuery}
              onCreate={openCreate}
              onReviewTemplate={
                standInOwner?.roleId === '@primary' && services.standInApi && !loading && !error
                  ? () => void openReviewTemplate()
                  : undefined
              }
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
      </div>{' '}
    </>
  )
}
