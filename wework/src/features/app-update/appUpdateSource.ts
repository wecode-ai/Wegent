import {
  checkForWeworkUpdate,
  downloadPendingWeworkUpdate,
  installDownloadedWeworkUpdate,
  type WeworkUpdateChannel,
  type WeworkUpdateDownloadProgress,
  type WeworkUpdateInfo,
} from '@/lib/app-updater'
import {
  createWeworkUpdateFailureError,
  WeworkUpdateRetryConfirmationError,
} from '@/lib/app-updater-errors'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { track } from '@/telemetry/client'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
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
  APP_UPDATE_TIMER_INTERVAL_MS,
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

export function createAppUpdateSource() {
  let appVersion: string | null = null
  const listeners = new Set<() => void>()
  let running = false
  let observation = 0
  let initialTimer: ReturnType<typeof setTimeout> | undefined
  let autoTimer: ReturnType<typeof setInterval> | undefined
  let installTimer: ReturnType<typeof setInterval> | undefined
  let installObservation = 0
  let isUpdateBusy = false
  let updateChannel: WeworkUpdateChannel = readUpdateChannel()
  function setUpdateChannelState(next: WeworkUpdateChannel): void {
    updateChannel = next
    publish()
  }
  let autoUpdateEnabled: boolean = readAutoUpdateEnabled()
  function setAutoUpdateEnabledState(next: boolean): void {
    autoUpdateEnabled = next
    publish()
  }
  let availableUpdate: WeworkUpdateInfo | null = null
  function setAvailableUpdate(next: WeworkUpdateInfo | null): void {
    availableUpdate = next
    publish()
  }
  let pendingReleaseNotes: WeworkInstalledReleaseNotes | null = readPendingWeworkReleaseNotes()
  function setPendingReleaseNotes(next: WeworkInstalledReleaseNotes | null): void {
    pendingReleaseNotes = next
    publish()
  }
  let status: AppUpdateStatus = 'idle'
  function setStatus(next: AppUpdateStatus): void {
    status = next
    publish()
  }
  let downloadProgress: WeworkUpdateDownloadProgress | null = null
  function setDownloadProgress(next: WeworkUpdateDownloadProgress | null): void {
    downloadProgress = next
    publish()
  }
  let error: AppUpdateError | null = null
  function setError(next: AppUpdateError | null): void {
    error = next
    publish()
  }
  let restartConfirmationOpen: boolean = false
  function setRestartConfirmationOpen(next: boolean): void {
    restartConfirmationOpen = next
    publish()
  }
  let retryUpdate: WeworkUpdateInfo | null = null
  function setRetryUpdate(next: WeworkUpdateInfo | null): void {
    retryUpdate = next
    publish()
  }
  let downloadedUpdateVersion: string | null = null
  function setDownloadedUpdateVersion(next: string | null): void {
    downloadedUpdateVersion = next
    publish()
  }
  const simulatedUpdatePendingRef = { current: false }
  const activeCheckRef: {
    current: { channel: WeworkUpdateChannel; promise: Promise<UpdateCheckResult> } | null
  } = { current: null }
  const activeDownloadRef: {
    current: {
      promise: Promise<WeworkUpdateInfo | null>
      progressListeners: Set<(progress: WeworkUpdateDownloadProgress) => void>
    } | null
  } = { current: null }
  const simulationTimerRef: { current: number | null } = { current: null }
  const clearSimulationTimer = () => {
    if (simulationTimerRef.current === null) return
    window.clearInterval(simulationTimerRef.current)
    simulationTimerRef.current = null
  }

  const downloadUpdate = (
    onProgress?: (progress: WeworkUpdateDownloadProgress) => void,
    retryToken?: string
  ): Promise<WeworkUpdateInfo | null> => {
    const activeDownload = activeDownloadRef.current
    if (activeDownload) {
      if (!onProgress) return activeDownload.promise

      activeDownload.progressListeners.add(onProgress)
      return activeDownload.promise.finally(() => {
        activeDownload.progressListeners.delete(onProgress)
      })
    }

    const progressListeners = new Set<(progress: WeworkUpdateDownloadProgress) => void>()
    if (onProgress) progressListeners.add(onProgress)
    const reportProgress = (progress: WeworkUpdateDownloadProgress) => {
      if (progress.update !== undefined) setAvailableUpdate(progress.update)
      progressListeners.forEach(listener => listener(progress))
    }
    const promise = retryToken
      ? downloadPendingWeworkUpdate(reportProgress, retryToken)
      : downloadPendingWeworkUpdate(reportProgress)
    activeDownloadRef.current = { promise, progressListeners }
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
  }

  const markUpdateReadyToInstall = (version: string) => {
    setRetryUpdate(null)
    setDownloadedUpdateVersion(version)
    setDownloadProgress(null)
    setStatus('available')
    setRestartConfirmationOpen(true)
  }

  const requestRetryConfirmation = (update: WeworkUpdateInfo) => {
    setAvailableUpdate(update)
    setDownloadedUpdateVersion(null)
    setRestartConfirmationOpen(false)
    setRetryUpdate(update.retryConfirmation ? update : null)
    setDownloadProgress(null)
    setStatus('available')
    setError(null)
  }

  const handleDownloadFailure = (caughtError: unknown) => {
    if (caughtError instanceof WeworkUpdateRetryConfirmationError) {
      requestRetryConfirmation(caughtError.update)
      return
    }
    setDownloadProgress(null)
    setStatus('error')
    setError(createAppUpdateError(caughtError, 'download'))
  }

  const applyDownloadResult = (update: WeworkUpdateInfo | null) => {
    if (update?.retryConfirmation && !update.readyToInstall) {
      requestRetryConfirmation(update)
      return
    }
    setAvailableUpdate(update)
    setError(null)
    if (update) {
      markUpdateReadyToInstall(update.version)
    } else {
      setDownloadedUpdateVersion(null)
      setRestartConfirmationOpen(false)
      setRetryUpdate(null)
      setDownloadProgress(null)
      setStatus('upToDate')
    }
  }

  const startBackgroundDownload = (channel: WeworkUpdateChannel) => {
    setError(null)
    setStatus('downloading')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: null, phase: 'preparing' })
    void downloadUpdate(setDownloadProgress)
      .then(update => {
        if (updateChannel === channel) {
          applyDownloadResult(update)
        }
      })
      .catch(caughtError => {
        if (updateChannel === channel) {
          handleDownloadFailure(caughtError)
        }
      })
  }

  const resetDownloadedUpdate = () => {
    setDownloadedUpdateVersion(null)
    setRestartConfirmationOpen(false)
    setRetryUpdate(null)
  }

  const runCheck = async ({
    silent,
    channel = updateChannel,
  }: {
    silent: boolean
    channel?: WeworkUpdateChannel
  }): Promise<WeworkUpdateInfo | null> => {
    if (isUpdateBusy || activeDownloadRef.current) {
      return availableUpdate
    }

    const activeCheck = activeCheckRef.current
    if (activeCheck?.channel === channel) {
      if (!silent && channel === updateChannel) {
        setStatus('checking')
        setError(null)
      }

      const result = await activeCheck.promise
      if (!silent && channel === updateChannel) {
        if (result.error) {
          setStatus('error')
          setError(result.error)
        } else if (!result.update) {
          setStatus('upToDate')
          setError(null)
        }
      }
      return result.update
    }
    if (activeCheck) {
      await activeCheck.promise
    }

    const previousUpdate = availableUpdate
    const promise = (async (): Promise<UpdateCheckResult> => {
      setRetryUpdate(null)
      if (!silent && channel === updateChannel) {
        setStatus('checking')
        setError(null)
      }

      try {
        const update = await checkForWeworkUpdate(channel)
        // A successful foreground check also satisfies the scheduled check for this channel.
        if (!silent) writeLastAutoCheckAt(channel, Date.now())
        if (channel !== updateChannel) {
          return { update, error: null }
        }

        setAvailableUpdate(update)
        if (update?.readyToInstall && downloadedUpdateVersion === update.version) {
          setStatus('available')
          setError(null)
          return { update, error: null }
        }
        resetDownloadedUpdate()

        if (update) {
          setStatus('available')
          setError(null)
          if (update.retryConfirmation) {
            if (!silent || autoUpdateEnabled) requestRetryConfirmation(update)
          } else if (autoUpdateEnabled) {
            startBackgroundDownload(channel)
          }
        } else if (!silent || previousUpdate) {
          setStatus('upToDate')
          setError(null)
        }

        return { update, error: null }
      } catch (caughtError) {
        const checkError = createAppUpdateError(caughtError, 'check')
        if (!silent && channel === updateChannel) {
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
  }

  const checkNow = () => runCheck({ silent: false })

  const startSimulatedDownload = () => {
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
        markUpdateReadyToInstall(SIMULATED_UPDATE_VERSION)
      }
    }, SIMULATED_DOWNLOAD_INTERVAL_MS)
  }

  const confirmInstallUpdate = async () => {
    if (!availableUpdate || status === 'installing') return
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
  }

  const installUpdate = async () => {
    if (!availableUpdate || status === 'installing') return
    if (downloadedUpdateVersion === availableUpdate.version) {
      setRestartConfirmationOpen(true)
      return
    }
    if (availableUpdate.retryConfirmation) {
      requestRetryConfirmation(availableUpdate)
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
      const update = await downloadUpdate(setDownloadProgress)
      applyDownloadResult(update)
    } catch (caughtError) {
      handleDownloadFailure(caughtError)
    }
  }

  const confirmRetryUpdate = async () => {
    const token = retryUpdate?.retryConfirmation?.token
    if (
      !token ||
      token !== availableUpdate?.retryConfirmation?.token ||
      isUpdateBusy ||
      activeCheckRef.current
    )
      return
    setRetryUpdate(null)
    setStatus('downloading')
    setError(null)
    setDownloadProgress({ downloadedBytes: 0, totalBytes: null, phase: 'preparing' })
    try {
      applyDownloadResult(await downloadUpdate(setDownloadProgress, token))
    } catch (caughtError) {
      handleDownloadFailure(caughtError)
    }
  }

  const dismissInstalledReleaseNotes = () => {
    const notes = installedNotes()
    if (notes) clearPendingWeworkReleaseNotes(notes.version)
    setPendingReleaseNotes(null)
  }

  const setAutoUpdateEnabled = (enabled: boolean) => {
    window.localStorage.setItem(APP_UPDATE_AUTO_DOWNLOAD_KEY, String(enabled))
    setAutoUpdateEnabledState(enabled)

    if (enabled && availableUpdate && !isUpdateBusy && !downloadedUpdateVersion) {
      if (availableUpdate.retryConfirmation) requestRetryConfirmation(availableUpdate)
      else startBackgroundDownload(updateChannel)
    }
  }

  const setUpdateChannel = async (channel: WeworkUpdateChannel) => {
    if (channel === updateChannel || isUpdateBusy || activeDownloadRef.current) return

    window.localStorage.setItem(APP_UPDATE_CHANNEL_KEY, channel)
    setUpdateChannelState(channel)
    setAvailableUpdate(null)
    resetDownloadedUpdate()
    setDownloadProgress(null)
    setError(null)
    await runCheck({ silent: false, channel })
  }

  const simulateUpdate = () => {
    clearSimulationTimer()
    simulatedUpdatePendingRef.current = true
    resetDownloadedUpdate()
    setAvailableUpdate({
      currentVersion: appVersion ?? __WEWORK_APP_VERSION__,
      readyToInstall: false,
      version: SIMULATED_UPDATE_VERSION,
      body: SIMULATED_RELEASE_NOTES,
    })
    setStatus('available')
    setDownloadProgress(null)
    setError(null)
  }

  function installedNotes() {
    return isElectronRuntime() && appVersion && pendingReleaseNotes?.version === appVersion
      ? pendingReleaseNotes
      : null
  }
  function readSnapshot() {
    const value: AppUpdateContextValue = {
      updateChannel,
      autoUpdateEnabled,
      availableUpdate,
      installedReleaseNotes: installedNotes(),
      status,
      downloadProgress,
      error,
      checkNow,
      installUpdate,
      dismissInstalledReleaseNotes,
      setAutoUpdateEnabled,
      setUpdateChannel,
    }
    return { value, restartConfirmationOpen, retryUpdate }
  }
  let snapshot = readSnapshot()
  function reconcileInstallMonitor() {
    if (!running || status !== 'installing') {
      if (installTimer !== undefined) {
        installObservation += 1
        clearInterval(installTimer)
      }
      installTimer = undefined
      return
    }
    if (installTimer !== undefined) return
    const monitor = ++installObservation
    let reading = false
    installTimer = setInterval(() => {
      if (reading) return
      reading = true
      void invokeDesktopHost<WeworkUpdateDownloadProgress>('appUpdate.downloadProgress')
        .then(progress => {
          if (
            monitor !== installObservation ||
            !running ||
            status !== 'installing' ||
            progress?.phase !== 'failed'
          )
            return
          setError(
            createAppUpdateError(createWeworkUpdateFailureError(progress.failure), 'install')
          )
          setStatus('error')
          setDownloadedUpdateVersion(null)
        })
        .catch(() => undefined)
        .finally(() => {
          reading = false
        })
    }, 250)
  }
  function publish(): void {
    isUpdateBusy = status === 'downloading' || status === 'installing'
    snapshot = readSnapshot()
    for (const listener of listeners) listener()
    reconcileInstallMonitor()
  }
  function maybeAutoCheck() {
    if (!running || downloadedUpdateVersion || isUpdateBusy || activeCheckRef.current) return
    const now = Date.now()
    if (!shouldAutoCheck(updateChannel, now)) return
    writeLastAutoCheckAt(updateChannel, now)
    void runCheck({ silent: true })
  }
  return {
    getSnapshot: () => snapshot,
    simulateUpdate,
    closeConfirmation() {
      setRestartConfirmationOpen(false)
      setRetryUpdate(null)
    },
    confirm() {
      if (retryUpdate) return confirmRetryUpdate()
      return confirmInstallUpdate()
    },
    subscribe(listener: () => void, version: string | null) {
      const revision = ++observation
      appVersion = version
      listeners.add(listener)
      if (
        isElectronRuntime() &&
        appVersion &&
        pendingReleaseNotes &&
        pendingReleaseNotes.version !== appVersion
      )
        clearPendingWeworkReleaseNotes()
      if (!running) {
        running = true
        if (isElectronRuntime()) {
          initialTimer = setTimeout(maybeAutoCheck, APP_UPDATE_INITIAL_CHECK_DELAY_MS)
          autoTimer = setInterval(maybeAutoCheck, APP_UPDATE_TIMER_INTERVAL_MS)
        }
      }
      publish()
      return () => {
        listeners.delete(listener)
        queueMicrotask(() => {
          if (listeners.size || revision !== observation) return
          running = false
          clearTimeout(initialTimer)
          clearInterval(autoTimer)
          clearSimulationTimer()
          reconcileInstallMonitor()
        })
      }
    },
  }
}
