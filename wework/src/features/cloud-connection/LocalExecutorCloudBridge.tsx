import { useEffect, useRef, useState } from 'react'
import {
  issueWegentConnectorToken,
  listWegentInstalledConnectorApps,
} from '@/api/cloud/connectorApps'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { ensureLocalExecutorAvailable, requestLocalExecutor } from '@/desktop/localExecutor'
import {
  applyLocalExecutorCloudConnection,
  type LocalExecutorCloudConnection,
} from './localExecutorCloudConnection'
import { isCloudConnectionUiAvailable } from './cloudConnectionAvailability'
import {
  refreshLocalExecutorCloudConnectionStatus,
  setLocalExecutorCloudConnectionStatus,
} from './localExecutorCloudConnectionStatus'

const CONNECTOR_AUTHORIZATION_CHANGED_EVENT = 'wegent:connector-authorization-changed'

let connectorSyncRevision = Date.now() * 1_000

function nextConnectorSyncRevision() {
  connectorSyncRevision = Math.max(connectorSyncRevision + 1, Date.now() * 1_000)
  return connectorSyncRevision
}

function connectorRefreshDelayMs(expiresInSeconds: number) {
  const leadSeconds = Math.min(60, Math.max(1, expiresInSeconds * 0.2))
  return Math.max(1_000, (expiresInSeconds - leadSeconds) * 1_000)
}

function runtimeAuthRefreshDelayMs(expiresInSeconds: number) {
  const leadSeconds = Math.min(300, Math.max(1, expiresInSeconds * 0.2))
  return Math.max(1_000, (expiresInSeconds - leadSeconds) * 1_000)
}

type LocalExecutorCloudBridgeProps = LocalExecutorCloudConnection & {
  preferencesLoaded: boolean
}

