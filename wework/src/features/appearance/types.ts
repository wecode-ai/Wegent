export type AppearanceMode = 'light' | 'dark' | 'system'
export type ResolvedAppearanceMode = 'light' | 'dark'

export interface ThemePalette {
  bgBase: string
  bgSurface: string
  bgMuted: string
  bgHover: string
  sidebar: string
  sidebarActive: string
  sidebarHover: string
  sidebarTextPrimary: string
  sidebarTextSecondary: string
  sidebarTextMuted: string
  mobileDrawer: string
  border: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  primary: string
  primaryContrast: string
  popover: string
  codeBg: string
}

export interface WorkbenchBackgroundConfig {
  imagePath: string | null
  visibility: number
  blur: number
  inMain: boolean
  inSidebar: boolean
  inTopBar: boolean
}

export interface AppearanceConfig {
  mode: AppearanceMode
  accentColor: string
  uiFont: string
  codeFont: string
  uiFontSize: number
  codeFontSize: number
  sidebarTranslucent: boolean
  contrast: number
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
  light: ThemePalette
  dark: ThemePalette
}

export type AppearanceUpdate = Partial<
  Omit<AppearanceConfig, 'light' | 'dark' | 'lightBackground' | 'darkBackground'>
> & {
  light?: Partial<ThemePalette>
  dark?: Partial<ThemePalette>
  lightBackground?: Partial<WorkbenchBackgroundConfig>
  darkBackground?: Partial<WorkbenchBackgroundConfig>
}

export interface AppearanceContextValue {
  appearance: AppearanceConfig
  resolvedMode: ResolvedAppearanceMode
  setAppearance: (update: AppearanceUpdate) => void
  resetAppearance: () => void
}
