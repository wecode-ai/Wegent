import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { ActivityShimmerText } from './ActivityShimmerText'

const THINKING_PREVIEW_MAX_LENGTH = 96

export function AssistantThinkingIndicator({
  content = '',
  testId = 'thinking-indicator',
  className,
}: {
  content?: string
  testId?: string
  className?: string
}) {
  const { t } = useTranslation('chat')
  const preview = buildThinkingPreview(content)
  const text = preview ? `${t('thinking.running')} · ${preview}` : t('thinking.running')

  return (
    <div
      className={cn('inline-flex min-w-0 max-w-full items-center text-chat', className)}
      data-testid={testId}
    >
      <ActivityShimmerText variant="thinking" className="min-w-0 truncate">
        {text}
      </ActivityShimmerText>
    </div>
  )
}

function buildThinkingPreview(content: string): string {
  const normalized = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/[#>*_[\]()-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  if (!normalized) return ''

  const segments = normalized
    .split(/[。！？!?]+|\.(?=\s|$)/)
    .map(segment => segment.trim())
    .filter(Boolean)
  const preview = segments[segments.length - 1] ?? normalized

  return preview.length <= THINKING_PREVIEW_MAX_LENGTH
    ? preview
    : `${preview.substring(0, THINKING_PREVIEW_MAX_LENGTH - 3)}...`
}
