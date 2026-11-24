import {
  DEFAULT_RUNTIME_PERMISSION_MODE,
  RUNTIME_COMMAND_APPROVAL_MODES,
  type RuntimeCommandApprovalMode,
  type RuntimePermissionMode,
} from '@wegent/chat-core/runtime-permission'
import { Eye, FolderPen, ShieldAlert } from 'lucide-react'
import { useCallback, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CollaborationTranslate } from '../i18n'
import { Button as ControlButton } from '../markdown/Button'
import { useCollaborationPortalTheme } from '../theme'
import { ActionMenu } from './ActionMenu'
import type { ControlDensity } from './recipes'
import { DialogSurface } from './DialogSurface'
import { Radio, RadioGroup, RadioIndicator } from './RadioGroup'

export interface PermissionModeSelectorProps {
  translate: CollaborationTranslate
  value?: RuntimePermissionMode
  commandApproval?: RuntimeCommandApprovalMode
  onCommandApprovalChange?: (mode: RuntimeCommandApprovalMode) => void
  disabled?: boolean
  iconOnly?: boolean
  density?: ControlDensity
  onChange: (mode: RuntimePermissionMode, approval?: RuntimeCommandApprovalMode) => void
}

export function PermissionModeSelector({
  translate: t,
  value = DEFAULT_RUNTIME_PERMISSION_MODE,
  commandApproval = 'manual',
  onCommandApprovalChange,
  disabled = false,
  iconOnly = false,
  density = 'compact',
  onChange,
}: PermissionModeSelectorProps) {
  const [confirmation, setConfirmation] = useState<'full-access' | 'automatic' | null>(null)
  const triggerContainerRef = useRef<HTMLDivElement>(null)
  const restoreTriggerFocus = useCallback(
    () =>
      triggerContainerRef.current?.querySelector<HTMLElement>(
        '[data-testid="permission-mode-menu-button"]'
      ) ?? null,
    []
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
          density={density}
          ariaLabel={ariaLabel}
          testId="permission-mode-menu-button"
          icon={value === 'read-only' ? Eye : value === 'full-access' ? ShieldAlert : FolderPen}
          triggerLabel={iconOnly ? undefined : labels[value]}
          disabled={disabled}
          placement="bottom-end"
          triggerClassName={
            iconOnly
              ? 'flex items-center justify-center rounded-full text-text-secondary transition-colors hover:bg-muted hover:text-text-primary'
              : 'flex max-w-32 items-center gap-1.5 rounded-lg px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary'
          }
          items={[
            ...(['read-only', 'workspace-write', 'full-access'] as const).map(mode => ({
              label: labels[mode],
              checked: value === mode,
              icon: mode === 'read-only' ? Eye : mode === 'full-access' ? ShieldAlert : FolderPen,
              testId: `permission-mode-${mode}`,
              onSelect: () => choose(mode),
              danger: mode === 'full-access',
            })),
            ...(showCommandApproval
              ? [
                  {
                    label: '',
                    separator: true,
                    testId: 'command-approval-separator',
                  },
                  ...RUNTIME_COMMAND_APPROVAL_MODES.map(mode => ({
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
                  initial: confirmation === 'automatic' ? 'automatic' : commandApproval,
                }
              : undefined
          }
          onCancel={() => setConfirmation(null)}
          onConfirm={mode => {
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
  const approvalTitleId = useId()
  const approvalHelp = {
    manual: t('workbench.command_approval_manual_help', '每次由你决定是否执行'),
    ai: t('workbench.command_approval_ai_help', '由 Codex 审核并决定是否执行'),
    automatic: t('workbench.command_approval_automatic_help', '无需逐次确认'),
  }
  const portalTheme = useCollaborationPortalTheme()
  const dialogRef = useRef<HTMLDivElement>(null)
  const cancelButtonRef = useRef<HTMLButtonElement>(null)

  return createPortal(
    <div
      {...portalTheme}
      className={`${portalTheme.className} fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4`}
      data-testid="full-access-confirm-overlay"
    >
      <DialogSurface
        kind="alertdialog"
        initialFocus={() => cancelButtonRef.current}
        finalFocus={restoreFocusTo}
        onClose={onCancel}
        render={
          <div
            ref={dialogRef}
            aria-labelledby="full-access-confirm-title"
            tabIndex={-1}
            className="max-h-[90dvh] w-full max-w-[440px] overflow-y-auto rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-xl"
          />
        }
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-red-500" aria-hidden="true" />
          <h2 id="full-access-confirm-title" className="heading-small">
            {automatic
              ? t('workbench.command_approval_title', '高危命令处理方式')
              : t('workbench.permission_full_access_confirm_title', '启用完整访问？')}
          </h2>
        </div>
        {!automatic && (
          <p className="mt-3 text-sm leading-5 text-text-secondary">
            {t(
              'workbench.permission_full_access_confirm_description',
              'Codex 可以运行命令、访问网络，并读写或删除工作区外的文件。'
            )}
          </p>
        )}
        {commandOptions && (
          <div className="mt-4 min-w-0">
            <p id={approvalTitleId} className={automatic ? 'sr-only' : 'mb-2 text-sm font-medium'}>
              {t('workbench.command_approval_title', '高危命令处理方式')}
            </p>
            <RadioGroup
              aria-labelledby={approvalTitleId}
              value={approval}
              onValueChange={value => {
                const next = RUNTIME_COMMAND_APPROVAL_MODES.find(mode => mode === value)
                if (next) setApproval(next)
              }}
              className="divide-y divide-border overflow-hidden rounded-xl border border-border"
            >
              {RUNTIME_COMMAND_APPROVAL_MODES.map(mode => (
                <Radio
                  key={mode}
                  value={mode}
                  data-testid={`command-approval-confirm-option-${mode}`}
                  className="flex min-h-11 w-full cursor-pointer items-center gap-3 px-3 py-2 text-left outline-none hover:bg-muted/60 data-[checked]:bg-muted/60 keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-inset keyboard:focus-visible:ring-focus/40"
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-border bg-background">
                    <RadioIndicator className="h-2 w-2 rounded-full bg-text-primary" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium">{commandOptions.labels[mode]}</span>
                    <span className="block text-xs text-text-secondary">{approvalHelp[mode]}</span>
                  </span>
                </Radio>
              ))}
            </RadioGroup>
          </div>
        )}
        {approval === 'automatic' && (
          <p className="mt-3 text-sm leading-5 text-text-secondary">
            {t(
              'workbench.command_approval_confirm_description',
              'Codex 识别出的高危命令（例如强制删除文件）可以直接运行，可能造成不可恢复的数据丢失。'
            )}
          </p>
        )}
        {!automatic && approval !== 'automatic' && (
          <p className="mt-3 text-xs leading-5 text-text-secondary">
            {t('workbench.permission_full_access_risk', '完整访问可能造成数据丢失或敏感信息泄露。')}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <ControlButton
            variant="outline"
            size="sm"
            ref={cancelButtonRef}
            type="button"
            data-testid="full-access-confirm-cancel"
            onClick={onCancel}
            className="min-h-11 md:min-h-9 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted"
          >
            {t('common.cancel', '取消')}
          </ControlButton>
          <ControlButton
            variant="destructive"
            size="sm"
            type="button"
            data-testid="full-access-confirm-submit"
            onClick={() => onConfirm(approval)}
            className={`min-h-11 md:min-h-9 rounded-lg px-4 text-sm font-medium ${approval === 'automatic' ? 'bg-red-600 text-white hover:bg-red-700' : 'bg-text-primary text-background hover:bg-text-primary/90'}`}
          >
            {automatic && approval !== 'automatic'
              ? t('common.confirm', '确认')
              : t('workbench.permission_full_access_confirm', '确认启用')}
          </ControlButton>
        </div>
      </DialogSurface>
    </div>,
    document.body
  )
}
