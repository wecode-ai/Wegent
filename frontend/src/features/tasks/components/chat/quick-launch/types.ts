import type { Team } from '@/types/api'

export type QuickLauncherKind = 'system_function' | 'favorite_agent'

export interface QuickLauncher {
  key: string
  type: QuickLauncherKind
  title: string
  description?: string | null
  icon?: string | null
  team: Team
  quickPhrases: string[]
}
