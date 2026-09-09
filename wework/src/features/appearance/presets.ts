import type { AppearanceConfig, ThemePalette, WorkbenchBackgroundConfig } from './types'
import { DEFAULT_CODE_FONT_SIZE, DEFAULT_UI_FONT_SIZE } from './typography'

export const DEFAULT_ACCENT_COLOR = '#2563eb'

export const lightPalette: ThemePalette = {
  bgBase: '255 255 255',
  bgSurface: '247 247 248',
  bgMuted: '245 245 245',
  bgHover: '37 99 235 / 0.08',
  sidebar: '246 246 246 / 0.88',
  sidebarActive: '222 223 226',
  sidebarHover: '255 255 255 / 0.7',
  sidebarTextPrimary: '36 40 45',
  sidebarTextSecondary: '82 89 98',
  sidebarTextMuted: '136 143 152',
  mobileDrawer: '238 242 247',
  border: '224 224 224',
  textPrimary: '26 26 26',
  textSecondary: '96 99 104',
  textMuted: '138 143 152',
  primary: '37 99 235',
  primaryContrast: '255 255 255',
  popover: '255 255 255',
  codeBg: '243 244 246',
}

export const darkPalette: ThemePalette = {
  bgBase: '24 24 24',
  bgSurface: '33 33 33',
  bgMuted: '48 48 48',
  bgHover: '255 255 255 / 0.07',
  sidebar: '33 33 33 / 0.92',
  sidebarActive: '255 255 255 / 0.1',
  sidebarHover: '255 255 255 / 0.06',
  sidebarTextPrimary: '242 242 242',
  sidebarTextSecondary: '179 179 179',
  sidebarTextMuted: '128 128 128',
  mobileDrawer: '33 33 33',
  border: '43 43 43',
  textPrimary: '255 255 255',
  textSecondary: '179 179 179',
  textMuted: '128 128 128',
  primary: '37 99 235',
  primaryContrast: '255 255 255',
  popover: '40 40 40',
  codeBg: '33 33 33',
}

const defaultBackground: WorkbenchBackgroundConfig = {
  imagePath: null,
  visibility: 24,
  blur: 0,
  inMain: true,
  inSidebar: true,
  inTopBar: true,
}

export const defaultAppearance: AppearanceConfig = {
  mode: 'system',
  accentColor: DEFAULT_ACCENT_COLOR,
  uiFont:
    "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif",
  codeFont: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  sidebarTranslucent: true,
  contrast: 50,
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
  light: lightPalette,
  dark: darkPalette,
}
