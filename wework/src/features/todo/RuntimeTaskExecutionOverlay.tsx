import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  AlertCircle,
  Bot,
  Check,
  ExternalLink,
  Hash,
  Monitor,
  RotateCcw,
  Square,
  X,
} from 'lucide-react'
import { CompositedSpinner } from '@/components/common/CompositedSpinner'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { ScrollableMessageArea } from '@/components/chat/ScrollableMessageArea'
import { DESKTOP_MESSAGE_LIST_CLASS } from '@/components/layout/desktopChatLayout'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { useWorkbenchPaneSession } from '@/components/layout/useWorkbenchPaneSession'
import {
  findRuntimeTask,
  truncateRuntimeTaskTitle,
} from '@/features/workbench/workbenchRuntimeHelpers'
import type { RuntimeTaskAddress } from '@/types/api'
import { executionDisplayStatus, isExecutionCancellable } from './executionStatus'

export interface RuntimeTaskExecutionOverlayProps {
  address: RuntimeTaskAddress
  senderName: string
  runId?: string | null
  modelName?: string | null
  runStatus?: string | null
  onClose: () => void
}

export function RuntimeTaskExecutionOverlay({
  address,
  senderName,
  runId,
  modelName,
  runStatus,
  onClose,
}: RuntimeTaskExecutionOverlayProps) {
  const { t } = useTranslation('common')
  const { state, cancelRuntimeTask, openRuntimeTask } = useWorkbenchPaneContext()
  const session = useWorkbenchPaneSession({
    currentRuntimeTask: address,
    debugSnapshotEnabled: false,
  })
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)
  const [stopping, setStopping] = useState(false)
  const [stopError, setStopError] = useState<string | null>(null)

  const runtimeTaskSummary = findRuntimeTask(state.runtimeWork, address)
  const taskTitle = truncateRuntimeTaskTitle(runtimeTaskSummary?.title)
  const device = state.devices.find(candidate => candidate.device_id === address.deviceId)
  const resolvedModel = modelName ?? runtimeTaskSummary?.modelSelection?.modelName ?? '—'
  const resolvedRunId = runId ?? String(address.taskId)
  const reportedStatus = runtimeTaskSummary?.status ?? runStatus
  const displayStatus = session.status.taskExecution.running
    ? 'running'
    : (executionDisplayStatus(reportedStatus) ?? 'unknown')
  const cancellable = isExecutionCancellable(displayStatus)

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null
    closeButtonRef.current?.focus()
    return () => {
      previouslyFocused?.focus?.()
    }
  }, [])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleStop = async () => {
    if (stopping) return
    setStopping(true)
    setStopError(null)
    try {
      await cancelRuntimeTask(address)
    } catch (cause) {
      setStopError(
        cause instanceof Error ? cause.message : t('workbench.task_activity_stop_failed')
      )
    } finally {
      setStopping(false)
    }
  }

  const statusContent = (() => {
    if (displayStatus === 'succeeded') {
      return (
        <>
          <Check className="h-3 w-3" />
          {t('workbench.queue_state_succeeded')}
        </>
      )
    }
    if (displayStatus === 'failed') {
      return (
        <>
          <X className="h-3 w-3" />
          {t('workbench.queue_state_failed')}
        </>
      )
    }
    if (displayStatus === 'cancelled' || displayStatus === 'skipped') {
      return (
        <>
          <Square className="h-3 w-3" />
          {t(
            displayStatus === 'cancelled'
              ? 'workbench.queue_state_cancelled'
              : 'workbench.queue_state_skipped'
          )}
        </>
      )
    }
    const labelKey = {
      waiting_approval: 'workbench.queue_state_pending_approval',
      queued: 'workbench.queue_state_queued',
      starting: 'workbench.queue_state_starting',
      waiting_runtime: 'workbench.queue_state_waiting_runtime',
      running: 'workbench.queue_state_running',
      cancelling: 'workbench.queue_state_cancelling',
      unknown: 'workbench.queue_state_unknown',
    }[displayStatus]
    return (
      <>
        <CompositedSpinner className="h-3 w-3" />
        {t(labelKey)}
      </>
    )
  })()

  const statusClassName = 'bg-muted text-text-secondary'

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/10 p-6"
      role="dialog"
      aria-modal="true"
      aria-label={t('workbench.task_activity_execution_details')}
      data-testid="runtime-execution-detail-overlay"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="flex h-[min(620px,84vh)] w-[min(780px,92vw)] flex-col overflow-hidden rounded-[20px] border border-border/50 bg-background shadow-[0_16px_44px_rgba(0,0,0,0.12)]">
        <header className="flex flex-none items-start gap-3 px-6 pb-4 pt-5">
          <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-violet-600 text-background">
            <Bot className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-text-primary">{senderName}</span>
              <span
                className={cn(
                  'inline-flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                  statusClassName
                )}
                data-testid="runtime-execution-detail-status"
              >
                {statusContent}
              </span>
            </div>
            <h2 className="mt-1 truncate text-sm font-semibold text-text-primary">
              {taskTitle ?? t('workbench.task_activity_ai_execution')}
            </h2>
            <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-text-muted">
              <span className="inline-flex items-center gap-1.5">
                <Hash className="h-3 w-3" />
                {t('workbench.task_activity_execution_run')}: {resolvedRunId}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Bot className="h-3 w-3" />
                {t('workbench.task_activity_execution_model')}: {resolvedModel}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Monitor className="h-3 w-3" />
                {t('workbench.task_activity_execution_device')}: {device?.name ?? address.deviceId}
              </span>
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            data-testid="runtime-execution-detail-close"
            aria-label={t('workbench.close_dialog', '关闭')}
            onClick={onClose}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-lg text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1" data-testid="runtime-execution-detail-body">
          {session.transcriptError && session.messages.length === 0 ? (
            <div
              className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center"
              data-testid="runtime-execution-detail-transcript-error"
            >
              <AlertCircle className="h-5 w-5 text-text-muted" />
              <div>
                <p className="text-sm font-medium text-text-primary">
                  {t('workbench.task_activity_transcript_unavailable')}
                </p>
                <p className="mt-1 text-xs text-text-muted">
                  {t('workbench.task_activity_transcript_execution_continues')}
                </p>
              </div>
              <button
                type="button"
                data-testid="runtime-execution-detail-transcript-retry"
                onClick={session.reloadRuntimeTranscript}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-3 text-sm font-medium text-text-primary hover:bg-muted/80"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                {t('workbench.retry')}
              </button>
            </div>
          ) : (
            <ScrollableMessageArea
              messages={session.messages}
              loading={session.transcriptLoading}
              isWaitingForAssistant={session.waitingForAssistant}
              hasMoreBefore={session.transcriptHasMoreBefore}
              loadingMoreBefore={session.transcriptLoadingMoreBefore}
              turnNavigation={session.turnNavigation}
              loadedTranscriptRanges={session.loadedTranscriptRanges}
              onLoadMoreBefore={session.loadMoreTranscriptBefore}
              onLoadFullTranscript={session.loadFullTranscript}
              loadingFullTranscript={session.transcriptLoadingFullContent}
              onLoadTurnNavigationItem={session.loadTranscriptTurnNavigationItem}
              onLoadTranscriptGap={session.loadTranscriptGap}
              conversationKey={`${address.deviceId}:${address.taskId}`}
              devices={state.devices}
              messageListClassName={DESKTOP_MESSAGE_LIST_CLASS}
              className="h-full"
              scrollTestId="runtime-execution-detail-scroll"
            />
          )}
        </div>

        <footer className="flex flex-none items-center gap-3 border-t border-border/50 px-6 py-3">
          {cancellable ? (
            <button
              type="button"
              data-testid="runtime-execution-detail-stop"
              onClick={() => void handleStop()}
              disabled={stopping}
              className="inline-flex h-8 items-center gap-2 rounded-lg px-3 text-sm font-medium text-red-600 hover:bg-red-500/10 disabled:opacity-50"
            >
              {stopping ? (
                <CompositedSpinner className="h-3.5 w-3.5" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              {t('workbench.task_activity_stop_execution')}
            </button>
          ) : null}
          {stopError ? (
            <span className="min-w-0 flex-1 truncate text-xs text-red-600" role="alert">
              {stopError}
            </span>
          ) : null}
          <span className="flex-1" />
          <button
            type="button"
            data-testid="runtime-execution-detail-open-page"
            onClick={() => void openRuntimeTask(address)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-blue-600 hover:bg-blue-500/10 hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            {t('workbench.task_activity_open_in_task_page')}
          </button>
          <button
            type="button"
            data-testid="runtime-execution-detail-footer-close"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
          >
            {t('workbench.close_dialog', '关闭')}
          </button>
        </footer>
      </div>
    </div>,
    document.body
  )
}
