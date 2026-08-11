import { Check, Eye, FolderPen, Globe2, ShieldAlert, TerminalSquare } from 'lucide-react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useEscapeKey } from '@/hooks/useEscapeKey'
import { useTranslation } from '@/hooks/useTranslation'
import {
  DEFAULT_RUNTIME_PERMISSION_MODE,
  type RuntimePermissionMode,
} from '@/features/workbench/runtimePermissionMode'

interface PermissionModeSelectorProps {
  value?: RuntimePermissionMode
  disabled?: boolean
  onChange: (mode: RuntimePermissionMode) => void
}

export function PermissionModeSelector({
  value = DEFAULT_RUNTIME_PERMISSION_MODE,
  disabled = false,
  onChange,
}: PermissionModeSelectorProps) {
  const { t } = useTranslation('common')
  const [confirmFullAccess, setConfirmFullAccess] = useState(false)
  const labels: Record<RuntimePermissionMode, string> = {
    'read-only': t('workbench.permission_mode_read_only', '只读'),
    'workspace-write': t('workbench.permission_mode_workspace', '工作区'),
    'full-access': t('workbench.permission_mode_full_access', '完整访问'),
  }

  const choose = (mode: RuntimePermissionMode) => {
    if (mode === 'full-access' && value !== 'full-access') {
      setConfirmFullAccess(true)
      return
    }
    onChange(mode)
  }

  return (
    <>
      <ActionMenu
        ariaLabel={t('workbench.permission_mode', '权限模式')}
        testId="permission-mode-menu-button"
        icon={value === 'read-only' ? Eye : value === 'full-access' ? ShieldAlert : FolderPen}
        triggerLabel={labels[value]}
        disabled={disabled}
        placement="bottom-end"
        triggerClassName="flex h-8 max-w-32 items-center gap-1.5 rounded-lg px-2 text-xs text-text-secondary transition-colors hover:bg-muted hover:text-text-primary"
        items={(['read-only', 'workspace-write', 'full-access'] as const).map(mode => ({
          label: (
            <span className="flex min-w-0 flex-1 items-center justify-between gap-3">
              <span>{labels[mode]}</span>
              {value === mode ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : null}
            </span>
          ),
          icon: mode === 'read-only' ? Eye : mode === 'full-access' ? ShieldAlert : FolderPen,
          testId: `permission-mode-${mode}`,
          onSelect: () => choose(mode),
          danger: mode === 'full-access',
        }))}
      />
      {confirmFullAccess ? (
        <FullAccessConfirmDialog
          onCancel={() => setConfirmFullAccess(false)}
          onConfirm={() => {
            onChange('full-access')
            setConfirmFullAccess(false)
          }}
        />
      ) : null}
    </>
  )
}

function FullAccessConfirmDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void
  onConfirm: () => void
}) {
  const { t } = useTranslation('common')
  useEscapeKey(onCancel)

  return createPortal(
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
      data-testid="full-access-confirm-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="full-access-confirm-title"
        className="w-full max-w-[480px] rounded-2xl border border-border bg-popover p-5 text-text-primary shadow-xl"
      >
        <div className="flex items-center gap-2">
          <ShieldAlert className="h-5 w-5 text-red-500" aria-hidden="true" />
          <h2 id="full-access-confirm-title" className="heading-small">
            {t('workbench.permission_full_access_confirm_title', '启用完整访问？')}
          </h2>
        </div>
        <p className="mt-3 text-sm leading-5 text-text-secondary">
          {t(
            'workbench.permission_full_access_confirm_description',
            'Codex 将无需询问即可运行命令、访问网络，并读取、创建、修改或删除这台电脑任意位置的文件。'
          )}
        </p>
        <div className="mt-4 space-y-3 rounded-xl bg-muted/60 p-3">
          <Capability
            icon={FolderPen}
            title={t('workbench.permission_full_access_files', '文件和文件夹')}
            description={t(
              'workbench.permission_full_access_files_description',
              '访问工作区之外的文件，并可创建、修改或删除它们'
            )}
          />
          <Capability
            icon={TerminalSquare}
            title={t('workbench.permission_full_access_terminal', '终端命令')}
            description={t(
              'workbench.permission_full_access_terminal_description',
              '运行命令、安装软件和更改系统设置'
            )}
          />
          <Capability
            icon={Globe2}
            title={t('workbench.permission_full_access_network', '互联网和连接的应用')}
            description={t(
              'workbench.permission_full_access_network_description',
              '访问网站、发送数据并使用已启用的连接器'
            )}
          />
        </div>
        <p className="mt-4 text-xs leading-5 text-text-muted">
          {t(
            'workbench.permission_full_access_risk',
            '这会显著增加数据丢失、敏感信息泄露、提示词注入和意外操作的风险。'
          )}
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <button
            type="button"
            data-testid="full-access-confirm-cancel"
            onClick={onCancel}
            className="h-9 rounded-lg border border-border px-4 text-sm font-medium hover:bg-muted"
          >
            {t('common.cancel', '取消')}
          </button>
          <button
            type="button"
            data-testid="full-access-confirm-submit"
            onClick={onConfirm}
            className="h-9 rounded-lg bg-red-600 px-4 text-sm font-medium text-white hover:bg-red-700"
          >
            {t('workbench.permission_full_access_confirm', '确认启用')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Capability({
  icon: Icon,
  title,
  description,
}: {
  icon: typeof FolderPen
  title: string
  description: string
}) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-0.5 h-5 w-5 shrink-0 text-text-secondary" aria-hidden="true" />
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs leading-5 text-text-muted">{description}</div>
      </div>
    </div>
  )
}
