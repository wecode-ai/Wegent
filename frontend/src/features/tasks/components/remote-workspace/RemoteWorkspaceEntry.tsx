// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FolderOpen } from 'lucide-react'

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
  display?: 'label' | 'icon'
  touchTarget?: boolean
  refreshKey?: string | number | null
}

const UNAVAILABLE_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000]

export function RemoteWorkspaceEntry({
  taskId,
  taskStatus,
  forceDisabled = false,
  disabledReason,
  display = 'label',
  touchTarget = false,
  refreshKey,
}: RemoteWorkspaceEntryProps) {
  const { t } = useTranslation('tasks')
  const [status, setStatus] = useState<RemoteWorkspaceStatusResponse | null>(null)
  const [isInitialLoading, setIsInitialLoading] = useState(false)
  const [hasLoadError, setHasLoadError] = useState(false)
  const [hasWorkspaceEntries, setHasWorkspaceEntries] = useState(false)
  const [isOpen, setIsOpen] = useState(false)
  const isMountedRef = useRef(true)
  const latestTaskIdRef = useRef<number | null>(null)
  const requestSequenceRef = useRef(0)
  const treeRequestSequenceRef = useRef(0)
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
          setStatus({ ...payload })
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

  const loadWorkspaceEntryHint = useCallback(
    async (rootPath: string) => {
      if (!taskId) {
        return
      }

      const requestTaskId = taskId
      const requestSequence = ++treeRequestSequenceRef.current

      try {
        const payload = await remoteWorkspaceApis.getTree(requestTaskId, rootPath)
        if (
          isMountedRef.current &&
          latestTaskIdRef.current === requestTaskId &&
          treeRequestSequenceRef.current === requestSequence
        ) {
          setHasWorkspaceEntries(payload.entries.length > 0)
        }
      } catch {
        if (
          isMountedRef.current &&
          latestTaskIdRef.current === requestTaskId &&
          treeRequestSequenceRef.current === requestSequence
        ) {
          setHasWorkspaceEntries(false)
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
      treeRequestSequenceRef.current += 1
      setStatus(null)
      setHasWorkspaceEntries(false)
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
      setHasWorkspaceEntries(false)
      setIsOpen(false)
      setHasLoadError(false)
      treeRequestSequenceRef.current += 1
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
    if (!taskId || !status?.connected || !status.available) {
      setHasWorkspaceEntries(false)
      return
    }

    void loadWorkspaceEntryHint(status.root_path || '/workspace')
  }, [loadWorkspaceEntryHint, refreshKey, status, taskId])

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

  const isIconOnly = display === 'icon'
  const shouldInlineIconHint = isIconOnly && hasWorkspaceEntries
  const buttonLabel = t('remote_workspace.button')
  const buttonTitle = title ?? (isIconOnly ? buttonLabel : undefined)
  const buttonClassName = [
    'relative overflow-visible',
    isIconOnly
      ? touchTarget
        ? shouldInlineIconHint
          ? 'h-11 min-w-[72px] px-2'
          : 'h-11 w-11'
        : shouldInlineIconHint
          ? 'h-8 min-w-[64px] px-2'
          : 'h-8 w-8'
      : touchTarget
        ? 'h-11 min-w-[44px]'
        : 'h-8',
    isIconOnly ? (shouldInlineIconHint ? 'gap-1' : 'p-0') : 'pl-2 pr-3',
    'rounded-[7px] text-sm',
  ].join(' ')
  const fileHintLabel = t('remote_workspace.status.has_files')
  const fileHint = hasWorkspaceEntries ? (
    <span
      className={
        isIconOnly
          ? 'rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm'
          : 'ml-1 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white shadow-sm'
      }
      data-testid="remote-workspace-file-hint"
    >
      {fileHintLabel}
    </span>
  ) : null

  return (
    <>
      <TooltipProvider delayDuration={120}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex" title={disabled ? title : undefined}>
              <Button
                variant="outline"
                size="sm"
                className={buttonClassName}
                onClick={() => {
                  void loadStatus({ silent: true })
                  setIsOpen(true)
                }}
                disabled={disabled}
                title={buttonTitle}
                aria-label={isIconOnly ? buttonLabel : undefined}
                data-testid="remote-workspace-button"
              >
                {isIconOnly ? (
                  <>
                    <FolderOpen className="h-4 w-4" aria-hidden="true" />
                    {fileHint}
                  </>
                ) : (
                  <>
                    {buttonLabel}
                    {fileHint}
                  </>
                )}
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
