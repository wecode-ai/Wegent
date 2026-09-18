import type { AppearanceConfig, WorkbenchBackgroundConfig } from './types'
import { defaultThemeAppearance } from '@wegent/collaboration/theme'
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
