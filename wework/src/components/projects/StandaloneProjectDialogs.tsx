import { Globe2, Loader2, X } from 'lucide-react'
import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canUseForProjectCreation,
  isCloudDevice,
  isClaudeCodeDevice,
  isRemoteDevice,
} from '@/lib/device-capabilities'
import type { DeviceInfo } from '@/types/api'
import { DeviceFolderPicker } from './DeviceFolderPicker'
import { joinPath } from './device-folder-path'

export type StandaloneWorkspaceDialogMode = 'existing' | 'remote'

function isLocalDevice(device: DeviceInfo): boolean {
  return !isCloudDevice(device) && !isRemoteDevice(device)
}

function isRemoteProjectDevice(device: DeviceInfo): boolean {
  return isCloudDevice(device) || isRemoteDevice(device)
}

function getStandaloneDeviceLabel(device: DeviceInfo): string {
  return device.name || device.device_id
}

function extractNetworkHost(value?: string | null): string | null {
  if (!value) return null
  const trimmedValue = value.trim()
  if (!trimmedValue) return null

  const bracketMatch = trimmedValue.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]

  const colonParts = trimmedValue.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0]
  }

  return trimmedValue
}

function getRemoteDeviceNetworkLabel(device: DeviceInfo): string | null {
  return extractNetworkHost(device.runtime_transfer_host) ?? extractNetworkHost(device.client_ip)
}

function getRemoteDeviceLabel(device: DeviceInfo): string {
  const networkLabel = getRemoteDeviceNetworkLabel(device)
  const deviceLabel = getStandaloneDeviceLabel(device)
  if (!networkLabel) return deviceLabel
  if (networkLabel === deviceLabel) return networkLabel
  return `${networkLabel} · ${deviceLabel}`
}

