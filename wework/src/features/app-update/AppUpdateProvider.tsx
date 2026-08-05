import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  checkForWeworkUpdate,
  installPendingWeworkUpdate,
  type WeworkUpdateChannel,
  type WeworkUpdateDownloadProgress,
  type WeworkUpdateInfo,
} from '@/lib/app-updater'
import { isTauriRuntime } from '@/lib/runtime-environment'
import { track } from '@/telemetry/client'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
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
const SIMULATED_DOWNLOAD_STEP_BYTES = 1_000_000
const SIMULATED_DOWNLOAD_INTERVAL_MS = 250

interface UpdateCheckResult {
  update: WeworkUpdateInfo | null
  error: string | null
}

function readUpdateChannel(): WeworkUpdateChannel {
  return window.localStorage.getItem(APP_UPDATE_CHANNEL_KEY) === 'beta' ? 'beta' : 'stable'
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

function messageFor(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Failed to check for updates'
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [updateChannel, setUpdateChannelState] = useState<WeworkUpdateChannel>(readUpdateChannel)
  const [availableUpdate, setAvailableUpdate] = useState<WeworkUpdateInfo | null>(null)
  const [status, setStatus] = useState<AppUpdateStatus>('idle')
  const [downloadProgress, setDownloadProgress] = useState<WeworkUpdateDownloadProgress | null>(
    null
  )
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const updateChannelRef = useRef(updateChannel)
  const activeCheckRef = useRef<{
    channel: WeworkUpdateChannel
    promise: Promise<UpdateCheckResult>
  } | null>(null)
  const simulationTimerRef = useRef<number | null>(null)

  const clearSimulationTimer = useCallback(() => {
    if (simulationTimerRef.current === null) return
    window.clearInterval(simulationTimerRef.current)
    simulationTimerRef.current = null
  }, [])

  const runCheck = useCallback(
    async ({
      silent,
      channel = updateChannel,
    }: {
      silent: boolean
      channel?: WeworkUpdateChannel
    }): Promise<WeworkUpdateInfo | null> => {
      if (status === 'installing') {
        return availableUpdate
      }

      const activeCheck = activeCheckRef.current
      if (activeCheck?.channel === channel) {
        if (!silent && channel === updateChannelRef.current) {
          setStatus('checking')
          setMessage(null)
          setError(null)
        }

        const result = await activeCheck.promise
        if (!silent && channel === updateChannelRef.current) {
          setAvailableUpdate(result.update)
          if (result.error) {
            setStatus('error')
            setMessage(null)
            setError(result.error)
          } else if (result.update) {
            setStatus('available')
            setMessage(null)
            setError(null)
          } else {
            setStatus('upToDate')
            setMessage('upToDate')
            setError(null)
          }
        }
        return result.update
      }
      if (activeCheck) {
        await activeCheck.promise
      }

      const promise = (async (): Promise<UpdateCheckResult> => {
        if (!silent && channel === updateChannelRef.current) {
          setStatus('checking')
          setMessage(null)
          setError(null)
        }

        try {
          const update = await checkForWeworkUpdate(channel)
          if (channel !== updateChannelRef.current) {
            return { update, error: null }
          }

          setAvailableUpdate(update)

          if (update) {
            setStatus('available')
            setMessage(null)
            setError(null)
          } else if (!silent) {
            setStatus('upToDate')
            setMessage('upToDate')
            setError(null)
          }

          return { update, error: null }
        } catch (caughtError) {
          const checkError = messageFor(caughtError)
          if (!silent && channel === updateChannelRef.current) {
            setStatus('error')
            setMessage(null)
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
    [availableUpdate, status, updateChannel]
  )

  const checkNow = useCallback(() => runCheck({ silent: false }), [runCheck])

  const installUpdate = useCallback(async () => {
    if (!availableUpdate || status === 'installing') return

    setStatus('installing')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: null })
    setMessage(null)
    setError(null)
    track('app_update_install_started', {})

    try {
      await installPendingWeworkUpdate(setDownloadProgress)
    } catch (caughtError) {
      const installError = messageFor(caughtError)
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
  }, [availableUpdate, status, updateChannel])

  const setUpdateChannel = useCallback(
    async (channel: WeworkUpdateChannel) => {
      if (channel === updateChannel || status === 'installing') return

      window.localStorage.setItem(APP_UPDATE_CHANNEL_KEY, channel)
      updateChannelRef.current = channel
      setUpdateChannelState(channel)
      setAvailableUpdate(null)
      setDownloadProgress(null)
      setMessage(null)
      setError(null)
      await runCheck({ silent: false, channel })
    },
    [runCheck, status, updateChannel]
  )

  const simulateUpdate = useCallback(() => {
    clearSimulationTimer()
    setAvailableUpdate({
      currentVersion: __WEWORK_APP_VERSION__,
      version: SIMULATED_UPDATE_VERSION,
    })
    setStatus('installing')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: SIMULATED_DOWNLOAD_TOTAL_BYTES })
    setMessage(null)
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
        setAvailableUpdate(null)
        setStatus('upToDate')
        setMessage('upToDate')
      }
    }, SIMULATED_DOWNLOAD_INTERVAL_MS)
  }, [clearSimulationTimer])

  useEffect(() => {
    window.addEventListener(APP_UPDATE_SIMULATE_EVENT, simulateUpdate)
    return () => window.removeEventListener(APP_UPDATE_SIMULATE_EVENT, simulateUpdate)
  }, [simulateUpdate])

  useEffect(() => clearSimulationTimer, [clearSimulationTimer])

  useEffect(() => {
    if (!isTauriRuntime()) return

    const maybeAutoCheck = () => {
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
  }, [runCheck, updateChannel])

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      updateChannel,
      availableUpdate,
      status,
      downloadProgress,
      message,
      error,
      checkNow,
      installUpdate,
      setUpdateChannel,
    }),
    [
      availableUpdate,
      checkNow,
      downloadProgress,
      error,
      installUpdate,
      message,
      setUpdateChannel,
      status,
      updateChannel,
    ]
  )

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>
}
