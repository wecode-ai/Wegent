import { ArrowRight, Clock3, FolderOpen, RotateCw, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type {
  DeviceInfo,
  LocalCodexBindRequest,
  LocalCodexBindResponse,
  LocalCodexThreadSummary,
  ProjectWithTasks,
} from '@/types/api'

interface LocalCodexThreadImportDialogProps {
  open: boolean
  devices: DeviceInfo[]
  projects: ProjectWithTasks[]
  onClose: () => void
  onListLocalCodexThreads: (
    deviceId: string,
    limit?: number,
  ) => Promise<LocalCodexThreadSummary[]>
  onBindLocalCodexThread: (
    request: LocalCodexBindRequest,
  ) => Promise<LocalCodexBindResponse>
}

function getOnlineLocalDevices(devices: DeviceInfo[]): DeviceInfo[] {
  return devices
    .filter(device => device.device_type === 'local' && device.status === 'online')
    .sort((left, right) => (left.name || left.device_id).localeCompare(right.name || right.device_id))
}

function formatUpdatedTime(value: string | undefined) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString()
}

function normalizeWorkspacePath(value: string | undefined | null): string {
  return (value ?? '').trim().replace(/\/+$/, '')
}

function getPathBaseName(value: string | undefined | null): string {
  const normalized = normalizeWorkspacePath(value)
  if (!normalized) return ''
  const parts = normalized.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? ''
}

function getProjectWorkspacePath(project: ProjectWithTasks): string {
  const workspace = project.config?.workspace
  return normalizeWorkspacePath(
    workspace?.localPath || workspace?.checkoutPath || project.config?.path,
  )
}

function findProjectForLocalCodexThread(
  thread: LocalCodexThreadSummary,
  projects: ProjectWithTasks[],
): ProjectWithTasks | null {
  const threadPath = normalizeWorkspacePath(thread.cwd)
  if (!threadPath) return null

  const projectMatches = projects
    .map(project => ({
      project,
      path: getProjectWorkspacePath(project),
      pathBaseName: getPathBaseName(getProjectWorkspacePath(project)),
    }))
    .filter(match => match.path || match.pathBaseName)

  const exactMatch = projectMatches.find(match => match.path === threadPath)
  if (exactMatch) return exactMatch.project

  const threadBaseName = getPathBaseName(threadPath)
  if (!threadBaseName) return null

  const basenameMatches = projectMatches.filter(
    match => match.pathBaseName === threadBaseName,
  )
  return basenameMatches.length === 1 ? basenameMatches[0].project : null
}

interface LocalCodexThreadGroup {
  key: string
  title: string
  testId: string
  threads: LocalCodexThreadSummary[]
}

function groupLocalCodexThreadsByProject(
  threads: LocalCodexThreadSummary[],
  projects: ProjectWithTasks[],
  unmatchedTitle: string,
): LocalCodexThreadGroup[] {
  const groupedByProjectId = new Map<number, LocalCodexThreadSummary[]>()
  const unmatchedThreads: LocalCodexThreadSummary[] = []

  for (const thread of threads) {
    const project = findProjectForLocalCodexThread(thread, projects)
    if (!project) {
      unmatchedThreads.push(thread)
      continue
    }
    const projectThreads = groupedByProjectId.get(project.id) ?? []
    projectThreads.push(thread)
    groupedByProjectId.set(project.id, projectThreads)
  }

  const groups = projects
    .map(project => ({
      key: String(project.id),
      title: project.name,
      testId: `local-codex-project-group-${project.id}`,
      threads: groupedByProjectId.get(project.id) ?? [],
    }))
    .filter(group => group.threads.length > 0)

  if (unmatchedThreads.length > 0) {
    groups.push({
      key: 'unmatched',
      title: unmatchedTitle,
      testId: 'local-codex-project-group-unmatched',
      threads: unmatchedThreads,
    })
  }

  return groups
}

