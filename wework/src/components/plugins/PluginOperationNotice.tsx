import { useTranslation } from '@/hooks/useTranslation'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { AlertCircle, Check, Loader2, X } from 'lucide-react'

export type PluginOperationNoticeState = {
  id: string
  kind: 'authorization' | 'progress' | 'success' | 'error'
  message: string
  iconUrl?: string | null
  actionLabel?: string
  onAction?: () => void
}

export function PluginOperationNotice({
  notice,
  onDismiss,
}: {
  notice: PluginOperationNoticeState
  onDismiss: () => void
}) {
  const { t } = useTranslation('common')

  return (
    <div
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid="plugin-operation-notice"
      data-notice-kind={notice.kind}
      className={`electron-titlebar-interactive-region plugin-operation-notice plugin-operation-notice-${notice.kind}`}
    >
      <span className="plugin-operation-notice-icon" aria-hidden="true">
        {notice.iconUrl ? (
          <img src={notice.iconUrl} alt="" />
        ) : notice.kind === 'authorization' || notice.kind === 'progress' ? (
          <Loader2 className="animate-spin" />
        ) : notice.kind === 'success' ? (
          <Check />
        ) : (
          <AlertCircle />
        )}
      </span>
      <span className="min-w-0 flex-1 break-words text-sm font-medium leading-5">
        {notice.message}
      </span>
      {notice.actionLabel && notice.onAction ? (
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="plugin-operation-notice-action"
          className="plugin-operation-notice-action"
          onClick={notice.onAction}
        >
          {notice.actionLabel}
        </ControlButton>
      ) : null}
      <ControlButton
        variant="unstyled"
        type="button"
        data-testid="plugin-operation-notice-dismiss"
        className="plugin-operation-notice-dismiss"
        aria-label={t('workbench.plugins_dismiss_notice', '关闭提示')}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </ControlButton>
    </div>
  )
}
