import { Check, Cloud, Copy, Plus, Server, X } from 'lucide-react'
import { useCallback, useState } from 'react'
import { createHttpClient } from '@/api/http'
import { createDeviceApi } from '@/api/devices'
import type { DockerRemoteDeviceCommandResponse } from '@/types/devices'

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
  onCreated: () => void
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
  const [loading, setLoading] = useState(false)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remoteCommand, setRemoteCommand] = useState<DockerRemoteDeviceCommandResponse | null>(null)
  const [copied, setCopied] = useState(false)

  const handleCreate = useCallback(async () => {
    if (hasCloudDevice) {
      setError('每个用户只能创建一个云设备。')
      return
    }
    setLoading(true)
    setError(null)
    try {
      await createCloudDeviceApi(cloudConnection).createCloudDevice()
      onCreatingChange?.(true)
      onClose()
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败，请重试')
      onCreatingChange?.(false)
    } finally {
      setLoading(false)
    }
  }, [cloudConnection, hasCloudDevice, onClose, onCreated, onCreatingChange])

  const handleCreateRemoteDocker = useCallback(async () => {
    setRemoteLoading(true)
    setError(null)
    setCopied(false)
    try {
      const result = await createCloudDeviceApi(cloudConnection).createDockerRemoteDeviceCommand({
        client_origin: window.location.origin,
      })
      setRemoteCommand(result)
      onCreated()
    } catch (e) {
      setError(e instanceof Error ? e.message : '生成远程设备命令失败，请重试')
    } finally {
      setRemoteLoading(false)
    }
  }, [cloudConnection, onCreated])

  const handleCopyRemoteCommand = useCallback(async () => {
    if (!remoteCommand) return
    await navigator.clipboard?.writeText(remoteCommand.command)
    setCopied(true)
  }, [remoteCommand])

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
        className="max-h-[calc(100vh-32px)] w-full max-w-[760px] overflow-hidden rounded-lg border border-border bg-popover shadow-[0_18px_50px_rgba(0,0,0,0.28)]"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 px-5 pt-5">
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-surface text-text-secondary">
            <Plus className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-text-primary">添加设备</h2>
            <p className="mt-1.5 text-xs leading-5 text-text-secondary">
              选择要添加的设备类型。云设备由 Wegent 创建，远程 Docker 设备由你自行运行。
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
                  <h3 className="text-sm font-semibold text-text-primary">云设备</h3>
                  <p className="mt-1 text-xs leading-5 text-text-secondary">
                    {hasCloudDevice
                      ? '每个用户只能创建一个云设备。你仍可添加远程 Docker 设备。'
                      : '创建一台新的云设备，Wegent 负责创建、初始化和生命周期管理，通常需要 2-3 分钟。'}
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="add-cloud-device-confirm"
                  onClick={handleCreate}
                  disabled={hasCloudDevice || loading || remoteLoading}
                  className="h-8 shrink-0 rounded-md bg-text-primary px-3 text-sm font-medium text-background hover:bg-text-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {hasCloudDevice ? '已创建' : loading ? '创建中...' : '创建云设备'}
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
                  <h3 className="text-sm font-semibold text-text-primary">远程 Docker 设备</h3>
                  <p className="mt-1 text-xs leading-5 text-text-secondary">
                    根据当前系统环境生成 Docker 启动命令。容器由你自行启动、停止和删除。
                  </p>
                </div>
                <button
                  type="button"
                  data-testid="add-remote-docker-button"
                  onClick={handleCreateRemoteDocker}
                  disabled={loading || remoteLoading}
                  className="h-8 shrink-0 rounded-md bg-surface px-3 text-sm text-text-primary hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {remoteLoading ? '生成中...' : '生成命令'}
                </button>
              </div>

              {remoteCommand && (
                <div className="mt-3 overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950">
                  <div className="flex h-8 items-center justify-between border-b border-zinc-800 px-3">
                    <span className="text-xs font-semibold text-zinc-300">Docker 命令</span>
                    <button
                      type="button"
                      data-testid="copy-remote-docker-command"
                      onClick={handleCopyRemoteCommand}
                      className="inline-flex h-6 items-center gap-1 rounded px-2 text-xs text-zinc-300 hover:bg-zinc-800 hover:text-white"
                    >
                      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                      {copied ? '已复制' : '复制'}
                    </button>
                  </div>
                  <pre
                    data-testid="remote-docker-command"
                    className="max-h-[360px] overflow-auto whitespace-pre p-3 font-mono text-xs leading-5 text-green-300"
                  >
                    {remoteCommand.command}
                  </pre>
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
            取消
          </button>
        </div>
      </div>
    </div>
  )
}
