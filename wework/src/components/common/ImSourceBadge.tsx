import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

type ImSourceRecord = {
  source?: unknown
  channel_label?: unknown
  channel_type?: unknown
}

type ImSourceLike = string | ImSourceRecord | null | undefined

interface ImSourceBadgeProps {
  source: ImSourceLike
  className?: string
  testId?: string
}

const CHANNEL_LABEL_KEYS: Record<string, string> = {
  dingtalk: 'workbench.im_channel_dingtalk',
  telegram: 'workbench.im_channel_telegram',
}

function isRecord(value: unknown): value is ImSourceRecord {
  return typeof value === 'object' && value !== null
}

function getTrimmedString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isIMSource(source: ImSourceLike): boolean {
  if (typeof source === 'string') return source === 'im'
  return isRecord(source) && source.source === 'im'
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
