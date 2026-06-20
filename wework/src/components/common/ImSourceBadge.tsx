import { useTranslation } from '@/hooks/useTranslation'
import { getTrimmedString, isIMSource, isRecord, type ImSourceLike } from '@/lib/im-source'
import { cn } from '@/lib/utils'

interface ImSourceBadgeProps {
  source: ImSourceLike
  className?: string
  testId?: string
}

const CHANNEL_LABEL_KEYS: Record<string, string> = {
  dingtalk: 'workbench.im_channel_dingtalk',
  telegram: 'workbench.im_channel_telegram',
  discord: 'workbench.im_channel_discord',
}

export function ImSourceBadge({ source, className, testId }: ImSourceBadgeProps) {
  const { t } = useTranslation('common')

  if (!isIMSource(source)) return null

  const channelLabel = isRecord(source) ? getTrimmedString(source.channel_label) : undefined
  const channelType = isRecord(source)
    ? getTrimmedString(source.channel_type)?.toLowerCase()
    : undefined
  const labelKey = channelType ? CHANNEL_LABEL_KEYS[channelType] : undefined
  const label = channelLabel ?? (labelKey ? t(labelKey) : t('workbench.im_source_label'))

  return (
    <span
      data-testid={testId}
      className={cn(
        'inline-flex h-5 max-w-[72px] shrink-0 items-center rounded border border-border/70 bg-surface px-1.5 text-[10px] font-medium leading-none text-text-muted',
        className
      )}
      title={label}
    >
      <span className="truncate">{label}</span>
    </span>
  )
}
