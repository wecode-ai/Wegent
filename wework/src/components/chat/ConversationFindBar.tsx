import { ContentFindBar } from '@/components/common/ContentFindBar'
import { useTranslation } from '@/hooks/useTranslation'
import type { useConversationFind } from './useConversationFind'

export function ConversationFindBar({ find }: { find: ReturnType<typeof useConversationFind> }) {
  const { t } = useTranslation('chat')
  if (!find.open) return null
  return (
    <ContentFindBar
      query={find.query}
      result={find.result}
      unavailable={false}
      isLoading={find.isLoading}
      focusRequest={find.focusRequest}
      inputLabel={t('search.label')}
      placeholder={t('search.placeholder')}
      testIdPrefix="conversation-find"
      statusLabel={
        find.failure
          ? t(`search.${find.failure}_failed`)
          : find.historyLoading
            ? t('search.loading')
            : undefined
      }
      onQueryChange={find.changeQuery}
      onStep={find.step}
      onEnter={find.submit}
      onClose={find.close}
      onRetry={find.failure ? find.retry : undefined}
    />
  )
}
