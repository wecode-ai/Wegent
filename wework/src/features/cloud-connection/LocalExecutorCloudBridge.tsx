import { useEffect, useRef } from 'react'
import {
  issueWegentConnectorToken,
  listWegentInstalledConnectorApps,
} from '@/api/cloud/connectorApps'
import { notifyLocalPluginSkillsChanged } from '@/features/plugins/pluginTrial'
import { ensureLocalExecutorStarted, requestLocalExecutor } from '@/tauri/localExecutor'
import {
  applyLocalExecutorCloudConnection,
  type LocalExecutorCloudConnection,
} from './localExecutorCloudConnection'
import { isCloudConnectionUiAvailable } from './cloudConnectionAvailability'

let connectorSyncRevision = Date.now() * 1_000

function nextConnectorSyncRevision() {
  connectorSyncRevision = Math.max(connectorSyncRevision + 1, Date.now() * 1_000)
  return connectorSyncRevision
}

function connectorRefreshDelayMs(expiresInSeconds: number) {
  const leadSeconds = Math.min(60, Math.max(1, expiresInSeconds * 0.2))
  return Math.max(1_000, (expiresInSeconds - leadSeconds) * 1_000)
}

type LocalExecutorCloudBridgeProps = LocalExecutorCloudConnection

export function LocalExecutorCloudBridge({
  apiBaseUrl,
  backendUrl: configuredBackendUrl,
  isConnected,
  token,
}: LocalExecutorCloudBridgeProps) {
  const lastTargetRef = useRef<string | null>(null)

  useEffect(() => {
    const backendUrl = isConnected ? configuredBackendUrl : null
    const authToken = isConnected ? token : null
    const connected = Boolean(backendUrl && authToken)
    const target = connected ? `${backendUrl}\n${authToken}` : 'disconnected'
    if (lastTargetRef.current === target) return

    lastTargetRef.current = target
    void applyLocalExecutorCloudConnection({
      apiBaseUrl,
      backendUrl: configuredBackendUrl,
      isConnected,
      token,
    }).catch(error => {
      if (connected) {
        console.error('[CloudConnection] Failed to connect runtime task service to cloud', error)
        return
      }
      console.error('[CloudConnection] Failed to disconnect runtime task service from cloud', error)
    })
  }, [apiBaseUrl, configuredBackendUrl, isConnected, token])

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
      await ensureLocalExecutorStarted()
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
  }, [apiBaseUrl, isConnected, token])

  return null
}
