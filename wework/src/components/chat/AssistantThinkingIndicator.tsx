import { useTranslation } from '@/hooks/useTranslation'

export function AssistantThinkingIndicator() {
  const { t } = useTranslation('chat')

  return (
    <div className="inline-flex items-center text-[13px]" data-testid="thinking-indicator">
      <span className="waiting-thinking-text">{t('thinking.running')}</span>
    </div>
  )
}