export function LocalCodexThreadImportDialog({
  open,
  devices,
  projects,
  onClose,
  onListLocalCodexThreads,
  onBindLocalCodexThread,
}: LocalCodexThreadImportDialogProps) {
  if (!open) return null

  return (
    <LocalCodexThreadImportDialogContent
      devices={devices}
      projects={projects}
      onClose={onClose}
      onListLocalCodexThreads={onListLocalCodexThreads}
      onBindLocalCodexThread={onBindLocalCodexThread}
    />
  )
}

function LocalCodexThreadRow({
  thread,
  bindingThreadId,
  onBindThread,
}: {
  thread: LocalCodexThreadSummary
  bindingThreadId: string | null
  onBindThread: (thread: LocalCodexThreadSummary) => void
}) {
  const { t } = useTranslation('common')
  const unavailable = Boolean(thread.archived || thread.running)
  const updatedTime = formatUpdatedTime(thread.updatedAt)
  const bindLabel = t('localCodex.bind')

  return (
    <div
      data-testid="local-codex-thread-row"
      className="flex min-h-[76px] items-center gap-3 px-3 py-3"
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium text-[#202124]">
            {thread.title || thread.threadId}
          </div>
          {thread.running && (
            <span className="shrink-0 rounded-full bg-[#eef2ff] px-2 py-0.5 text-[11px] font-medium leading-4 text-[#4f46e5]">
              {t('localCodex.running')}
            </span>
          )}
        </div>
        <div className="mt-1 flex min-w-0 items-center gap-3 text-xs leading-5 text-[#606368]">
          {thread.cwd && (
            <span className="flex min-w-0 items-center gap-1">
              <FolderOpen className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{thread.cwd}</span>
            </span>
          )}
          {updatedTime && (
            <span className="flex shrink-0 items-center gap-1">
              <Clock3 className="h-3.5 w-3.5" />
              {t('localCodex.updatedAt', { time: updatedTime })}
            </span>
          )}
        </div>
      </div>
      <button
        type="button"
        data-testid="local-codex-bind-button"
        disabled={unavailable || bindingThreadId !== null}
        onClick={() => onBindThread(thread)}
        className="flex h-9 min-w-[72px] shrink-0 items-center justify-center gap-1.5 rounded-md bg-text-primary px-3 text-[13px] font-medium leading-[18px] text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
        title={unavailable ? t('localCodex.threadUnavailable') : bindLabel}
      >
        <ArrowRight className="h-4 w-4" />
        {bindingThreadId === thread.threadId ? t('common.loading') : bindLabel}
      </button>
    </div>
  )
}

function LocalCodexThreadImportDialogContent({
  devices,
  projects,
  onClose,
  onListLocalCodexThreads,
  onBindLocalCodexThread,
}: Omit<LocalCodexThreadImportDialogProps, 'open'>) {
  const { t } = useTranslation('common')
  const onlineLocalDevices = useMemo(() => getOnlineLocalDevices(devices), [devices])
  const [selectedDeviceId, setSelectedDeviceId] = useState(
    () => onlineLocalDevices[0]?.device_id ?? '',
  )
  const [threads, setThreads] = useState<LocalCodexThreadSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [bindingThreadId, setBindingThreadId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const threadGroups = useMemo(
    () =>
      groupLocalCodexThreadsByProject(
        threads,
        projects,
        t('localCodex.unmatchedProject'),
      ),
    [projects, threads, t],
  )
  const effectiveDeviceId = onlineLocalDevices.some(device => device.device_id === selectedDeviceId)
    ? selectedDeviceId
    : onlineLocalDevices[0]?.device_id ?? ''

  useEscapeKey(onClose)

  useEffect(() => {
    if (!effectiveDeviceId) return

    let cancelled = false
    async function loadThreads() {
      setLoading(true)
      setError(null)
      try {
        const items = await onListLocalCodexThreads(effectiveDeviceId)
        if (!cancelled) {
          setThreads(items)
        }
      } catch {
        if (!cancelled) {
          setThreads([])
          setError(t('localCodex.loadFailed'))
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    void loadThreads()

    return () => {
      cancelled = true
    }
  }, [effectiveDeviceId, onListLocalCodexThreads, t])

  async function refreshThreads() {
    if (!effectiveDeviceId || loading) return
    setLoading(true)
    setError(null)
    try {
      setThreads(await onListLocalCodexThreads(effectiveDeviceId))
    } catch {
      setThreads([])
      setError(t('localCodex.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  async function bindThread(thread: LocalCodexThreadSummary) {
    if (!effectiveDeviceId || thread.archived || thread.running || bindingThreadId) return

    setBindingThreadId(thread.threadId)
    setError(null)
    try {
      await onBindLocalCodexThread({
        deviceId: effectiveDeviceId,
        threadId: thread.threadId,
        title: thread.title,
        cwd: thread.cwd,
      })
      onClose()
    } catch (bindError) {
      setError(bindError instanceof Error ? bindError.message : t('localCodex.threadMissing'))
    } finally {
      setBindingThreadId(null)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        data-testid="local-codex-import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-codex-import-title"
        className="flex max-h-[78vh] w-full max-w-[620px] flex-col rounded-lg border border-[#d8d8d8] bg-white p-5 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2
              id="local-codex-import-title"
              className="text-base font-semibold text-[#202124]"
            >
              {t('localCodex.dialogTitle')}
            </h2>
            <label className="mt-4 block text-[13px] font-medium leading-[18px] text-[#3c4043]">
              {t('localCodex.deviceLabel')}
            </label>
          </div>
          <button
            type="button"
            data-testid="local-codex-close-button"
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-[#606368] hover:bg-[#f1f3f4]"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {onlineLocalDevices.length === 0 ? (
          <div className="mt-5 rounded-lg border border-dashed border-[#d8d8d8] bg-[#f7f7f8] px-4 py-8 text-center text-sm text-[#606368]">
            {t('localCodex.offline')}
          </div>
        ) : (
          <>
            <div className="mt-2 flex items-center gap-2">
              <select
                data-testid="local-codex-device-select"
                value={effectiveDeviceId}
                onChange={event => setSelectedDeviceId(event.target.value)}
                disabled={loading || bindingThreadId !== null}
                className="h-10 min-w-0 flex-1 rounded-lg border border-[#d8d8d8] bg-white px-3 text-[13px] outline-none focus:border-[#14b8a6] focus:ring-2 focus:ring-[#14b8a6]/20 disabled:opacity-60"
              >
                {onlineLocalDevices.map(device => (
                  <option key={device.device_id} value={device.device_id}>
                    {device.name || device.device_id}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="local-codex-refresh-button"
                disabled={loading || bindingThreadId !== null}
                onClick={refreshThreads}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-[#d8d8d8] text-[#606368] hover:bg-[#f7f7f8] hover:text-[#202124] disabled:cursor-not-allowed disabled:opacity-50"
                title={t('workbench.refresh_worklists', '刷新')}
                aria-label={t('workbench.refresh_worklists', '刷新')}
              >
                <RotateCw className={cn('h-4 w-4', loading && 'animate-spin')} />
              </button>
            </div>

            {error && (
              <div className="mt-3 rounded-md bg-red-50 px-3 py-2 text-xs leading-5 text-red-600">
                {error}
              </div>
            )}

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto rounded-lg border border-[#ededed]">
              {loading ? (
                <div className="flex h-28 items-center justify-center text-sm text-[#606368]">
                  {t('common.loading')}
                </div>
              ) : threads.length === 0 ? (
                <div className="flex h-28 items-center justify-center text-sm text-[#606368]">
                  {t('localCodex.empty')}
                </div>
              ) : (
                <div className="divide-y divide-[#ededed]">
                  {threadGroups.map(group => (
                    <section
                      key={group.key}
                      data-testid={group.testId}
                      className="min-w-0"
                    >
                      <div className="sticky top-0 z-10 border-b border-[#ededed] bg-[#f7f7f8] px-3 py-2 text-xs font-semibold leading-5 text-[#3c4043]">
                        {group.title}
                      </div>
                      <div className="divide-y divide-[#ededed]">
                        {group.threads.map(thread => (
                          <LocalCodexThreadRow
                            key={thread.threadId}
                            thread={thread}
                            bindingThreadId={bindingThreadId}
                            onBindThread={bindThread}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}