function getUsableStandaloneDevices(
  devices: DeviceInfo[],
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo[] {
  const isTargetDevice = mode === 'remote' ? isRemoteProjectDevice : isLocalDevice
  return devices
    .filter(device => isClaudeCodeDevice(device) && isTargetDevice(device))
    .filter(canUseForProjectCreation)
    .sort((left, right) => {
      const leftLabel =
        mode === 'remote' ? getRemoteDeviceLabel(left) : getStandaloneDeviceLabel(left)
      const rightLabel =
        mode === 'remote' ? getRemoteDeviceLabel(right) : getStandaloneDeviceLabel(right)
      return leftLabel.localeCompare(rightLabel)
    })
}

function getPreferredStandaloneWorkspaceDevice(
  devices: DeviceInfo[],
  preferredDeviceId: string | null | undefined,
  mode: StandaloneWorkspaceDialogMode
): DeviceInfo | null {
  const usableDevices = getUsableStandaloneDevices(devices, mode)
  return (
    usableDevices.find(device => device.device_id === preferredDeviceId) ??
    usableDevices.find(device => device.is_default) ??
    usableDevices[0] ??
    null
  )
}

function getUniqueProjectDirectoryName(baseName: string, existingNames: string[]): string {
  const existingNameSet = new Set(existingNames.map(name => name.trim()).filter(Boolean))
  if (!existingNameSet.has(baseName)) return baseName

  for (let suffix = 2; suffix < 10000; suffix += 1) {
    const candidate = `${baseName} ${suffix}`
    if (!existingNameSet.has(candidate)) return candidate
  }

  return `${baseName} ${Date.now()}`
}

export function StandaloneBlankProjectDialog({
  open,
  devices,
  preferredDeviceId,
  onClose,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenStandaloneWorkspace,
}: {
  open: boolean
  devices: DeviceInfo[]
  preferredDeviceId?: string | null
  onClose: () => void
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenStandaloneWorkspace?: (deviceId: string, workspacePath: string) => void
}) {
  const { t } = useTranslation('common')
  const [projectName, setProjectName] = useState('New project')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targetDevice = useMemo(
    () => getPreferredStandaloneWorkspaceDevice(devices, preferredDeviceId, 'existing'),
    [devices, preferredDeviceId]
  )

  useEscapeKey(onClose, !submitting)

  if (!open) return null

  const submit = async () => {
    const trimmedName = projectName.trim()
    if (!trimmedName || submitting) return
    if (!targetDevice) {
      setError(t('workbench.no_local_project_device', '暂无可用本地设备'))
      return
    }

    setSubmitting(true)
    setError(null)
    try {
      const homeDirectory = await onGetDeviceHomeDirectory(targetDevice.device_id)
      const documentsPath = joinPath(homeDirectory, 'Documents')
      await onCreateDeviceDirectory(targetDevice.device_id, documentsPath)
      const existingDirectoryNames = await onListDeviceDirectories(
        targetDevice.device_id,
        documentsPath
      )
      const projectDirectoryName = getUniqueProjectDirectoryName(
        trimmedName,
        existingDirectoryNames
      )
      const workspacePath = joinPath(documentsPath, projectDirectoryName)
      await onCreateDeviceDirectory(targetDevice.device_id, workspacePath)
      onOpenStandaloneWorkspace?.(targetDevice.device_id, workspacePath)
      onClose()
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : t('workbench.project_create_failed', '项目创建失败')
      )
    } finally {
      setSubmitting(false)
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        data-testid="standalone-blank-project-dialog"
        className="w-full max-w-[420px] rounded-2xl border border-border bg-surface p-5 text-text-primary shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-xl font-semibold leading-7">
              {t('workbench.blank_project_name_title', '为项目命名')}
            </h2>
            <p className="mt-2 text-sm leading-5 text-text-secondary">
              {t('workbench.blank_project_name_desc', '保持简短且易识别')}
            </p>
          </div>
          <button
            type="button"
            data-testid="close-standalone-blank-project-dialog"
            disabled={submitting}
            onClick={onClose}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted disabled:opacity-50"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <input
          data-testid="standalone-blank-project-name-input"
          value={projectName}
          autoFocus
          onFocus={event => event.currentTarget.select()}
          disabled={submitting}
          onChange={event => {
            setProjectName(event.target.value)
            setError(null)
          }}
          onKeyDown={event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void submit()
            }
          }}
          className="mt-5 h-12 w-full rounded-xl border border-border bg-transparent px-4 text-base text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/10 disabled:opacity-50"
        />
        {error && <p className="mt-3 text-xs text-red-500">{error}</p>}
        <div className="mt-5 flex justify-end gap-3">
          <button
            type="button"
            data-testid="cancel-standalone-blank-project-button"
            disabled={submitting}
            onClick={onClose}
            className="h-10 rounded-xl border border-border px-5 text-sm font-medium text-text-primary hover:bg-muted disabled:opacity-50"
          >
            {t('workbench.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="save-standalone-blank-project-button"
            disabled={!projectName.trim() || submitting || !targetDevice}
            onClick={() => void submit()}
            className="inline-flex h-10 items-center gap-2 rounded-xl bg-text-primary px-5 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('workbench.save', '保存')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

export function StandaloneFolderProjectDialog({
  open,
  mode,
  devices,
  preferredDeviceId,
  onClose,
  onGetDeviceHomeDirectory,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onOpenStandaloneWorkspace,
}: {
  open: boolean
  mode: StandaloneWorkspaceDialogMode
  devices: DeviceInfo[]
  preferredDeviceId?: string | null
  onClose: () => void
  onGetDeviceHomeDirectory: (deviceId: string) => Promise<string>
  onListDeviceDirectories: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory: (deviceId: string, path: string) => Promise<void>
  onOpenStandaloneWorkspace?: (deviceId: string, workspacePath: string) => void
}) {
  const { t } = useTranslation('common')
  const selectableDevices = useMemo(
    () => getUsableStandaloneDevices(devices, mode),
    [devices, mode]
  )
  const defaultDevice = useMemo(
    () => getPreferredStandaloneWorkspaceDevice(devices, preferredDeviceId, mode),
    [devices, mode, preferredDeviceId]
  )
  const [activeDeviceId, setActiveDeviceId] = useState(
    defaultDevice?.device_id ?? selectableDevices[0]?.device_id ?? ''
  )
  const activeDevice =
    selectableDevices.find(device => device.device_id === activeDeviceId) ??
    selectableDevices[0] ??
    null

  useEscapeKey(onClose, open)

  if (!open) return null

  const title =
    mode === 'remote'
      ? t('workbench.add_remote_project_title', '添加远程项目')
      : t('workbench.use_existing_folder_title', '使用现有文件夹')
  const description =
    mode === 'remote'
      ? t('workbench.add_remote_project_desc', '选择已连接的远程主机，并选择此项目的文件夹。')
      : t('workbench.use_existing_folder_desc', '选择本地设备上的一个文件夹。')

  return createPortal(
    <div className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4">
      <div
        role="dialog"
        aria-modal="true"
        data-testid="standalone-folder-project-dialog"
        className="max-h-[92vh] w-full max-w-[720px] overflow-y-auto rounded-[28px] border border-border bg-surface p-7 text-text-primary shadow-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-3xl font-semibold leading-tight">{title}</h2>
            <p className="mt-4 text-lg text-text-secondary">{description}</p>
          </div>
          <button
            type="button"
            data-testid="close-standalone-folder-project-dialog"
            onClick={onClose}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-md text-text-secondary hover:bg-muted"
            aria-label={t('workbench.close_dialog', '关闭')}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        {mode === 'remote' && selectableDevices.length > 0 && (
          <label className="mt-7 block">
            <span className="text-lg font-semibold">{t('workbench.remote_host', '远程主机')}</span>
            <span className="mt-3 flex h-14 items-center gap-3 rounded-[16px] border border-border px-4">
              <Globe2 className="h-5 w-5 text-primary" />
              <select
                data-testid="standalone-remote-device-select"
                value={activeDevice?.device_id ?? ''}
                onChange={event => setActiveDeviceId(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-lg text-text-primary outline-none"
              >
                {selectableDevices.map(device => (
                  <option key={device.device_id} value={device.device_id}>
                    {getRemoteDeviceLabel(device)}
                  </option>
                ))}
              </select>
            </span>
          </label>
        )}

        {!activeDevice ? (
          <p
            data-testid="standalone-folder-no-device"
            className="mt-7 rounded-[16px] border border-border px-4 py-5 text-text-secondary"
          >
            {mode === 'remote'
              ? t('workbench.no_remote_project_device', '暂无可用远程或云设备')
              : t('workbench.no_local_project_device', '暂无可用本地设备')}
          </p>
        ) : (
          <div className="mt-7">
            <DeviceFolderPicker
              key={activeDevice.device_id}
              device={activeDevice}
              mode="select"
              onGetDeviceHomeDirectory={onGetDeviceHomeDirectory}
              onListDeviceDirectories={onListDeviceDirectories}
              onCreateDeviceDirectory={onCreateDeviceDirectory}
              onCancel={onClose}
              onConfirm={result => {
                onOpenStandaloneWorkspace?.(result.deviceId, result.path)
                onClose()
              }}
            />
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}
