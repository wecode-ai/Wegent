import {
  AlertTriangle,
  Check,
  ListRestart,
  Loader2,
  MousePointer2,
  Play,
  Settings,
  Square,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { DesktopCollapsedSidebarToggle } from '@/components/layout/DesktopCollapsedSidebarToggle'
import { DesktopSidebar } from '@/components/layout/DesktopSidebar'
import { Button } from '@/components/ui/button'
import { useDesktopSidebarCollapsed } from '@/components/layout/useDesktopSidebarCollapsed'
import { useAuth } from '@/features/auth/useAuth'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import {
  cancelSystemReplay,
  deleteSystemRecording,
  listSystemRecordings,
  openSystemRecordReplayPermissionSettings,
  readSystemRecordReplayStatus,
  replaySystemRecording,
  requestSystemRecordReplayPermissions,
  startSystemRecording,
  stopSystemRecording,
  type SystemRecordingSummary,
  type SystemRecordReplayStatus,
} from '@/lib/system-record-replay'
import { navigateTo } from '@/lib/navigation'
import { isElectronRuntime } from '@/lib/runtime-environment'

const EMPTY_STATUS: SystemRecordReplayStatus = {
  supported: false,
  accessibilityGranted: false,
  inputMonitoringGranted: false,
  phase: 'idle',
  recordingId: null,
  title: null,
  stepCount: 0,
  currentStep: null,
  currentApplication: null,
  message: null,
}

export function RecordReplayPage() {
  const { t, i18n } = useTranslation('common')
  const { logout } = useAuth()
  const isMobile = useIsMobile()
  const isDesktop = isElectronRuntime()
  const { sidebarCollapsed, setSidebarCollapsed } = useDesktopSidebarCollapsed()
  const {
    state,
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
    updateProjectName,
    removeProject,
    getDeviceHomeDirectory,
    listDeviceDirectories,
    createDeviceDirectory,
  } = useWorkbench()
  const [title, setTitle] = useState('')
  const [recordings, setRecordings] = useState<SystemRecordingSummary[]>([])
  const [status, setStatus] = useState<SystemRecordReplayStatus>(EMPTY_STATUS)
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [nextRecordings, nextStatus] = await Promise.all([
        listSystemRecordings(),
        readSystemRecordReplayStatus(),
      ])
      setRecordings(nextRecordings)
      setStatus(nextStatus)
      setError(null)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => void load(), 500)
    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(timer)
    }
  }, [load])

  const active = status.phase !== 'idle' && status.phase !== 'failed'
  const recording = status.phase === 'recording'
  const replaying = status.phase === 'replaying' || status.phase === 'paused'
  const locale = i18n.language
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }),
    [locale]
  )

  const start = async () => {
    try {
      setError(null)
      setStatus(await startSystemRecording(title))
      setTitle('')
    } catch (startError) {
      setError(errorMessage(startError))
    }
  }

  const stop = async () => {
    try {
      setError(null)
      await stopSystemRecording()
      await load()
    } catch (stopError) {
      setError(errorMessage(stopError))
    }
  }

  const replay = async (id: string) => {
    try {
      setBusyId(id)
      setError(null)
      setStatus(await replaySystemRecording(id))
    } catch (replayError) {
      setError(errorMessage(replayError))
    } finally {
      setBusyId(null)
    }
  }

  const remove = async (id: string) => {
    try {
      setBusyId(id)
      setError(null)
      await deleteSystemRecording(id)
      await load()
    } catch (removeError) {
      setError(errorMessage(removeError))
    } finally {
      setBusyId(null)
    }
  }

  const handleSelectProject = (projectId: number) => {
    navigateTo('/')
    selectProject(projectId)
  }
  const handleNewChat = () => {
    navigateTo('/')
    startNewChat()
  }
  const handleStartStandaloneChat = () => {
    navigateTo('/')
    startStandaloneChat()
  }
  const handleStartNewProjectChat = (projectId: number) => {
    navigateTo('/')
    startNewProjectChat(projectId)
  }
  const handleOpenRuntimeTask = async (address: Parameters<typeof openRuntimeTask>[0]) => {
    navigateTo('/')
    await openRuntimeTask(address)
  }
  const permissionsReady = status.accessibilityGranted && status.inputMonitoringGranted
  const activityDescription = recording
    ? t('workbench.record_replay_step_count', '已捕获 {{count}} 个步骤', {
        count: status.stepCount,
      })
    : replaying
      ? t('workbench.record_replay_progress', '正在执行第 {{current}} / {{total}} 步', {
          current: status.currentStep ?? 0,
          total: status.stepCount,
        })
      : t(
          'workbench.record_replay_start_hint',
          '开始后切换到任意应用完成操作；返回这里停止，即可保存系统操作序列。'
        )
  const requestPermissions = async () => {
    try {
      setError(null)
      setStatus(await requestSystemRecordReplayPermissions())
    } catch (permissionError) {
      setError(errorMessage(permissionError))
    }
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-background text-text-primary">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {!isMobile && isDesktop && (
          <DesktopCollapsedSidebarToggle
            collapsed={sidebarCollapsed}
            onToggle={() => setSidebarCollapsed(false)}
          />
        )}
        {!isMobile && (
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
            activeItem="record-replay"
            collapsed={sidebarCollapsed}
            onToggleSidebar={() => setSidebarCollapsed(!sidebarCollapsed)}
            onNewChat={handleNewChat}
            onStartStandaloneChat={handleStartStandaloneChat}
            onOpenSearch={() => undefined}
            onSelectProject={handleSelectProject}
            onStartNewProjectChat={handleStartNewProjectChat}
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
            onGetDeviceHomeDirectory={getDeviceHomeDirectory}
            onListDeviceDirectories={listDeviceDirectories}
            onCreateDeviceDirectory={createDeviceDirectory}
            onOpenSettings={() => navigateTo('/settings')}
            onLogout={logout}
          />
        )}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-8 px-5 py-8">
            <header className="space-y-2">
              <div className="flex items-center gap-3">
                <ListRestart className="h-5 w-5" />
                <h1 className="heading-medium">{t('workbench.record_replay', '录制回放')}</h1>
              </div>
              <p className="max-w-2xl text-sm text-text-secondary">
                {t(
                  'workbench.record_replay_description',
                  '录制 macOS 全局鼠标、键盘、滚动与前台应用上下文，并在系统中回放。密码等敏感输入不会保存，高风险动作会暂停。'
                )}
              </p>
            </header>

            <section
              data-testid="record-replay-permissions"
              className="rounded-xl border border-border bg-surface px-4 py-3"
            >
              <div className="flex items-start gap-3">
                <MousePointer2 className="mt-0.5 h-4 w-4 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">
                    {t('workbench.record_replay_system_access', '系统操作权限')}
                  </div>
                  <p className="mt-1 text-xs text-text-secondary">
                    {!status.supported
                      ? t('workbench.record_replay_macos_only', '系统录制目前仅支持 macOS。')
                      : permissionsReady
                        ? t(
                            'workbench.record_replay_permissions_ready',
                            '辅助功能与输入监控均已允许，可以录制其他应用。'
                          )
                        : t(
                            'workbench.record_replay_permissions_hint',
                            '需要辅助功能权限执行回放，并需要输入监控权限捕获全局操作。'
                          )}
                  </p>
                </div>
                {permissionsReady ? (
                  <span
                    data-testid="record-replay-permissions-ready"
                    className="flex items-center gap-1 text-xs font-medium"
                  >
                    <Check className="h-3.5 w-3.5" />
                    {t('workbench.record_replay_allowed', '已允许')}
                  </span>
                ) : status.supported ? (
                  <div className="flex gap-2">
                    <Button
                      data-testid="record-replay-request-permissions"
                      size="sm"
                      variant="secondary"
                      onClick={() => void requestPermissions()}
                    >
                      {t('workbench.record_replay_request_permissions', '请求权限')}
                    </Button>
                    <Button
                      data-testid="record-replay-open-permissions"
                      size="icon"
                      variant="ghost"
                      aria-label={t('workbench.record_replay_open_settings', '打开系统设置')}
                      onClick={() => void openSystemRecordReplayPermissionSettings('accessibility')}
                    >
                      <Settings />
                    </Button>
                  </div>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-surface p-5">
              <div className="flex flex-col gap-4">
                <div>
                  <h2 className="heading-small">
                    {recording
                      ? t('workbench.record_replay_recording', '正在录制')
                      : replaying
                        ? t('workbench.record_replay_replaying', '正在回放')
                        : t('workbench.record_replay_new', '新建录制')}
                  </h2>
                  <p className="mt-1 text-sm text-text-secondary">
                    {activityDescription}
                    {status.currentApplication
                      ? ` · ${t('workbench.record_replay_current_app', '当前应用：{{app}}', {
                          app: status.currentApplication,
                        })}`
                      : ''}
                  </p>
                </div>
                {!active && (
                  <input
                    data-testid="record-replay-title-input"
                    value={title}
                    onChange={event => setTitle(event.target.value)}
                    placeholder={t('workbench.record_replay_title_placeholder', '录制名称')}
                    className="h-10 rounded-lg border border-border bg-background px-3 text-sm outline-none focus:border-focus"
                  />
                )}
                <div className="flex flex-wrap gap-2">
                  {!active ? (
                    <Button
                      data-testid="record-replay-start"
                      onClick={() => void start()}
                      disabled={!isDesktop || !status.supported || !permissionsReady}
                    >
                      <Play />
                      {t('workbench.record_replay_start', '开始录制')}
                    </Button>
                  ) : recording ? (
                    <>
                      <Button data-testid="record-replay-stop" onClick={() => void stop()}>
                        <Square />
                        {t('workbench.record_replay_stop', '停止并保存')}
                      </Button>
                    </>
                  ) : (
                    <Button
                      data-testid="record-replay-cancel"
                      variant="secondary"
                      onClick={() => void cancelSystemReplay()}
                    >
                      <Square />
                      {t('workbench.record_replay_cancel', '停止回放')}
                    </Button>
                  )}
                </div>
                {status.message && (
                  <div className="flex items-start gap-2 rounded-lg bg-muted p-3 text-sm">
                    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{status.message}</span>
                  </div>
                )}
                {error && (
                  <div
                    data-testid="record-replay-error"
                    className="rounded-lg bg-red-500/10 p-3 text-sm text-red-600"
                  >
                    {error}
                  </div>
                )}
              </div>
            </section>

            <section className="space-y-3">
              <div>
                <h2 className="heading-small">{t('workbench.record_replay_library', '录制库')}</h2>
                <p className="mt-1 text-sm text-text-secondary">
                  {t(
                    'workbench.record_replay_library_hint',
                    '录制仅保存在本机。回放会切换并操作录制时涉及的系统应用。'
                  )}
                </p>
              </div>
              {loading ? (
                <div className="flex items-center gap-2 py-8 text-sm text-text-secondary">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  {t('workbench.loading', '加载中')}
                </div>
              ) : recordings.length === 0 ? (
                <div
                  data-testid="record-replay-empty"
                  className="rounded-xl border border-dashed border-border px-5 py-10 text-center text-sm text-text-secondary"
                >
                  {t('workbench.record_replay_empty', '尚无录制')}
                </div>
              ) : (
                <div className="divide-y divide-border rounded-xl border border-border">
                  {recordings.map(recordingItem => (
                    <article
                      key={recordingItem.id}
                      data-testid={`record-replay-item-${recordingItem.id}`}
                      className="flex items-center gap-4 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{recordingItem.title}</div>
                        <div className="mt-1 text-xs text-text-secondary">
                          {dateFormatter.format(recordingItem.createdAt)} ·{' '}
                          {t('workbench.record_replay_steps', '{{count}} 步', {
                            count: recordingItem.stepCount,
                          })}
                          {' · '}
                          {t('workbench.record_replay_apps', '{{count}} 个应用', {
                            count: recordingItem.applicationCount,
                          })}
                          {recordingItem.containsHandoff
                            ? ` · ${t('workbench.record_replay_manual_handoff', '包含人工接管')}`
                            : ''}
                        </div>
                      </div>
                      <Button
                        data-testid={`record-replay-play-${recordingItem.id}`}
                        size="sm"
                        variant="secondary"
                        disabled={busyId !== null || active}
                        onClick={() => void replay(recordingItem.id)}
                      >
                        {busyId === recordingItem.id ? (
                          <Loader2 className="animate-spin" />
                        ) : (
                          <Play />
                        )}
                        {t('workbench.record_replay_play', '回放')}
                      </Button>
                      <Button
                        data-testid={`record-replay-delete-${recordingItem.id}`}
                        size="icon"
                        variant="ghost"
                        aria-label={t('workbench.record_replay_delete', '删除录制')}
                        disabled={busyId !== null || active}
                        onClick={() => void remove(recordingItem.id)}
                      >
                        <Trash2 />
                      </Button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          </div>
        </main>
      </div>
    </div>
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
