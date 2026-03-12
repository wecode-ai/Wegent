// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

import { remoteWorkspaceApis, type RemoteWorkspaceStatusResponse } from '@/apis/remoteWorkspace'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'

import { RemoteWorkspaceDialog } from './RemoteWorkspaceDialog'

type RemoteWorkspaceEntryProps = {
  taskId?: number | null
  taskStatus?: string | null
  forceDisabled?: boolean
  disabledReason?: string
}

const UNAVAILABLE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]

export function RemoteWorkspaceEntry({
  taskId,
  taskStatus,
  forceDisabled = false,
  disabledReason,
}: RemoteWorkspaceEntryProps) {
  const { t } = useTranslation('tasks')
  const [status, setStatus] = useState<RemoteWorkspaceStatusResponse | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(false)
  const [hasLoadError, setHasLoadError] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const isMountedRef = useRef(true)
  const latestTaskIdRef = useRef<number | null>(null)
  const requestSequenceRef = useRef(0)
  const previousTaskIdRef = useRef<number | null>(null)
  const previousTaskStatusRef = useRef<string | null | undefined>(undefined)
  const retryAttemptRef = useRef(0)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearRetryTimer = useCallback(() => {
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current)
      retryTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      clearRetryTimer()
    }
  }, [clearRetryTimer])

  const loadStatus = useCallback(
    async (options?: { silent?: boolean }) => {
      if (!taskId) {
        return
      }

      const silent = options?.silent ?? false
      const requestTaskId = taskId
      const requestSequence = ++requestSequenceRef.current

      if (!silent) {
        setIsInitialLoading(true)
      }

      try {
        const payload = await remoteWorkspaceApis.getStatus(requestTaskId)
        if (
          isMountedRef.current &&
          latestTaskIdRef.current === requestTaskId &&
          requestSequenceRef.current === requestSequence
        ) {
          setHasLoadError(false)
          setStatus(payload)
        }
      } catch {
        if (
          isMountedRef.current &&
          latestTaskIdRef.current === requestTaskId &&
          requestSequenceRef.current === requestSequence &&
          !silent
        ) {
          setHasLoadError(true)
          setStatus(null)
        }
      } finally {
        if (
          isMountedRef.current &&
          latestTaskIdRef.current === requestTaskId &&
          requestSequenceRef.current === requestSequence &&
          !silent
        ) {
          setIsInitialLoading(false)
        }
      }
    },
    [taskId]
  )

  useEffect(() => {
    if (!taskId) {
      clearRetryTimer()
      retryAttemptRef.current = 0
      latestTaskIdRef.current = null
      requestSequenceRef.current += 1
      setStatus(null)
      setIsOpen(false)
      setIsInitialLoading(false)
      setHasLoadError(false)
      previousTaskIdRef.current = null
      previousTaskStatusRef.current = undefined
      return
    }

    latestTaskIdRef.current = taskId

    const taskChanged = previousTaskIdRef.current !== taskId
    const statusChanged = !taskChanged && previousTaskStatusRef.current !== taskStatus

    previousTaskIdRef.current = taskId
    previousTaskStatusRef.current = taskStatus

    if (taskChanged) {
      clearRetryTimer()
      retryAttemptRef.current = 0
      setStatus(null)
      setIsOpen(false)
      setHasLoadError(false)
      void loadStatus()
      return
    }

    if (statusChanged) {
      clearRetryTimer()
      retryAttemptRef.current = 0
      void loadStatus({ silent: true })
    }
  }, [clearRetryTimer, loadStatus, taskId, taskStatus])

  useEffect(() => {
    clearRetryTimer()

    if (!taskId || !status) {
      return
    }

    if (!status.connected || status.available) {
      retryAttemptRef.current = 0
      return
    }

    if (retryAttemptRef.current >= UNAVAILABLE_RETRY_DELAYS_MS.length) {
      return
    }

    const delay = UNAVAILABLE_RETRY_DELAYS_MS[retryAttemptRef.current]
    retryAttemptRef.current += 1
    retryTimerRef.current = setTimeout(() => {
      void loadStatus({ silent: true })
    }, delay)

    return clearRetryTimer
  }, [clearRetryTimer, loadStatus, status, taskId])

  useEffect(() => {
    if (!taskId) {
      return
    }

    const refreshStatus = () => {
      void loadStatus({ silent: true })
    }

    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') {
        refreshStatus()
      }
    }

    window.addEventListener('focus', refreshStatus)
    document.addEventListener('visibilitychange', refreshWhenVisible)

    return () => {
      window.removeEventListener('focus', refreshStatus)
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [loadStatus, taskId])

  if (!taskId) {
    return null
  }

  const resolveUnavailableReason = (reason: string | null | undefined): string => {
    switch (reason) {
      case 'not_connected':
        return t('remote_workspace.reason_not_connected')
      case 'sandbox_not_running':
        return t('remote_workspace.reason_sandbox_not_running')
      case 'booting':
        return t('remote_workspace.reason_booting')
      case 'warming':
        return t('remote_workspace.reason_warming')
      case 'starting':
        return t('remote_workspace.reason_starting')
      default:
        return t('remote_workspace.unavailable')
    }
  }

  const isWorkspaceReady = Boolean(status?.connected && status?.available)
  const disabled = forceDisabled || !isWorkspaceReady

  let title: string | undefined
  if (forceDisabled) {
    title = disabledReason || t('remote_workspace.unavailable')
  } else if (!status) {
    if (hasLoadError) {
      title = t('remote_workspace.reason_status_check_failed')
    } else if (isInitialLoading) {
      title = t('remote_workspace.reason_loading')
    } else {
      title = t('remote_workspace.unavailable')
    }
  } else if (!status.connected || !status.available) {
    title = resolveUnavailableReason(status.reason)
  }

  return (
    <>
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" title={disabled ? title : undefined}>
              <Button
                variant="outline"
                size="sm"
                className="h-8 pl-2 pr-3 rounded-[7px] text-sm"
                onClick={() => {
                  void loadStatus({ silent: true })
                  setIsOpen(true)
                }}
                disabled={disabled}
                title={title}
              >
                {t('remote_workspace.button')}
              </Button>
            </span>
          </TooltipTrigger>
          {disabled && title ? <TooltipContent side="bottom">{title}</TooltipContent> : null}
        </Tooltip>
      </TooltipProvider>
      <RemoteWorkspaceDialog
        open={isOpen}
        onOpenChange={setIsOpen}
        taskId={taskId}
        rootPath={status?.root_path || '/workspace'}
      />
    </>
  )
}
