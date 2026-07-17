import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  checkForWeworkUpdate,
  installPendingWeworkUpdate,
  type WeworkUpdateDownloadProgress,
  type WeworkUpdateInfo,
} from '@/lib/app-updater'
import { isTauriRuntime } from '@/lib/runtime-environment'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
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

function readLastAutoCheckAt(): number {
  const raw = window.localStorage.getItem(APP_UPDATE_LAST_AUTO_CHECK_KEY)
  const value = Number(raw)
  return Number.isFinite(value) ? value : 0
}

function writeLastAutoCheckAt(value: number) {
  window.localStorage.setItem(APP_UPDATE_LAST_AUTO_CHECK_KEY, String(value))
}

function shouldAutoCheck(now: number): boolean {
  return now - readLastAutoCheckAt() >= APP_UPDATE_AUTO_CHECK_MIN_AGE_MS
}

function messageFor(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Failed to check for updates'
}

export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const [availableUpdate, setAvailableUpdate] = useState<WeworkUpdateInfo | null>(null)
  const [status, setStatus] = useState<AppUpdateStatus>('idle')
  const [downloadProgress, setDownloadProgress] = useState<WeworkUpdateDownloadProgress | null>(
    null
  )
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const checkInFlightRef = useRef(false)
  const simulationTimerRef = useRef<number | null>(null)

  const clearSimulationTimer = useCallback(() => {
    if (simulationTimerRef.current === null) return
    window.clearInterval(simulationTimerRef.current)
    simulationTimerRef.current = null
  }, [])

  const runCheck = useCallback(
    async ({ silent }: { silent: boolean }): Promise<WeworkUpdateInfo | null> => {
      if (checkInFlightRef.current || status === 'installing') {
        return availableUpdate
      }

      checkInFlightRef.current = true
      if (!silent) {
        setStatus('checking')
        setMessage(null)
        setError(null)
      }

      try {
        const update = await checkForWeworkUpdate()
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

        return update
      } catch (caughtError) {
        if (!silent) {
          setStatus('error')
          setMessage(null)
          setError(messageFor(caughtError))
        }
        return null
      } finally {
        checkInFlightRef.current = false
      }
    },
    [availableUpdate, status]
  )

  const checkNow = useCallback(() => runCheck({ silent: false }), [runCheck])

  const installUpdate = useCallback(async () => {
    if (!availableUpdate || status === 'installing') return

    setStatus('installing')
    setDownloadProgress({ downloadedBytes: 0, totalBytes: null })
    setMessage(null)
    setError(null)

    try {
      await installPendingWeworkUpdate(setDownloadProgress)
    } catch (caughtError) {
      const installError = messageFor(caughtError)
      setDownloadProgress(null)
      setError(installError)

      try {
        const refreshedUpdate = await checkForWeworkUpdate()
        setAvailableUpdate(refreshedUpdate)
        setStatus(refreshedUpdate ? 'available' : 'error')
      } catch {
        setStatus('error')
      }
    }
  }, [availableUpdate, status])

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
      if (!shouldAutoCheck(now)) return

      writeLastAutoCheckAt(now)
      void runCheck({ silent: true })
    }

    const initialTimer = window.setTimeout(maybeAutoCheck, APP_UPDATE_INITIAL_CHECK_DELAY_MS)
    const intervalTimer = window.setInterval(maybeAutoCheck, APP_UPDATE_TIMER_INTERVAL_MS)

    return () => {
      window.clearTimeout(initialTimer)
      window.clearInterval(intervalTimer)
    }
  }, [runCheck])

  const value = useMemo<AppUpdateContextValue>(
    () => ({
      availableUpdate,
      status,
      downloadProgress,
      message,
      error,
      checkNow,
      installUpdate,
    }),
    [availableUpdate, checkNow, downloadProgress, error, installUpdate, message, status]
  )

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>
}
