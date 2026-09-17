import type { ReactNode } from 'react'
import { useMemo } from 'react'
import { ConversationTranslationProvider } from '@wegent/collaboration/conversation'
import { createCollaborationTranslator } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'

export function DesktopConversationTranslation({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation('chat')
  const locale = i18n.language.startsWith('zh') ? 'zh-CN' : 'en'
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  return (
    <ConversationTranslationProvider translate={translate}>
      {children}
    </ConversationTranslationProvider>
  )
}
