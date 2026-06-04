import type { Team } from '@/types/api'
import type { QuickLaunchInputOptions } from '@/types/api'
import type { TeamTargetPage } from '../../selector/team-selector-utils'

export type QuickLauncherKind = 'system_function' | 'favorite_agent'

export interface QuickInputPreset {
  id: string
  title: string
  prompt?: string | null
  options?: QuickLaunchInputOptions | null
}

export interface QuickLauncher {
  key: string
  type: QuickLauncherKind
  title: string
  description?: string | null
  icon?: string | null
  team: Team
  targetPage: TeamTargetPage
  inputPresets: QuickInputPreset[]
}

export interface QuickPresetSelection {
  launcher: QuickLauncher
  preset: QuickInputPreset
}
