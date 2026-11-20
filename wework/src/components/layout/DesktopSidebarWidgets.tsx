import { DialogSurface } from '@wegent/collaboration/controls/DialogSurface'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Archive, Loader2, Sparkles, SquareTerminal, X } from 'lucide-react'

import { createPortal } from 'react-dom'

import { Tooltip } from '@/components/ui/tooltip'

import type { WeworkInstalledReleaseNotes } from '@/features/app-update/app-release-notes'

import { useTranslation } from '@/hooks/useTranslation'

import { cn } from '@/lib/utils'
import { SidebarTaskTitle } from './SidebarTaskTitle'

import type { LocalHarnessWorkbenchSession } from './localHarnessWorkbench'

import { getDeviceRouteLabel, getDeviceRouteTitle } from './desktopSidebarHelpers'
import type {
  ArchiveConversationsConfirmDialogProps,
  SidebarDeviceState,
} from './desktopSidebarTypes'
export function ArchiveConversationsConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  submitting = false,
  testId,
  onClose,
  onConfirm,
}: ArchiveConversationsConfirmDialogProps) {
  if (!open) return null

  return createPortal(
    <div
      data-testid={`${testId}-overlay`}
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/45 px-4"
    >
      <DialogSurface
        onClose={() => {
          if (!submitting) onClose()
        }}
        render={
          <div
            aria-labelledby={`${testId}-title`}
            data-testid={testId}
            className="w-full max-w-[460px] rounded-xl border border-border bg-popover p-5 text-text-primary shadow-[0_20px_56px_rgba(0,0,0,0.28)]"
          />
        }
      >
        <div className="flex items-start justify-between gap-5">
          <h2 id={`${testId}-title`} className="heading-base tracking-normal">
            {title}
          </h2>
          <Tooltip label={cancelLabel} testId={`${testId}-close-tooltip`}>
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`${testId}-close-button`}
              onClick={onClose}
              disabled={submitting}
              className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
              aria-label={cancelLabel}
            >
              <X className="h-4 w-4" />
            </ControlButton>
          </Tooltip>
        </div>
        <p className="mt-3 text-sm leading-6 text-text-secondary">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`${testId}-cancel-button`}
            onClick={onClose}
            disabled={submitting}
            className="h-8 min-w-[76px] rounded-lg px-3 text-sm font-medium text-text-secondary hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-45"
          >
            {cancelLabel}
          </ControlButton>
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid={`${testId}-confirm-button`}
            onClick={() => void onConfirm()}
            disabled={submitting}
            className="inline-flex h-8 min-w-[96px] items-center justify-center gap-2 rounded-lg bg-destructive/15 px-4 text-sm font-semibold text-destructive hover:bg-destructive/20 disabled:cursor-not-allowed disabled:opacity-60 wework:bg-red-500/15 wework:text-red-500 wework:hover:bg-red-500/20"
          >
            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>,
    document.body
  )
}

export function SidebarReleaseNotesCard({
  releaseNotes,
  onOpen,
  onDismiss,
}: {
  releaseNotes: WeworkInstalledReleaseNotes
  onOpen: () => void
  onDismiss: () => void
}) {
  const { t } = useTranslation('common')
  const dismissLabel = t('workbench.app_release_notes_dismiss', '关闭版本更新提示')

  return (
    <aside
      data-testid="sidebar-release-notes-card"
      className="relative mb-1 shrink-0 overflow-hidden rounded-xl border border-border bg-surface text-text-primary shadow-sm"
    >
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="sidebar-release-notes-open"
        onClick={onOpen}
        className="block w-full py-3 pl-3 pr-10 text-left hover:bg-muted/60 focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus wework:keyboard:focus-visible:ring-blue-500"
      >
        <span className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
          <span className="min-w-0 truncate text-sm font-medium">
            {t('workbench.app_release_notes_updated', {
              defaultValue: 'Wework 已更新至 v{{version}}',
              version: releaseNotes.version,
            })}
          </span>
        </span>
        <span className="mt-1 block text-xs leading-4 text-text-secondary">
          {t('workbench.app_release_notes_summary', '查看此版本的新功能和改进')}
        </span>
      </ControlButton>
      <Tooltip
        label={dismissLabel}
        testId="sidebar-release-notes-dismiss-tooltip"
        className="absolute right-2 top-2"
      >
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="sidebar-release-notes-dismiss"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="flex h-7 w-7 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </ControlButton>
      </Tooltip>
    </aside>
  )
}

