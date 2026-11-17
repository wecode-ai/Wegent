import { useEffect, type ReactNode } from 'react'

import type { Context } from '@deepseek-ai/cordis'

import { DshClientContext } from './DshClientContext'
import i18n from '@/i18n'

interface DshLocaleService {
  getSnapshot(): { active: string }
  setLocale(language: 'en' | 'zh'): void
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
    const synchronize = (language: string) => {
      try {
        const locale = context.get('locale') as DshLocaleService | undefined
        if (!locale) return
        // DSH's Chinese catalog is `zh`; Wework's interface preference is `zh-CN`.
        const target = language.toLowerCase().startsWith('en') ? 'en' : 'zh'
        if (locale.getSnapshot().active !== target) locale.setLocale(target)
      } catch (error) {
        console.error('[Wework] Failed to synchronize DSH interface language:', error)
      }
    }
    i18n.on('languageChanged', synchronize)
    synchronize(i18n.resolvedLanguage ?? i18n.language)
    return () => {
      i18n.off('languageChanged', synchronize)
    }
  }, [context])

  return <DshClientContext.Provider value={context}>{children}</DshClientContext.Provider>
}
