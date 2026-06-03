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

export interface AppearanceConfig {
  mode: AppearanceMode
  accentColor: string
  uiFont: string
  codeFont: string
  sidebarTranslucent: boolean
  contrast: number
  light: ThemePalette
  dark: ThemePalette
}

export type AppearanceUpdate = Partial<
  Omit<AppearanceConfig, 'light' | 'dark'>
> & {
  light?: Partial<ThemePalette>
  dark?: Partial<ThemePalette>
}

export interface AppearanceContextValue {
  appearance: AppearanceConfig
  resolvedMode: ResolvedAppearanceMode
  setAppearance: (update: AppearanceUpdate) => void
  resetAppearance: () => void
}
