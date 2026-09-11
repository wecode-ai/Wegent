import { Check, Cloud, Copy, FolderOpen, Laptop } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import { normalizeRuntimeWorkspacePath } from '@/lib/runtime-project'
import { cn } from '@/lib/utils'
import {
  findWorkbenchDevice,
  getExecutorOfflineDeviceId,
  getWorkbenchDeviceUnavailableDisplayName,
  isWorkbenchDeviceOnline,
} from '@/lib/workbench-device'
import type { DeviceInfo } from '@/types/api'
import type { EnvironmentInfo } from '@/types/environment'

const COPIED_PATH_DURATION_MS = 2000

function compactWorkspacePath(workspacePath: string): string {
  const segments = workspacePath
    .replace(/[\\/]+$/, '')
    .split(/[\\/]+/)
    .filter(Boolean)
  return segments.at(-1) || workspacePath
}

function normalizeWorkspacePathForComparison(workspacePath: string): string {
  const normalizedPath = normalizeRuntimeWorkspacePath(workspacePath.replace(/\\/g, '/'))
  return /^(?:[A-Za-z]:|\/\/)/.test(normalizedPath) ? normalizedPath.toLowerCase() : normalizedPath
}

export function EnvironmentSummaryOverview({
  devices,
  info,
}: {
  devices: DeviceInfo[]
  info: EnvironmentInfo
}) {
  const { t } = useTranslation('common')
  const [copiedWorkspacePath, setCopiedWorkspacePath] = useState<string | null>(null)
  const copiedWorkspacePathTimeoutRef = useRef<number | null>(null)
  const executionDeviceId = info.executionDeviceId ?? info.deviceId
  const device = executionDeviceId ? findWorkbenchDevice(devices, executionDeviceId) : undefined
  const deviceName = device?.name?.trim() || ''
  const executionLabel =
    info.executionTarget === 'cloud'
      ? t('workbench.environment_cloud_device')
      : t('workbench.environment_local', '本地')
  const executionTargetLabel = t('workbench.environment_execution_target')
  const deviceLabel = t('workbench.environment_device')
  const deviceDisplayName = deviceName || t('workbench.environment_device_unknown')
  const executorDisplayName =
    info.executionTarget === 'cloud' && !isWorkbenchDeviceOnline(device ?? null)
      ? getWorkbenchDeviceUnavailableDisplayName(device ?? null) || deviceDisplayName
      : deviceDisplayName
  const ExecutorIcon = info.executionTarget === 'cloud' ? Cloud : Laptop
  const deviceTitle = [deviceLabel, deviceDisplayName].filter(Boolean).join(' · ')
  const offlineDeviceId = getExecutorOfflineDeviceId(info.error)
  const offlineDevice = offlineDeviceId ? findWorkbenchDevice(devices, offlineDeviceId) : null
  const displayError = offlineDeviceId
    ? t('workbench.conversation_device_offline_notice', {
        device:
          getWorkbenchDeviceUnavailableDisplayName(offlineDevice) ||
          t('workbench.current_device', '当前设备'),
      })
    : info.error
  const normalizedWorkspacePath = info.workspacePath
    ? normalizeWorkspacePathForComparison(info.workspacePath)
    : ''
  const workspacePathIsProjectRoot = Boolean(
    normalizedWorkspacePath &&
    info.workspaceRoots?.some(
      workspaceRoot =>
        normalizeWorkspacePathForComparison(workspaceRoot) === normalizedWorkspacePath
    )
  )
  const workspacePaths =
    info.workspacePath && !workspacePathIsProjectRoot
      ? [info.workspacePath]
      : info.workspaceRoots && info.workspaceRoots.length > 0
        ? info.workspaceRoots
        : info.workspacePath
          ? [info.workspacePath]
          : []

  useEffect(
    () => () => {
      if (copiedWorkspacePathTimeoutRef.current !== null) {
        window.clearTimeout(copiedWorkspacePathTimeoutRef.current)
      }
    },
    []
  )

  async function handleCopyWorkspacePath(workspacePath: string) {
    await copyTextToClipboard(workspacePath)
    if (copiedWorkspacePathTimeoutRef.current !== null) {
      window.clearTimeout(copiedWorkspacePathTimeoutRef.current)
    }
    setCopiedWorkspacePath(workspacePath)
    copiedWorkspacePathTimeoutRef.current = window.setTimeout(() => {
      setCopiedWorkspacePath(current => (current === workspacePath ? null : current))
      copiedWorkspacePathTimeoutRef.current = null
    }, COPIED_PATH_DURATION_MS)
  }

  return (
    <>
      <h2 className="mb-3 text-sm font-medium text-text-primary">
        {t('workbench.environment_summary_title', '环境')}
      </h2>
      <section
        data-testid="environment-device-section"
        className="flex w-full min-w-0 flex-col gap-1"
      >
        {workspacePaths.map((workspacePath, index) => {
          const copied = copiedWorkspacePath === workspacePath
          return (
            <div
              key={workspacePath}
              className="flex min-h-11 min-w-0 items-start gap-2 py-1 md:min-h-0"
              data-testid={`environment-workspace-root-row-${index}`}
            >
              <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <button
                type="button"
                data-testid={
                  index === 0
                    ? 'environment-workspace-path-button'
                    : `environment-workspace-root-button-${index}`
                }
                onClick={() => void handleCopyWorkspacePath(workspacePath)}
                title={workspacePath}
                aria-label={`${t('workbench.environment_workspace_path')} · ${workspacePath}`}
                className="flex min-h-11 min-w-0 flex-1 items-start gap-1 rounded text-left hover:text-text-primary md:min-h-0"
              >
                <span className="sr-only">{t('workbench.environment_workspace_path')}</span>
                <span
                  data-testid={
                    index === 0
                      ? 'environment-workspace-path'
                      : `environment-workspace-root-${index}`
                  }
                  className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary"
                >
                  {compactWorkspacePath(workspacePath)}
                </span>
                <span
                  data-testid={
                    index === 0
                      ? 'environment-workspace-path-copy-icon'
                      : `environment-workspace-root-copy-icon-${index}`
                  }
                  className={cn(
                    'mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center',
                    copied ? 'text-green-500' : 'text-text-muted'
                  )}
                  aria-hidden="true"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </span>
                {copied && (
                  <span role="status" className="sr-only">
                    {t('workbench.environment_copied')}
                  </span>
                )}
              </button>
            </div>
          )
        })}
        <div
          data-testid="environment-execution-target-row"
          title={`${executionTargetLabel} · ${executionLabel}; ${deviceTitle}`}
          className="flex h-7 min-w-0 items-center gap-2 text-xs text-text-secondary"
        >
          <ExecutorIcon className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
          <span className="sr-only">
            {executionTargetLabel} · {executionLabel} ·{' '}
          </span>
          <div data-testid="environment-device-button" className="min-w-0 truncate">
            <span className="sr-only">{deviceLabel}</span>
            <span data-testid="environment-device-name" className="whitespace-nowrap">
              {executorDisplayName}
            </span>
          </div>
        </div>
      </section>
      {displayError && (
        <p className="mt-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-600">{displayError}</p>
      )}
    </>
  )
}
