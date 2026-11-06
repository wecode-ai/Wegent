import type {
  AppearanceMode,
  ResolvedAppearanceMode,
  ThemePalette,
  ThemeAppearance,
} from '@wegent/collaboration/theme'
export type {
  AppearanceMode,
  ResolvedAppearanceMode,
  ThemePalette,
} from '@wegent/collaboration/theme'

export interface WorkbenchBackgroundConfig {
  imagePath: string | null
  visibility: number
  blur: number
  inMain: boolean
  inSidebar: boolean
  inTopBar: boolean
}

export interface AppearanceConfig extends ThemeAppearance {
  schemaVersion: 2
  lightThemeId: string
  darkThemeId: string
  themeOverrides: Record<ResolvedAppearanceMode, AppearanceThemeOverrides>
  mode: AppearanceMode
  sidebarTranslucent: boolean
  backgroundImagePath: string | null
  separateBackgroundsByTheme: boolean
  themeBackgroundsInitialized: boolean
  backgroundVisibility: number
  backgroundBlur: number
  backgroundInMain: boolean
  backgroundInSidebar: boolean
  backgroundInTopBar: boolean
  lightBackground: WorkbenchBackgroundConfig
  darkBackground: WorkbenchBackgroundConfig
}

export interface AppearanceThemeOverrides {
  accentColor?: string
  palette?: Partial<ThemePalette>
}

export type AppearanceUpdate = Partial<
  Omit<AppearanceConfig, 'light' | 'dark' | 'lightBackground' | 'darkBackground' | 'themeOverrides'>
> & {
  light?: Partial<ThemePalette>
  dark?: Partial<ThemePalette>
  lightBackground?: Partial<WorkbenchBackgroundConfig>
  darkBackground?: Partial<WorkbenchBackgroundConfig>
  themeOverrides?: Partial<Record<ResolvedAppearanceMode, AppearanceThemeOverrides>>
}

export interface AppearanceContextValue {
  appearance: AppearanceConfig
  resolvedMode: ResolvedAppearanceMode
  setAppearance: (update: AppearanceUpdate) => void
  resetAppearance: () => void
}
