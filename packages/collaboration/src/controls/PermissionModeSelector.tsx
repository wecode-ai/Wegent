import { Eye, FolderPen, ShieldAlert } from 'lucide-react'
import { useCallback, useId, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { ActionMenu } from './ActionMenu'
import { useEscapeKey } from '../markdown/useEscapeKey'
import type { CollaborationTranslate } from '../i18n'
import { useCollaborationPortalTheme } from '../theme'
import {
  DEFAULT_RUNTIME_PERMISSION_MODE,
  RUNTIME_COMMAND_APPROVAL_MODES,
  type RuntimeCommandApprovalMode,
  type RuntimePermissionMode,
} from '@wegent/chat-core/runtime-permission'

export interface PermissionModeSelectorProps {
  translate: CollaborationTranslate
  value?: RuntimePermissionMode
  commandApproval?: RuntimeCommandApprovalMode
  onCommandApprovalChange?: (mode: RuntimeCommandApprovalMode) => void
  disabled?: boolean
  iconOnly?: boolean
  onChange: (
    mode: RuntimePermissionMode,
    approval?: RuntimeCommandApprovalMode,
  ) => void
}

export function PermissionModeSelector({
  translate: t,
  value = DEFAULT_RUNTIME_PERMISSION_MODE,
  commandApproval = 'manual',
  onCommandApprovalChange,
  disabled = false,
  iconOnly = false,
  onChange,
}: PermissionModeSelectorProps) {
  const [confirmation, setConfirmation] = useState<
    'full-access' | 'automatic' | null
  >(null)
  const triggerContainerRef = useRef<HTMLDivElement>(null)
  const restoreTriggerFocus = useCallback(
    () =>
      triggerContainerRef.current?.querySelector<HTMLElement>(
        '[data-testid="permission-mode-menu-button"]',
      ) ?? null,
    [],
  )
  const labels: Record<RuntimePermissionMode, string> = {
    'read-only': t('workbench.permission_mode_read_only', '只读'),
    'workspace-write': t('workbench.permission_mode_workspace', '工作区'),
    'full-access': t('workbench.permission_mode_full_access', '完整访问'),
  }
  const approvalLabels = {
    manual: t('workbench.command_approval_manual', '人工确认高危命令'),
    ai: t('workbench.command_approval_ai', 'AI 审核高危命令'),
    automatic: t('workbench.command_approval_automatic', '自动执行高危命令'),
  }
  const showCommandApproval = value === 'full-access' && onCommandApprovalChange
  const label = showCommandApproval
    ? `${labels[value]} · ${approvalLabels[commandApproval]}`
    : labels[value]
  const ariaLabel = `${t('workbench.permission_mode', '权限模式')}: ${label}`

  const choose = (mode: RuntimePermissionMode) => {
    if (mode === 'full-access' && value !== 'full-access') {
      setConfirmation('full-access')
      return
    }
    onChange(mode)
  }

  return (
    <>
      <div ref={triggerContainerRef} className="contents">
        <ActionMenu
          ariaLabel={ariaLabel}
          testId="permission-mode-menu-button"
          icon={
            value === 'read-only'
              ? Eye
              : value === 'full-access'
                ? ShieldAlert
                : FolderPen
          }
          triggerLabel={iconOnly ? undefined : labels[value]}
          disabled={disabled}
          placement="bottom-end"
          triggerClassName={
            iconOnly
              ? 'flex h-8 w-8 min-h-11 min-w-11 items-center justify-center rounded-full md:min-h-8 md:min-w-8 text-text-secondary transition-colors hover:bg-muted hover:text-text-primary'
              : 'flex h-8 min-h-11 max-w-32 items-center md:min-h-8 gap-1.5 rounded-lg px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary'
          }
          items={[
            ...(['read-only', 'workspace-write', 'full-access'] as const).map(
              (mode) => ({
                label: labels[mode],
                checked: value === mode,
                icon:
                  mode === 'read-only'
                    ? Eye
                    : mode === 'full-access'
                      ? ShieldAlert
                      : FolderPen,
                testId: `permission-mode-${mode}`,
                onSelect: () => choose(mode),
                danger: mode === 'full-access',
              }),
            ),
            ...(showCommandApproval
              ? [
                  {
                    label: '',
                    separator: true,
                    testId: 'command-approval-separator',
                  },
                  ...RUNTIME_COMMAND_APPROVAL_MODES.map((mode) => ({
                    label: approvalLabels[mode],
                    checked: commandApproval === mode,
                    testId: `command-approval-${mode}`,
                    onSelect: () => {
                      if (mode === 'automatic' && commandApproval !== mode) {
                        setConfirmation('automatic')
                      } else {
                        onCommandApprovalChange(mode)
                      }
                    },
                    danger: mode === 'automatic',
                  })),
                ]
              : []),
          ]}
        />
      </div>
      {confirmation ? (
        <FullAccessConfirmDialog
          translate={t}
          restoreFocusTo={restoreTriggerFocus}
          automatic={confirmation === 'automatic'}
          commandOptions={
            onCommandApprovalChange
              ? {
                  labels: approvalLabels,
                  initial:
                    confirmation === 'automatic'
                      ? 'automatic'
                      : commandApproval,
                }
              : undefined
          }
          onCancel={() => setConfirmation(null)}
          onConfirm={(mode) => {
            if (confirmation === 'automatic') {
              if (mode !== undefined) onCommandApprovalChange?.(mode)
            } else {
              if (mode === undefined) onChange('full-access')
              else onChange('full-access', mode)
            }
            setConfirmation(null)
          }}
        />
      ) : null}
    </>
  )
}

function FullAccessConfirmDialog({
  translate: t,
  restoreFocusTo,
  automatic,
  commandOptions,
  onCancel,
  onConfirm,
}: {
  translate: CollaborationTranslate
  restoreFocusTo: () => HTMLElement | null
  automatic: boolean
  onCancel: () => void
  commandOptions?: {
    labels: Record<RuntimeCommandApprovalMode, string>
    initial: RuntimeCommandApprovalMode
  }
  onConfirm: (mode?: RuntimeCommandApprovalMode) => void
}) {
  const [approval, setApproval] = useState(commandOptions?.initial)
  const approvalName = useId()
  const approvalHelp = {
    manual: t('workbench.command_approval_manual_help', '每次由你决定是否执行'),
    ai: t('workbench.command_approval_ai_help', '由 Codex 审核并决定是否执行'),
    automatic: t('workbench.command_approval_automatic_help', '无需逐次确认'),
  }
  const portalTheme = useCollaborationPortalTheme()
  const dialogRef = useRef<HTMLDivElement>(null)
  useEscapeKey(onCancel, true, dialogRef)

  const focusCancel = useCallback(
    (node: HTMLButtonElement | null) => {
      if (!node) return
      node.focus({ preventScroll: true })
      return () => {
        const trigger = restoreFocusTo()
        if (trigger?.isConnected) trigger.focus()
      }
    },
    [restoreFocusTo],
  )

  const trapFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return
    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'input[type="radio"]:checked, button:not([disabled])',
      ) ?? [],
    )
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current?.focus()
      return
    }
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div
      {...portalTheme}
      className={`${portalTheme.className} fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4`}
      data-testid="full-access-confirm-overlay"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="full-access-confirm-title"
        tabIndex={-1}
        onKeyDown={trapFocus}
        className="max-h-[90dvh] w-full max-w-[440px] overflow-y-auto rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-xl"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-red-500" aria-hidden="true" />
          <h2 id="full-access-confirm-title" className="heading-small">
            {automatic
              ? t('workbench.command_approval_title', '高危命令处理方式')
              : t(
                  'workbench.permission_full_access_confirm_title',
                  '启用完整访问？',
                )}
          </h2>
        </div>
        {!automatic && (
          <p className="mt-3 text-sm leading-5 text-text-secondary">
            {t(
              'workbench.permission_full_access_confirm_description',
              'Codex 可以运行命令、访问网络，并读写或删除工作区外的文件。',
            )}
          </p>
        )}
        {commandOptions && (
          <fieldset className="mt-4 min-w-0">
            <legend
              className={automatic ? 'sr-only' : 'mb-2 text-sm font-medium'}
            >
              {t('workbench.command_approval_title', '高危命令处理方式')}
            </legend>
            <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
              {RUNTIME_COMMAND_APPROVAL_MODES.map((mode) => (
                <label
                  key={mode}
                  className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 hover:bg-muted/60 has-[:checked]:bg-muted/60"
                >
                  <input
                    type="radio"
                    name={approvalName}
                    checked={approval === mode}
                    data-testid={`command-approval-confirm-option-${mode}`}
                    onChange={() => setApproval(mode)}
                    className="h-4 w-4 shrink-0 accent-text-primary"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">
                      {commandOptions.labels[mode]}
                    </span>
                    <span className="block text-xs text-text-secondary">
                      {approvalHelp[mode]}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {approval === 'automatic' && (
          <p className="mt-3 text-sm leading-5 text-text-secondary">
            {t(
              'workbench.command_approval_confirm_description',
              'Codex 识别出的高危命令（例如强制删除文件）可以直接运行，可能造成不可恢复的数据丢失。',
            )}
          </p>
        )}
        {!automatic && approval !== 'automatic' && (
          <p className="mt-3 text-xs leading-5 text-text-secondary">
            {t(
              'workbench.permission_full_access_risk',
              '完整访问可能造成数据丢失或敏感信息泄露。',
            )}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={focusCancel}
            type="button"
            data-testid="full-access-confirm-cancel"
            onClick={onCancel}
            className="min-h-11 md:min-h-9 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="full-access-confirm-submit"
            onClick={() => onConfirm(approval)}
            className={`min-h-11 md:min-h-9 rounded-lg px-4 text-sm font-medium ${approval === 'automatic' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-text-primary text-background hover:bg-text-primary/90'}`}
          >
            {automatic && approval !== 'automatic'
              ? t('common.confirm', '确认')
              : t('workbench.permission_full_access_confirm', '确认启用')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
