import { Check, Cloud, Copy, Plus, Server, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createDeviceApi } from '@/api/devices'
import type { RemoteDeviceConnectionStatus } from '@/extensions/remote-device-onboarding-contract'
import { useTranslation } from '@/hooks/useTranslation'
import { copyTextToClipboard } from '@/lib/clipboard'
import type { DeviceInfo, DockerRemoteDeviceCommandResponse } from '@/types/devices'
import { track } from '@/telemetry/client'
import { remoteDeviceOnboardingExtension } from '@extensions/remote-device-onboarding'

const IS_WEWORK_E2E = import.meta.env.VITE_WEWORK_E2E === 'true'
const REMOTE_DEVICE_POLL_INTERVAL_MS = IS_WEWORK_E2E ? 100 : 2000
const REMOTE_DEVICE_POLL_ATTEMPTS = IS_WEWORK_E2E ? 100 : 150
const REMOTE_DEVICE_REQUEST_TIMEOUT_MS = IS_WEWORK_E2E ? 1000 : 30_000

interface CloudDeviceDialogConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
}

interface AddCloudDeviceDialogProps {
  open: boolean
  hasCloudDevice?: boolean
  cloudConnection: CloudDeviceDialogConnection
  onClose: () => void
  onCreated: (devices?: DeviceInfo[]) => void | Promise<void>
  onCreatingChange?: (creating: boolean) => void
}

function createCloudDeviceApi(connection: CloudDeviceDialogConnection) {
  if (!connection.isConnected || !connection.apiBaseUrl || !connection.token) {
    throw new Error('Cloud connection is required')
  }
  return createDeviceApi(
    createHttpClient({
      baseUrl: connection.apiBaseUrl,
      getToken: () => connection.token,
      redirectOnUnauthorized: false,
    })
  )
}

