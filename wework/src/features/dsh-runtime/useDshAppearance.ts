import { useEffect } from 'react'
import type { AppearanceMode } from '@/features/appearance/types'
import { useDshClientContext } from './DshClientContext'

interface DshThemeService {
  getTheme(): { preference: AppearanceMode }
  setTheme(mode: AppearanceMode): void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'theme/change'(): void
  }
}

/** Keep the SDK presenter on the workbench's persisted appearance preference. */
export function useDshAppearance(mode: AppearanceMode) {
  const context = useDshClientContext()
  useEffect(() => {
    if (!context) return
    const synchronize = () => {
      try {
        const theme = context.get('theme') as DshThemeService | undefined
        if (theme && theme.getTheme().preference !== mode) theme.setTheme(mode)
      } catch (error) {
        console.error('[Wework] Failed to synchronize DSH appearance:', error)
      }
    }
    // Durable SDK settings can arrive after the host preference was applied.
    const dispose = context.on('theme/change', synchronize)
    synchronize()
    return () => {
      dispose()
    }
  }, [context, mode])
}
