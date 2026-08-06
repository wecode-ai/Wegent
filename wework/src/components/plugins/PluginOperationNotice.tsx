import { AlertCircle, Check, Loader2, X } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'

export type PluginOperationNoticeState = {
  id: string
  kind: 'authorization' | 'success' | 'error'
  message: string
  iconUrl?: string | null
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
      className={`plugin-operation-notice plugin-operation-notice-${notice.kind}`}
    >
      <span className="plugin-operation-notice-icon" aria-hidden="true">
        {notice.iconUrl ? (
          <img src={notice.iconUrl} alt="" />
        ) : notice.kind === 'authorization' ? (
          <Loader2 className="animate-spin" />
        ) : notice.kind === 'success' ? (
          <Check />
        ) : (
          <AlertCircle />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{notice.message}</span>
      <button
        type="button"
        data-testid="plugin-operation-notice-dismiss"
        className="plugin-operation-notice-dismiss"
        aria-label={t('workbench.plugins_dismiss_notice', '关闭提示')}
        onClick={onDismiss}
      >
        <X aria-hidden="true" />
      </button>
    </div>
  )
}
