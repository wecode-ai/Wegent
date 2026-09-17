import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  installDownloadedWeworkUpdate,
  type WeworkUpdateChannel,
  type WeworkUpdateDownloadProgress,
  type WeworkUpdateInfo,
} from '@/lib/app-updater'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { useAppVersion } from '@/hooks/useAppVersion'
import { useTranslation } from '@/hooks/useTranslation'
import { track } from '@/telemetry/client'
import {
  clearPendingWeworkReleaseNotes,
  readPendingWeworkReleaseNotes,
  writePendingWeworkReleaseNotes,
  type WeworkInstalledReleaseNotes,
} from './app-release-notes'
import { createAppUpdateError, type AppUpdateError } from './app-update-error'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
  APP_UPDATE_AUTO_DOWNLOAD_KEY,
  APP_UPDATE_CHANNEL_KEY,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  APP_UPDATE_LAST_AUTO_CHECK_KEY,
  APP_UPDATE_SIMULATE_EVENT,
  APP_UPDATE_TIMER_INTERVAL_MS,
  AppUpdateContext,
  type AppUpdateContextValue,
  type AppUpdateStatus,
} from './app-update-context'

const SIMULATED_UPDATE_VERSION = 'debug-simulation'
const SIMULATED_DOWNLOAD_TOTAL_BYTES = 10_000_000
const SIMULATED_DOWNLOAD_STEP_BYTES = 500_000
const SIMULATED_DOWNLOAD_INTERVAL_MS = 250
const SIMULATED_RELEASE_NOTES = `## Changes

- Added a new version changelog announcement.
- Improved the Wework update experience.`

interface UpdateCheckResult {
  update: WeworkUpdateInfo | null
  error: AppUpdateError | null
}

function readUpdateChannel(): WeworkUpdateChannel {
  return window.localStorage.getItem(APP_UPDATE_CHANNEL_KEY) === 'beta' ? 'beta' : 'stable'
}

function readAutoUpdateEnabled(): boolean {
  return window.localStorage.getItem(APP_UPDATE_AUTO_DOWNLOAD_KEY) !== 'false'
}

function lastAutoCheckKey(channel: WeworkUpdateChannel): string {
  return channel === 'stable'
    ? APP_UPDATE_LAST_AUTO_CHECK_KEY
    : `${APP_UPDATE_LAST_AUTO_CHECK_KEY}:${channel}`
}

