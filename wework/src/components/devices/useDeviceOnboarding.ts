import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createDeviceApi } from '@/api/devices'
import { createHttpClient } from '@/api/http'
import type { RemoteDeviceConnectionStatus } from '@/extensions/remote-device-onboarding-contract'
import { useTranslation } from '@/hooks/useTranslation'
import {
  canUseForRemoteProjectCreation,
  isUsableDevice,
  isWeWorkExecutorVersionCompatible,
} from '@/lib/device-capabilities'
import { copyTextToClipboard } from '@/lib/clipboard'
import { track } from '@/telemetry/client'
import type { DeviceInfo, DockerRemoteDeviceCommandResponse } from '@/types/devices'

const IS_E2E = import.meta.env.VITE_WEWORK_E2E === 'true'
const POLL_INTERVAL_MS = IS_E2E ? 100 : 2000
const POLL_ATTEMPTS = IS_E2E ? 100 : 150
const REQUEST_TIMEOUT_MS = IS_E2E ? 1000 : 30_000

export interface DeviceOnboardingConnection {
  isConnected: boolean
  apiBaseUrl?: string
  token: string | null
  user?: { id: number } | null
}

export function deviceOnboardingScope(connection: DeviceOnboardingConnection): string {
  return JSON.stringify([
    connection.apiBaseUrl,
    connection.user?.id || connection.token,
    connection.isConnected,
  ])
}

export interface DeviceOnboardingProps {
  cloudConnection: DeviceOnboardingConnection
  hasCloudDevice?: boolean
  onCreated?: (devices: DeviceInfo[] | undefined, createdDeviceId: number) => void | Promise<void>
  onConnected: (devices: DeviceInfo[], device: DeviceInfo) => void | Promise<void>
  onCreatingChange?: (creating: boolean) => void
  onBusyChange?: (busy: boolean) => void
  onPendingChange?: (pending: boolean) => void
}

export function useDeviceOnboarding(props: DeviceOnboardingProps) {
  const { t } = useTranslation('common')
  const { cloudConnection, hasCloudDevice = false, onBusyChange, onPendingChange } = props
  const { apiBaseUrl, token, isConnected } = cloudConnection
  const api = useMemo(
    () =>
      createDeviceApi(
        createHttpClient({
          baseUrl: apiBaseUrl ?? '',
          getToken: () => token,
          redirectOnUnauthorized: false,
        })
      ),
    [apiBaseUrl, token]
  )
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const callbacks = useRef(props)
  useEffect(() => {
    callbacks.current = props
  })
  const [loading, setLoading] = useState(false)
  const [remoteLoading, setRemoteLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [remoteCommand, setRemoteCommand] = useState<DockerRemoteDeviceCommandResponse | null>(null)
  const [pending, setPending] = useState<
    { cloud: true; id: number } | { cloud: false; deviceId: string } | null
  >(null)
  const [status, setStatus] = useState<RemoteDeviceConnectionStatus>('idle')
  const [copied, setCopied] = useState(false)
  const [pollRevision, setPollRevision] = useState(0)
  const busy = loading || remoteLoading
  useEffect(() => {
    onBusyChange?.(busy)
  }, [busy, onBusyChange])
  useEffect(() => {
    onPendingChange?.(pending !== null)
  }, [onPendingChange, pending])

  useEffect(() => {
    if (!pending || !isConnected || !apiBaseUrl || !token) return
    let cancelled = false
    let controller: AbortController | null = null
    const poll = async () => {
      setStatus('waiting')
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
        if (attempt > 0) await new Promise(resolve => window.setTimeout(resolve, POLL_INTERVAL_MS))
        if (cancelled) return
        controller = new AbortController()
        let timeout: number | undefined
        try {
          const devices = await Promise.race([
            api.getAllDevices({ signal: controller.signal }),
            new Promise<never>((_, reject) => {
              timeout = window.setTimeout(() => {
                controller?.abort()
                reject(new Error('Device polling timed out'))
              }, REQUEST_TIMEOUT_MS)
            }),
          ])
          if (cancelled) return
          const device = devices.find(item =>
            pending.cloud ? item.id === pending.id : item.device_id === pending.deviceId
          )
          if (!device) continue
          if (!isUsableDevice(device)) {
            setStatus('connecting')
            continue
          }
          if (!isWeWorkExecutorVersionCompatible(device.executor_version)) {
            setStatus('version_mismatch')
            return
          }
          if (!canUseForRemoteProjectCreation(device)) continue
          if (pending.cloud) callbacks.current.onCreatingChange?.(false)
          setStatus('online')
          try {
            await callbacks.current.onConnected(devices, device)
          } catch (e) {
            if (cancelled) return
            setError(
              e instanceof Error ? e.message : t('workbench.device_onboarding_connection_failed')
            )
            setStatus('connection_failed')
          }
          return
        } catch {
          if (cancelled) return
        } finally {
          window.clearTimeout(timeout)
        }
      }
      if (!cancelled) setStatus('connection_failed')
    }
    void poll()
    return () => {
      cancelled = true
      controller?.abort()
    }
  }, [api, apiBaseUrl, isConnected, pending, pollRevision, t, token])

  const handleCreate = useCallback(async () => {
    if (busy || pending?.cloud || hasCloudDevice || !isConnected || !apiBaseUrl || !token) return
    setLoading(true)
    setError(null)
    setRemoteCommand(null)
    setCopied(false)
    setPending(null)
    setStatus('idle')
    try {
      const created = await api.createCloudDevice()
      if (!mounted.current) return
      setPending({ id: created.id, cloud: true })
      callbacks.current.onCreatingChange?.(true)
      track('feature_action_completed', { domain: 'cloud_device', action: 'create' })
      await callbacks.current.onCreated?.(undefined, created.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('workbench.add_device_cloud_create_failed'))
      track('operation_failed', { operation: 'cloud_device_action' })
    } finally {
      setLoading(false)
    }
  }, [api, apiBaseUrl, busy, hasCloudDevice, isConnected, pending, t, token])

  const handleCreateRemoteDocker = useCallback(async () => {
    if (busy || pending?.cloud || !isConnected || !apiBaseUrl || !token) return
    setRemoteLoading(true)
    setError(null)
    setCopied(false)
    setRemoteCommand(null)
    setPending(null)
    setStatus('idle')
    try {
      const command = await api.createDockerRemoteDeviceCommand()
      if (!mounted.current) return
      setRemoteCommand(command)
      setPending({ deviceId: command.device_id, cloud: false })
      track('feature_action_completed', { domain: 'cloud_device', action: 'create' })
    } catch (e) {
      setError(e instanceof Error ? e.message : t('workbench.remote_docker_generate_failed'))
      track('operation_failed', { operation: 'cloud_device_action' })
    } finally {
      setRemoteLoading(false)
    }
  }, [api, apiBaseUrl, busy, isConnected, pending, t, token])

  const handleCopyRemoteCommand = async () => {
    if (!remoteCommand) return
    try {
      await copyTextToClipboard(remoteCommand.command)
      setError(null)
      setCopied(true)
    } catch {
      setError(t('workbench.remote_docker_copy_failed'))
    }
  }

  return {
    loading,
    remoteLoading,
    error,
    remoteCommand,
    remoteStatus: status,
    copied,
    cloudCreated: Boolean(pending?.cloud),
    disconnected: !isConnected || !apiBaseUrl || !token,
    handleCreate,
    handleCreateRemoteDocker,
    handleCopyRemoteCommand,
    retryConnection: () => setPollRevision(value => value + 1),
  }
}
