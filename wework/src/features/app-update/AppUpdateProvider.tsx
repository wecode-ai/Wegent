import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  checkForWeworkUpdate,
  installPendingWeworkUpdate,
  type WeworkUpdateInfo,
} from '@/lib/app-updater'
import { isTauriRuntime } from '@/lib/runtime-environment'
import {
  APP_UPDATE_AUTO_CHECK_MIN_AGE_MS,
  APP_UPDATE_INITIAL_CHECK_DELAY_MS,
  APP_UPDATE_LAST_AUTO_CHECK_KEY,
  APP_UPDATE_TIMER_INTERVAL_MS,
  AppUpdateContext,
  type AppUpdateContextValue,
  type AppUpdateStatus,
} from './app-update-context'

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
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const checkInFlightRef = useRef(false)

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
    setMessage(null)
    setError(null)

    try {
      await installPendingWeworkUpdate()
    } catch (caughtError) {
      setStatus('error')
      setError(messageFor(caughtError))
    }
  }, [availableUpdate, status])

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
      message,
      error,
      checkNow,
      installUpdate,
    }),
    [availableUpdate, checkNow, error, installUpdate, message, status]
  )

  return <AppUpdateContext.Provider value={value}>{children}</AppUpdateContext.Provider>
}