export function ProjectDeviceInlineStatus({
  deviceState,
  testId,
  className,
}: {
  deviceState: SidebarDeviceState
  testId: string
  className?: string
}) {
  const label = getDeviceRouteLabel(deviceState)
  const title = getDeviceRouteTitle(deviceState)
  const online = deviceState.status === 'online'

  return (
    <span
      data-testid={testId}
      title={title}
      aria-label={label}
      className={cn(
        'ml-auto flex min-w-0 shrink-0 items-center gap-2 text-sm leading-[18px] text-[rgb(var(--color-sidebar-text-muted))]',
        className
      )}
    >
      <span className="max-w-[96px] truncate">{label}</span>
      <span
        data-testid={`${testId}-dot`}
        aria-hidden="true"
        className={cn(
          'h-2 w-2 shrink-0 rounded-full',
          !online && 'bg-[rgb(var(--color-sidebar-text-muted))] opacity-55'
        )}
        style={
          online
            ? { backgroundColor: 'rgb(var(--color-device-online, var(--color-success)))' }
            : undefined
        }
      />
    </span>
  )
}

export function LocalHarnessSessionRow({
  session,
  selected,
  indentClassName,
  onOpen,
  onClose,
}: {
  session: LocalHarnessWorkbenchSession
  selected: boolean
  indentClassName?: string
  onOpen?: (sessionId: string) => void
  onClose?: (sessionId: string) => void | Promise<void>
}) {
  const { t } = useTranslation('common')
  const canArchive = session.harnessId === 'opencode'
  const canClose = !session.isPrimary
  const useArchiveTestId = canArchive && session.isPrimary

  return (
    <div data-sidebar-task-row className="group/harness-session relative flex items-center">
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid={`local-harness-session-row-${session.sessionId}`}
        onClick={() => onOpen?.(session.sessionId)}
        aria-current={selected ? 'page' : undefined}
        className={cn(
          'flex h-[30px] min-w-0 flex-1 items-center gap-2 rounded-[10px] px-2.5 text-left text-sm',
          indentClassName,
          selected
            ? 'bg-[rgb(var(--color-sidebar-active))] text-text-primary'
            : 'text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))]'
        )}
      >
        <SquareTerminal className="h-4 w-4 shrink-0" aria-hidden="true" />
        <SidebarTaskTitle
          text={session.title}
          testId={`local-harness-session-title-${session.sessionId}`}
        />
      </ControlButton>
      {onClose && (canArchive || canClose) && (
        <Tooltip
          label={
            canArchive
              ? t('workbench.archive_harness', '归档编码会话')
              : t('workbench.close_harness', '关闭编码工具')
          }
          testId={`local-harness-session-${session.sessionId}-action-tooltip`}
          className="absolute right-1"
        >
          <ControlButton
            variant="unstyled"
            type="button"
            data-sidebar-title-actions
            data-testid={
              useArchiveTestId
                ? `archive-local-harness-session-${session.sessionId}`
                : `close-local-harness-session-${session.sessionId}`
            }
            onClick={event => {
              event.stopPropagation()
              void onClose(session.sessionId)
            }}
            aria-label={
              canArchive
                ? t('workbench.archive_harness', '归档编码会话')
                : t('workbench.close_harness', '关闭编码工具')
            }
            className="flex h-6 w-6 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] opacity-0 hover:bg-[rgb(var(--color-sidebar-hover))] group-hover/harness-session:opacity-100 group-has-[:focus-visible]/harness-session:opacity-100 focus-visible:opacity-100"
          >
            {canArchive ? <Archive className="h-3.5 w-3.5" /> : <X className="h-3.5 w-3.5" />}
          </ControlButton>
        </Tooltip>
      )}
    </div>
  )
}