function readLastAutoCheckAt(channel: WeworkUpdateChannel): number {
  const raw = window.localStorage.getItem(lastAutoCheckKey(channel))
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function writeLastAutoCheckAt(channel: WeworkUpdateChannel, value: number) {
  window.localStorage.setItem(lastAutoCheckKey(channel), String(value))
}

function shouldAutoCheck(channel: WeworkUpdateChannel, now: number): boolean {
  return now - readLastAutoCheckAt(channel) >= APP_UPDATE_AUTO_CHECK_MIN_AGE_MS
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common')
  const appVersion = useAppVersion()
  const [updateChannel, setUpdateChannelState] = useState<WeworkUpdateChannel>(readUpdateChannel)
  const [autoUpdateEnabled, setAutoUpdateEnabledState] = useState(readAutoUpdateEnabled)
  const [availableUpdate, setAvailableUpdate] = useState<WeworkUpdateInfo | null>(null)
  const [pendingReleaseNotes, setPendingReleaseNotes] =
    useState<WeworkInstalledReleaseNotes | null>(readPendingWeworkReleaseNotes)
  const [status, setStatus] = useState<AppUpdateStatus>('idle')
  const [downloadProgress, setDownloadProgress] = useState<WeworkUpdateDownloadProgress | null>(
    null
  )
  const [error, setError] = useState<AppUpdateError | null>(null)
  const [restartConfirmationOpen, setRestartConfirmationOpen] = useState(false)
  const [downgradeConfirmationVersion, setDowngradeConfirmationVersion] = useState<string | null>(
    null
  )
  const [downloadedUpdateVersion, setDownloadedUpdateVersion] = useState<string | null>(null)
  const updateChannelRef = useRef(updateChannel)
  const autoUpdateEnabledRef = useRef(autoUpdateEnabled)
  const simulatedUpdatePendingRef = useRef(false)
  const activeCheckRef = useRef<{
    channel: WeworkUpdateChannel
    promise: Promise<UpdateCheckResult>
  } | null>(null)
  const activeDownloadRef = useRef<{
    version: string
    promise: Promise<void>
    progressListeners: Set<(progress: WeworkUpdateDownloadProgress) => void>
  } | null>(null)
  const simulationTimerRef = useRef<number | null>(null)
  const installedReleaseNotes =
    isElectronRuntime() && appVersion && pendingReleaseNotes?.version === appVersion
      ? pendingReleaseNotes
      : null

  const clearSimulationTimer = useCallback(() => {
    if (simulationTimerRef.current === null) return
    window.clearInterval(simulationTimerRef.current)
    simulationTimerRef.current = null
  }, [])

  const downloadUpdate = useCallback(
    (
      update: WeworkUpdateInfo,
      onProgress?: (progress: WeworkUpdateDownloadProgress) => void
    ): Promise<void> => {
      const activeDownload = activeDownloadRef.current
      if (activeDownload?.version === update.version) {
        if (!onProgress) return activeDownload.promise

        activeDownload.progressListeners.add(onProgress)
        return activeDownload.promise.finally(() => {
          activeDownload.progressListeners.delete(onProgress)
        })
      }

      const progressListeners = new Set<(progress: WeworkUpdateDownloadProgress) => void>()
      if (onProgress) progressListeners.add(onProgress)
      const promise = downloadPendingWeworkUpdate(progress => {
        progressListeners.forEach(listener => listener(progress))
      })
      activeDownloadRef.current = { version: update.version, promise, progressListeners }
      const clearActiveDownload = () => {
        if (activeDownloadRef.current?.promise === promise) {
          activeDownloadRef.current = null
        }
      }
      void promise.then(clearActiveDownload, clearActiveDownload)
      if (!onProgress) return promise

      return promise.finally(() => {
        progressListeners.delete(onProgress)
      })
    },
    []
  )

  const startBackgroundDownload = useCallback(
    (update: WeworkUpdateInfo, channel: WeworkUpdateChannel) => {
      if (update.kind === 'downgrade-to-stable') return
      setError(null)
      setStatus('downloading')
      setDownloadProgress({ downloadedBytes: 0, totalBytes: null, phase: 'preparing' })
      void downloadUpdate(update, setDownloadProgress)
        .then(() => {
          if (updateChannelRef.current === channel) {
            setDownloadedUpdateVersion(update.version)
            setStatus('available')
            setDownloadProgress(null)
          }
        })
        .catch(caughtError => {
          if (updateChannelRef.current === channel) {
            setStatus('error')
            setError(createAppUpdateError(caughtError, 'download'))
          }
        })
    },
    [downloadUpdate]
  )

  const isUpdateBusy = status === 'downloading' || status === 'installing'

  const resetDownloadedUpdate = useCallback(() => {
    setDownloadedUpdateVersion(null)
    setRestartConfirmationOpen(false)
    setDowngradeConfirmationVersion(null)
  }, [])

  const runCheck = useCallback(
    async ({
      silent,
      channel = updateChannel,
    }: {
      silent: boolean
      channel?: WeworkUpdateChannel
    }): Promise<WeworkUpdateInfo | null> => {
      if (isUpdateBusy) {
        return availableUpdate
      }

      const activeCheck = activeCheckRef.current
      if (activeCheck?.channel === channel) {
        if (!silent && channel === updateChannelRef.current) {
          setStatus('checking')
          setError(null)
        }

        return (await activeCheck.promise).update
      }
      if (activeCheck) {
        await activeCheck.promise
      }

      const promise = (async (): Promise<UpdateCheckResult> => {
        if (!silent && channel === updateChannelRef.current) {
          setStatus('checking')
          setError(null)
        }

        try {
          const update = await checkForWeworkUpdate(channel)
          if (channel !== updateChannelRef.current) {
            return { update, error: null }
          }

          setAvailableUpdate(update)
          resetDownloadedUpdate()

          if (update) {
            setStatus('available')
            setError(null)
            if (autoUpdateEnabledRef.current) {
              startBackgroundDownload(update, channel)
            }
          } else {
            setStatus('upToDate')
            setError(null)
          }

          return { update, error: null }
        } catch (caughtError) {
          const checkError = createAppUpdateError(caughtError, 'check')
          if (channel === updateChannelRef.current) {
            setAvailableUpdate(null)
            resetDownloadedUpdate()
            setStatus('error')
            setError(checkError)
          }
          return { update: null, error: checkError }
        }
      })()

      activeCheckRef.current = { channel, promise }
      try {
        return (await promise).update
      } finally {
        if (activeCheckRef.current?.promise === promise) {
          activeCheckRef.current = null
        }
      }
    },
    [availableUpdate, isUpdateBusy, resetDownloadedUpdate, startBackgroundDownload, updateChannel]
  )

  const checkNow = useCallback(() => runCheck({ silent: false }), [runCheck])

  const startSimulatedDownload = useCallback(() => {
    setStatus('downloading')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: SIMULATED_DOWNLOAD_TOTAL_BYTES })
    setError(null)

    let downloadedBytes = 0
    simulationTimerRef.current = window.setInterval(() => {
      downloadedBytes = Math.min(
        downloadedBytes + SIMULATED_DOWNLOAD_STEP_BYTES,
        SIMULATED_DOWNLOAD_TOTAL_BYTES
      )
      setDownloadProgress({ downloadedBytes, totalBytes: SIMULATED_DOWNLOAD_TOTAL_BYTES })

      if (downloadedBytes === SIMULATED_DOWNLOAD_TOTAL_BYTES) {
        clearSimulationTimer()
        setDownloadedUpdateVersion(SIMULATED_UPDATE_VERSION)
        setDownloadProgress(null)
        setStatus('available')
        setRestartConfirmationOpen(true)
      }
    }, SIMULATED_DOWNLOAD_INTERVAL_MS)
  }, [clearSimulationTimer])

  const confirmInstallUpdate = useCallback(async () => {
    if (
      !availableUpdate ||
      downloadedUpdateVersion !== availableUpdate.version ||
      status === 'installing'
    )
      return
    setRestartConfirmationOpen(false)
    track('app_update_install_started', {})

    if (simulatedUpdatePendingRef.current && availableUpdate.version === SIMULATED_UPDATE_VERSION) {
      const releaseNotes = {
        version: appVersion ?? __WEWORK_APP_VERSION__,
        body: SIMULATED_RELEASE_NOTES,
      }
      simulatedUpdatePendingRef.current = false
      setDownloadedUpdateVersion(null)
      setAvailableUpdate(null)
      writePendingWeworkReleaseNotes(releaseNotes)
      setPendingReleaseNotes(releaseNotes)
      setStatus('upToDate')
      return
    }

    const releaseNotesBody = availableUpdate.body?.trim()
    if (releaseNotesBody) {
      writePendingWeworkReleaseNotes({
        version: availableUpdate.version,
        body: releaseNotesBody,
      })
    } else {
      clearPendingWeworkReleaseNotes()
    }

    setStatus('installing')
    setDownloadProgress(null)
    setError(null)

    try {
      await installDownloadedWeworkUpdate()
    } catch (caughtError) {
      const installError = createAppUpdateError(caughtError, 'install')
      clearPendingWeworkReleaseNotes(availableUpdate.version)
      setDownloadedUpdateVersion(null)
      setDownloadProgress(null)
      setError(installError)

      try {
        const refreshedUpdate = await checkForWeworkUpdate(updateChannel)
        setAvailableUpdate(refreshedUpdate)
        setStatus(refreshedUpdate ? 'available' : 'error')
      } catch {
        setStatus('error')
      }
    }
  }, [appVersion, availableUpdate, downloadedUpdateVersion, status, updateChannel])

  const downloadAndConfirmUpdate = useCallback(async () => {
    if (!availableUpdate || status === 'installing') return
    setDowngradeConfirmationVersion(null)
    if (downloadedUpdateVersion === availableUpdate.version) {
      setRestartConfirmationOpen(true)
      return
    }
    if (simulatedUpdatePendingRef.current && availableUpdate.version === SIMULATED_UPDATE_VERSION) {
      startSimulatedDownload()
      return
    }

    setStatus('downloading')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: null, phase: 'preparing' })
    setError(null)

    try {
      await downloadUpdate(availableUpdate, setDownloadProgress)
      setDownloadedUpdateVersion(availableUpdate.version)
      setDownloadProgress(null)
      setStatus('available')
      setRestartConfirmationOpen(true)
    } catch (caughtError) {
      setDownloadProgress(null)
      setStatus('error')
      setError(createAppUpdateError(caughtError, 'download'))
    }
  }, [availableUpdate, downloadedUpdateVersion, downloadUpdate, startSimulatedDownload, status])

  const installUpdate = useCallback(async () => {
    if (!availableUpdate || status === 'installing') return
    if (
      availableUpdate.kind === 'downgrade-to-stable' &&
      downloadedUpdateVersion !== availableUpdate.version
    ) {
      setDowngradeConfirmationVersion(availableUpdate.version)
      return
    }
    await downloadAndConfirmUpdate()
  }, [availableUpdate, downloadedUpdateVersion, downloadAndConfirmUpdate, status])

  const dismissInstalledReleaseNotes = useCallback(() => {
    if (installedReleaseNotes) {
      clearPendingWeworkReleaseNotes(installedReleaseNotes.version)
    }
    setPendingReleaseNotes(null)
  }, [installedReleaseNotes])

  const setAutoUpdateEnabled = useCallback(
    (enabled: boolean) => {
      window.localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, String(enabled))
      autoUpdateEnabledRef.current = enabled
      setAutoUpdateEnabledState(enabled)

      if (enabled && availableUpdate && !isUpdateBusy) {
        startBackgroundDownload(availableUpdate, updateChannel)
      }
    },
    [availableUpdate, isUpdateBusy, startBackgroundDownload, updateChannel]
  )

  const setUpdateChannel = useCallback(
    async (channel: WeworkUpdateChannel) => {
      if (channel === updateChannel || isUpdateBusy) return

      window.localStorage.setItem(APP_UPDATE_CHANNEL_KEY, channel)
      updateChannelRef.current = channel
      setUpdateChannelState(channel)
      setAvailableUpdate(null)
      resetDownloadedUpdate()
      setDownloadProgress(null)
      setError(null)
      await runCheck({ silent: false, channel })
    },
    [isUpdateBusy, resetDownloadedUpdate, runCheck, updateChannel]
  )

  const simulateUpdate = useCallback(() => {
    clearSimulationTimer()
    simulatedUpdatePendingRef.current = true
    resetDownloadedUpdate()
    setAvailableUpdate({
      currentVersion: appVersion ?? __WEWORK_APP_VERSION__,
      version: SIMULATED_UPDATE_VERSION,
      kind: 'upgrade-stable',
      body: SIMULATED_RELEASE_NOTES,
    })
    setStatus('available')
    setDownloadProgress(null)
    setError(null)
  }, [appVersion, clearSimulationTimer, resetDownloadedUpdate])

  useEffect(() => {
    window.addEventListener(APP_UPDATE_SIMULATE_EVENT, simulateUpdate)
    return () => window.removeEventListener(APP_UPDATE_SIMULATE_EVENT, simulateUpdate)
  }, [simulateUpdate])

  useEffect(() => clearSimulationTimer, [clearSimulationTimer])

  useEffect(() => {
    if (!isElectronRuntime() || !appVersion) return

    if (pendingReleaseNotes && pendingReleaseNotes.version !== appVersion) {
      clearPendingWeworkReleaseNotes()
    }
  }, [appVersion, pendingReleaseNotes])

  useEffect(() => {
    if (!isElectronRuntime()) return

    const maybeAutoCheck = () => {
      if (availableUpdate || isUpdateBusy) return

      const now = Date.now()
      if (!shouldAutoCheck(updateChannel, now)) return

      writeLastAutoCheckAt(updateChannel, now)
      void runCheck({ silent: true })
    }

    const initialTimer = window.setTimeout(maybeAutoCheck, APP_UPDATE_INITIAL_CHECK_DELAY_MS)
    const intervalTimer = window.setInterval(maybeAutoCheck, APP_UPDATE_TIMER_INTERVAL_MS)

    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(intervalTimer)
    }
  }, [availableUpdate, isUpdateBusy, runCheck, updateChannel])

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      currentVersion: appVersion,
      updateChannel,
      autoUpdateEnabled,
      availableUpdate,
      isUpdateReady: Boolean(
        availableUpdate && downloadedUpdateVersion === availableUpdate.version
      ),
      installedReleaseNotes,
      status,
      downloadProgress,
      error,
      checkNow,
      installUpdate,
      dismissInstalledReleaseNotes,
      setAutoUpdateEnabled,
      setUpdateChannel,
    }),
    [
      appVersion,
      availableUpdate,
      autoUpdateEnabled,
      checkNow,
      dismissInstalledReleaseNotes,
      downloadProgress,
      error,
      installUpdate,
      downloadedUpdateVersion,
      installedReleaseNotes,
      setUpdateChannel,
      setAutoUpdateEnabled,
      status,
      updateChannel,
    ]
  )

  return (
    <AppUpdateContext.Provider value={value}>
      {children}
      <ConfirmDialog
        open={Boolean(
          downgradeConfirmationVersion && downgradeConfirmationVersion === availableUpdate?.version
        )}
        title={t('workbench.app_update_downgrade_confirm_title', {
          version: availableUpdate?.version,
        })}
        description={t('workbench.app_update_downgrade_confirm_description', {
          currentVersion: availableUpdate?.currentVersion,
          version: availableUpdate?.version,
        })}
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={t('workbench.app_update_downgrade_confirm_action')}
        confirmTestId="app-update-downgrade-confirm"
        onClose={() => setDowngradeConfirmationVersion(null)}
        onConfirm={() => {
          void downloadAndConfirmUpdate()
        }}
      />
      <ConfirmDialog
        open={restartConfirmationOpen}
        title={t(
          availableUpdate?.kind === 'downgrade-to-stable'
            ? 'workbench.app_update_restart_return_title'
            : 'workbench.app_update_restart_confirm_title',
          { version: availableUpdate?.version }
        )}
        description={t(
          availableUpdate?.kind === 'downgrade-to-stable'
            ? 'workbench.app_update_restart_return_description'
            : 'workbench.app_update_restart_confirm_description'
        )}
        cancelLabel={t('workbench.app_update_later')}
        confirmLabel={t(
          availableUpdate?.kind === 'downgrade-to-stable'
            ? 'workbench.app_update_restart_return_action'
            : 'workbench.app_update_restart_confirm_action'
        )}
        confirmTestId="app-update-restart-confirm"
        onClose={() => setRestartConfirmationOpen(false)}
        onConfirm={() => {
          void confirmInstallUpdate()
        }}
      />
    </AppUpdateContext.Provider>
  )
}