export function LocalExecutorCloudBridge({
  apiBaseUrl,
  backendUrl: configuredBackendUrl,
  socketBaseUrl,
  isConnected,
  token,
  preferencesLoaded,
}: LocalExecutorCloudBridgeProps) {
  const connectionGenerationRef = useRef(0)
  const [connectorRefreshRevision, setConnectorRefreshRevision] = useState(0)

  useEffect(() => {
    const refresh = () => setConnectorRefreshRevision(revision => revision + 1)
    window.addEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, refresh)
    return () => window.removeEventListener(CONNECTOR_AUTHORIZATION_CHANGED_EVENT, refresh)
  }, [])

  useEffect(() => {
    const generation = connectionGenerationRef.current + 1
    connectionGenerationRef.current = generation
    if (!preferencesLoaded) {
      setLocalExecutorCloudConnectionStatus({ apiBaseUrl: apiBaseUrl || '', connected: false })
      return
    }
    const backendUrl = isConnected ? configuredBackendUrl : null
    const authToken = isConnected ? token : null
    const connected = Boolean(backendUrl && socketBaseUrl && authToken)
    let cancelled = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    let statusTimer: ReturnType<typeof setTimeout> | null = null
    const isCurrentConnectionAttempt = () =>
      !cancelled && connectionGenerationRef.current === generation

    const scheduleRefresh = (expiresInSeconds: number) => {
      if (!isCurrentConnectionAttempt()) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(
        () => void applyConnection(),
        runtimeAuthRefreshDelayMs(expiresInSeconds)
      )
    }

    const scheduleRetry = () => {
      if (!isCurrentConnectionAttempt() || !connected) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => void applyConnection(), 30_000)
    }

    const refreshConnectionStatus = async () => {
      if (!isCurrentConnectionAttempt() || !connected || !apiBaseUrl) return
      await refreshLocalExecutorCloudConnectionStatus(apiBaseUrl)
      if (!isCurrentConnectionAttempt()) return
      statusTimer = setTimeout(() => void refreshConnectionStatus(), 1_000)
    }

    const applyConnection = async () => {
      try {
        const result = await applyLocalExecutorCloudConnection(
          {
            apiBaseUrl,
            backendUrl: configuredBackendUrl,
            socketBaseUrl,
            isConnected,
            token,
          },
          { isCurrent: isCurrentConnectionAttempt }
        )
        if (!isCurrentConnectionAttempt()) return
        if (
          result.connected &&
          typeof result.runtimeAuthTokenExpiresIn === 'number' &&
          result.runtimeAuthTokenExpiresIn > 0
        ) {
          scheduleRefresh(result.runtimeAuthTokenExpiresIn)
        }
        if (result.connected && apiBaseUrl) {
          if (statusTimer) clearTimeout(statusTimer)
          void refreshConnectionStatus()
        } else {
          setLocalExecutorCloudConnectionStatus({ apiBaseUrl: apiBaseUrl || '', connected: false })
        }
      } catch (error) {
        if (!isCurrentConnectionAttempt()) return
        setLocalExecutorCloudConnectionStatus({
          apiBaseUrl: apiBaseUrl || '',
          connected: false,
        })
        if (connected) {
          console.error('[CloudConnection] Failed to connect runtime task service to cloud', error)
          scheduleRetry()
          return
        }
        console.error(
          '[CloudConnection] Failed to disconnect runtime task service from cloud',
          error
        )
      }
    }

    setLocalExecutorCloudConnectionStatus({
      apiBaseUrl: apiBaseUrl || '',
      connected: false,
    })
    void applyConnection()
    return () => {
      cancelled = true
      connectionGenerationRef.current += 1
      if (refreshTimer) clearTimeout(refreshTimer)
      if (statusTimer) clearTimeout(statusTimer)
      setLocalExecutorCloudConnectionStatus({ apiBaseUrl: apiBaseUrl || '', connected: false })
    }
  }, [apiBaseUrl, configuredBackendUrl, isConnected, preferencesLoaded, socketBaseUrl, token])

  useEffect(() => {
    if (!isCloudConnectionUiAvailable()) return

    const authToken = isConnected ? token : null
    const connected = Boolean(apiBaseUrl && authToken)
    let cancelled = false
    let refreshTimer: ReturnType<typeof setTimeout> | null = null

    const scheduleConnectorSync = (delayMs: number) => {
      if (cancelled) return
      if (refreshTimer) clearTimeout(refreshTimer)
      refreshTimer = setTimeout(() => void configureConnectors(), delayMs)
    }

    const configureConnectors = async () => {
      if (!apiBaseUrl || !authToken) return
      const syncRevision = nextConnectorSyncRevision()
      try {
        const connectorToken = await issueWegentConnectorToken(apiBaseUrl, authToken)
        if (cancelled) return
        await requestLocalExecutor('runtime.connectors.configure', {
          apiBaseUrl,
          connectorToken: connectorToken.access_token,
          expiresAtMs: Date.now() + connectorToken.expires_in * 1_000,
          syncRevision,
        })
        if (cancelled) return
        const installed = await listWegentInstalledConnectorApps(apiBaseUrl, authToken)
        if (cancelled) return
        await requestLocalExecutor('runtime.connectors.apps.sync', {
          apps: installed.apps
            .filter(app => app.enabled && app.callable)
            .map(app => ({
              slug: app.slug,
              name: app.runtime_name ?? app.slug,
              description: app.description ?? '',
              tools: app.tool_summaries ?? [],
            })),
        })
        notifyLocalPluginSkillsChanged()
        scheduleConnectorSync(connectorRefreshDelayMs(connectorToken.expires_in))
      } catch (error) {
        if (!cancelled) {
          console.error('[CloudConnection] Failed to synchronize connector authorization', error)
          scheduleConnectorSync(30_000)
        }
      }
    }

    const synchronizeConnectors = async () => {
      if (connected) {
        await configureConnectors()
        return
      }
      await ensureLocalExecutorAvailable()
      await requestLocalExecutor('runtime.connectors.clear', {
        syncRevision: nextConnectorSyncRevision(),
      }).catch(() => undefined)
      notifyLocalPluginSkillsChanged()
    }

    void synchronizeConnectors().catch(error => {
      if (!cancelled) {
        console.error('[CloudConnection] Failed to synchronize connector state', error)
      }
    })

    return () => {
      cancelled = true
      if (refreshTimer) clearTimeout(refreshTimer)
    }
  }, [apiBaseUrl, connectorRefreshRevision, isConnected, token])

  return null
}
