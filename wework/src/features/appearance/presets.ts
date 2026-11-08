import type { AppearanceConfig, WorkbenchBackgroundConfig } from './types'
import { DEFAULT_UI_THEME_ID, defaultThemeAppearance } from '@wegent/collaboration/theme'
export { DEFAULT_ACCENT_COLOR, lightPalette, darkPalette } from '@wegent/collaboration/theme'

const defaultBackground: WorkbenchBackgroundConfig = {
  imagePath: null,
  visibility: 24,
  blur: 0,
  inMain: true,
  inSidebar: true,
  inTopBar: true,
}

export const defaultAppearance: AppearanceConfig = {
  ...defaultThemeAppearance,
  schemaVersion: 2,
  lightThemeId: DEFAULT_UI_THEME_ID,
  darkThemeId: DEFAULT_UI_THEME_ID,
  themeOverrides: { light: {}, dark: {} },
  mode: 'system',
  sidebarTranslucent: true,
  backgroundImagePath: null,
  separateBackgroundsByTheme: false,
  themeBackgroundsInitialized: false,
  backgroundVisibility: 24,
  backgroundBlur: 0,
  backgroundInMain: true,
  backgroundInSidebar: true,
  backgroundInTopBar: true,
  lightBackground: { ...defaultBackground },
  darkBackground: { ...defaultBackground },
}
