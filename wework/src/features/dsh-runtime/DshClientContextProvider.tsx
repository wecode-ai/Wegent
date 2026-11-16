import { useEffect, type ReactNode } from 'react'

import type { Context } from '@deepseek-ai/cordis'

import { DshClientContext } from './DshClientContext'
import i18n from '@/i18n'

interface DshLocaleService {
  getSnapshot(): { active: string }
  setLocale(locale: string): void
  subscribe(listener: () => void): () => void
}

export function DshClientContextProvider({
  children,
  context,
}: {
  children: ReactNode
  context: Context | null
}) {
  useEffect(() => {
    if (!context) return
    const binding = context.inject(['locale'], owner => {
      const locale = owner.get('locale') as DshLocaleService
      owner.effect(() => {
        // Wework owns the preference; official DSH components keep their dictionaries.
        const sync = () => {
          const language = (i18n.resolvedLanguage || i18n.language).startsWith('zh') ? 'zh' : 'en'
          if (locale.getSnapshot().active !== language) locale.setLocale(language)
        }
        const unsubscribe = locale.subscribe(sync)
        i18n.on('languageChanged', sync)
        sync()
        return () => {
          unsubscribe()
          i18n.off('languageChanged', sync)
        }
      }, 'wework: synchronize official UI language')
    })
    return () => {
      void binding.dispose()
    }
  }, [context])
  return <DshClientContext.Provider value={context}>{children}</DshClientContext.Provider>
}
