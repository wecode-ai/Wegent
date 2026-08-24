// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Check, Copy, Loader2, Server } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { deviceApis } from '@/apis/devices'
import { useTranslation } from '@/hooks/useTranslation'
import { Button } from '@/components/ui/button'
import { createDockerRemoteDeviceCommand } from '@wecode/api/remote-devices'
import type { DockerRemoteDeviceCommandResponse } from '@wecode/types/remote-devices'

interface RemoteDockerDeviceCreateSectionProps {
  onDeviceCreated: () => void
  onDeviceDetected?: () => void
}

const REMOTE_DEVICE_POLL_INTERVAL_MS = 2000
const REMOTE_DEVICE_POLL_ATTEMPTS = 150

type ConnectionStatus =
  | 'idle'
  | 'waiting'
  | 'connecting'
  | 'online'
  | 'version_mismatch'
  | 'connection_failed'

export function RemoteDockerDeviceCreateSection({
  onDeviceCreated,
  onDeviceDetected,
}: RemoteDockerDeviceCreateSectionProps) {
  const { t } = useTranslation('devices')
  const [command, setCommand] = useState<DockerRemoteDeviceCommandResponse | null>(null)
  const [status, setStatus] = useState<ConnectionStatus>('idle')
  const [loading, setLoading] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!command) return

    let cancelled = false
    const pollForDevice = async () => {
      setStatus('waiting')
      for (let attempt = 0; attempt < REMOTE_DEVICE_POLL_ATTEMPTS; attempt += 1) {
        await new Promise(resolve => window.setTimeout(resolve, REMOTE_DEVICE_POLL_INTERVAL_MS))
        if (cancelled) return
        try {
          const response = await deviceApis.getAllDevices()
          const device = response.items.find(item => item.device_id === command.device_id)
          if (!device) continue
          if (device.status !== 'online') {
            setStatus('connecting')
            continue
          }
          const versionMismatch = device.executor_version === 'dev' || device.update_available
          setStatus(versionMismatch ? 'version_mismatch' : 'online')
          onDeviceDetected?.()
          if (versionMismatch) return
          onDeviceCreated()
          return
        } catch {
          // Keep polling while the API connection recovers.
        }
      }
      if (!cancelled) setStatus('connection_failed')
    }

    void pollForDevice()
    return () => {
      cancelled = true
    }
  }, [command, onDeviceCreated, onDeviceDetected])

  const generateCommand = useCallback(async () => {
    setLoading(true)
    setCopied(false)
    setError(null)
    setStatus('idle')
    try {
      setCommand(await createDockerRemoteDeviceCommand())
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('remote_generate_failed'))
    } finally {
      setLoading(false)
    }
  }, [t])

  const copyCommand = useCallback(async () => {
    if (!command) return
    try {
      await navigator.clipboard.writeText(command.command)
      setCopied(true)
    } catch {
      setError(t('copy_failed'))
    }
  }, [command, t])

  return (
    <div className="mx-auto max-w-2xl space-y-4 rounded-lg border border-border bg-base p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-surface-secondary text-text-secondary">
          <Server className="h-5 w-5" />
        </div>
        <div>
          <h3 className="font-medium text-text-primary">{t('remote_device')}</h3>
          <p className="mt-1 text-sm text-text-secondary">{t('remote_device_description')}</p>
        </div>
      </div>

      <div className="rounded-md bg-surface-secondary px-3 py-2 text-sm text-text-secondary">
        {t('remote_network_notice')}
      </div>

      {error && (
        <div
          data-testid="remote-device-error"
          className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          {error}
        </div>
      )}

      <Button
        variant="primary"
        data-testid="remote-device-generate-command"
        onClick={generateCommand}
        disabled={loading}
      >
        {loading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
        {loading ? t('remote_generating') : t('remote_generate_command')}
      </Button>

      {command && (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center justify-between border-b border-border bg-surface-secondary px-3 py-2">
            <div className="min-w-0 text-sm text-text-secondary">
              <div className="truncate">
                {t('remote_image')}: {command.image}
              </div>
              <div data-testid="remote-device-backend-url" className="mt-1 truncate">
                {t('remote_backend_url')}: {command.env.WEGENT_BACKEND_URL}
              </div>
              <div data-testid="remote-device-socket-url" className="mt-1 truncate">
                {t('remote_socket_url')}: {command.env.WEGENT_SOCKET_URL}
              </div>
              <div data-testid="remote-device-connection-status" className="mt-1">
                {t(`remote_status_${status}`)}
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={copyCommand}
              data-testid="remote-device-copy-command"
            >
              {copied ? <Check className="mr-1.5 h-4 w-4" /> : <Copy className="mr-1.5 h-4 w-4" />}
              {copied ? t('copied') : t('copy_command')}
            </Button>
          </div>
          <pre
            data-testid="remote-device-command"
            className="max-h-80 overflow-auto whitespace-pre p-3 text-xs text-text-primary"
          >
            {command.command}
          </pre>
        </div>
      )}
    </div>
  )
}