export function AddCloudDeviceDialog({
  open,
  hasCloudDevice = false,
  cloudConnection,
  onClose,
  onCreated,
  onCreatingChange,
}: AddCloudDeviceDialogProps) {
  const { t } = useTranslation('common')
  const [loading, setLoading] = useState(false)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remoteCommand, setRemoteCommand] = useState<DockerRemoteDeviceCommandResponse | null>(null)
  const [remoteStatus, setRemoteStatus] = useState<RemoteDeviceConnectionStatus>('idle')
  const [copied, setCopied] = useState(false)
  const onCloseRef = useRef(onClose)
  const onCreatedRef = useRef(onCreated)
  const cloudApiBaseUrl = cloudConnection.apiBaseUrl
  const cloudIsConnected = cloudConnection.isConnected
  const cloudToken = cloudConnection.token

  useEffect(() => {
    onCloseRef.current = onClose
    onCreatedRef.current = onCreated
  }, [onClose, onCreated])

  useEffect(() => {
    if (!remoteCommand) return

    let cancelled = false
    let activeRequestController: AbortController | null = null
    const pollForDevice = async () => {
      setRemoteStatus('waiting')
      for (let attempt = 0; attempt < REMOTE_DEVICE_POLL_ATTEMPTS; attempt += 1) {
        if (attempt > 0) {
          await new Promise(resolve => window.setTimeout(resolve, REMOTE_DEVICE_POLL_INTERVAL_MS))
        }
        if (cancelled) return
        const requestController = new AbortController()
        activeRequestController = requestController
        let requestTimeoutId: number | null = null
        try {
          const devices = await Promise.race([
            createCloudDeviceApi({
              apiBaseUrl: cloudApiBaseUrl,
              isConnected: cloudIsConnected,
              token: cloudToken,
            }).getAllDevices({ signal: requestController.signal }),
            new Promise<never>((_, reject) => {
              requestTimeoutId = window.setTimeout(() => {
                requestController.abort()
                reject(new Error('Remote device polling request timed out'))
              }, REMOTE_DEVICE_REQUEST_TIMEOUT_MS)
            }),
          ])
          const device = devices.find(item => item.device_id === remoteCommand.device_id)
          if (!device) continue
          if (device.status !== 'online') {
            setRemoteStatus('connecting')
            continue
          }
          const versionMismatch = device.executor_version === 'dev' || device.update_available
          setRemoteStatus(versionMismatch ? 'version_mismatch' : 'online')
          await onCreatedRef.current(devices)
          if (!cancelled) onCloseRef.current()
          return
        } catch {
          if (cancelled) return
          // Keep polling while the cloud connection recovers.
        } finally {
          if (requestTimeoutId !== null) window.clearTimeout(requestTimeoutId)
          if (activeRequestController === requestController) activeRequestController = null
        }
      }
      if (!cancelled) setRemoteStatus('connection_failed')
    }

    void pollForDevice()
    return () => {
      cancelled = true
      activeRequestController?.abort()
    }
  }, [cloudApiBaseUrl, cloudIsConnected, cloudToken, remoteCommand])

  const handleCreate = useCallback(async () => {
    if (hasCloudDevice) {
      setError(t('workbench.add_device_cloud_limit_error'))
      return
    }
    setLoading(true)
    setError(null)
    try {
      await createCloudDeviceApi(cloudConnection).createCloudDevice()
      track('feature_action_completed', { domain: 'cloud_device', action: 'create' })
      onCreatingChange?.(true)
      onClose()
      onCreated()
    } catch (e) {
      track('operation_failed', { operation: 'cloud_device_action' })
      setError(e instanceof Error ? e.message : t('workbench.add_device_cloud_create_failed'))
      onCreatingChange?.(false)
    } finally {
      setLoading(false)
    }
  }, [cloudConnection, hasCloudDevice, onClose, onCreated, onCreatingChange, t])

  const handleCreateRemoteDocker = useCallback(async () => {
    setRemoteLoading(true)
    setError(null)
    setCopied(false)
    setRemoteStatus('idle')
    try {
      const result = await createCloudDeviceApi(cloudConnection).createDockerRemoteDeviceCommand()
      setRemoteCommand(result)
      track('feature_action_completed', { domain: 'cloud_device', action: 'create' })
    } catch (e) {
      track('operation_failed', { operation: 'cloud_device_action' })
      setError(e instanceof Error ? e.message : t('workbench.remote_docker_generate_failed'))
    } finally {
      setRemoteLoading(false)
    }
  }, [cloudConnection, t])

  const handleCopyRemoteCommand = useCallback(async () => {
    if (!remoteCommand) return
    try {
      await copyTextToClipboard(remoteCommand.command)
      setCopied(true)
    } catch {
      setError(t('workbench.remote_docker_copy_failed'))
    }
  }, [remoteCommand, t])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 p-4"
      onClick={e => {
        if (!loading && e.target === e.currentTarget) onClose()
      }}
    >
      <div
        data-testid="add-cloud-device-dialog"
        className="max-h-[calc(100vh-32px)] w-full max-w-[800px] overflow-hidden rounded-lg border border-border bg-popover shadow-lg"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-text-secondary">
            <Plus className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">
              {t('workbench.add_device_dialog_title')}
            </h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">
              {t('workbench.add_device_dialog_description')}
            </p>
          </div>
          <button
            type="button"
            data-testid="add-cloud-device-close"
            onClick={onClose}
            disabled={loading}
            className="-mr-1 -mt-1 shrink-0 rounded-md p-1 text-text-muted hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {error && (
          <div className="mx-5 mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-500">
            {error}
          </div>
        )}

        <div className="mt-5 max-h-[calc(100vh-176px)] space-y-3 overflow-y-auto px-5 pb-1">
          <div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-text-secondary">
              <Cloud className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {t('workbench.add_device_cloud_title')}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-text-secondary">
                    {hasCloudDevice
                      ? t('workbench.add_device_cloud_limit_description')
                      : t('workbench.add_device_cloud_description')}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="add-cloud-device-confirm"
                  onClick={handleCreate}
                  disabled={hasCloudDevice || loading || remoteLoading}
                  className="h-8 shrink-0 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {hasCloudDevice
                    ? t('workbench.add_device_cloud_created')
                    : loading
                      ? t('workbench.add_device_cloud_creating')
                      : t('workbench.add_device_cloud_create')}
                </button>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-lg border border-border bg-background p-3">
            <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-background text-text-secondary">
              <Server className="h-4 w-4" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-text-primary">
                    {t('workbench.remote_docker_title')}
                  </h3>
                  <p className="mt-1 text-xs leading-5 text-text-secondary">
                    {t('workbench.remote_docker_description')}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="add-remote-docker-button"
                  onClick={handleCreateRemoteDocker}
                  disabled={loading || remoteLoading}
                  className="h-8 shrink-0 rounded-md bg-surface px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {remoteLoading
                    ? t('workbench.remote_docker_generating')
                    : t('workbench.remote_docker_generate')}
                </button>
              </div>

              <remoteDeviceOnboardingExtension.Notice />

              {remoteCommand && (
                <div className="mt-3 overflow-hidden rounded-lg border border-border bg-background">
                  <div className="flex h-8 items-center justify-between border-b border-border px-3">
                    <span className="text-xs font-semibold text-text-secondary">
                      {t('workbench.remote_docker_command_title')}
                    </span>
                    <button
                      type="button"
                      data-testid="copy-remote-docker-command"
                      onClick={handleCopyRemoteCommand}
                      className="inline-flex h-6 items-center gap-1 rounded px-2 text-xs text-text-secondary hover:bg-muted hover:text-text-primary"
                    >
                      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copied
                        ? t('workbench.remote_docker_copied')
                        : t('workbench.remote_docker_copy')}
                    </button>
                  </div>
                  <pre
                    data-testid="remote-docker-command"
                    className="max-h-[360px] overflow-auto whitespace-pre p-3 font-mono text-xs leading-5 text-text-primary"
                  >
                    {remoteCommand.command}
                  </pre>
                  <remoteDeviceOnboardingExtension.CommandDetails
                    command={remoteCommand}
                    status={remoteStatus}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 pb-5 pt-4">
          <button
            type="button"
            data-testid="add-cloud-device-cancel"
            onClick={onClose}
            disabled={loading || remoteLoading}
            className="h-8 rounded-md px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
