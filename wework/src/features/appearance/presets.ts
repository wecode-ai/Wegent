import type { AppearanceConfig, ThemePalette } from './types'
import { DEFAULT_CODE_FONT_SIZE, DEFAULT_UI_FONT_SIZE } from './typography'

export const DEFAULT_ACCENT_COLOR = '#2563eb'

export const lightPalette: ThemePalette = {
  bgBase: '255 255 255',
  bgSurface: '247 247 248',
  bgMuted: '245 245 245',
  bgHover: '37 99 235 / 0.08',
  sidebar: '229 229 231 / 0.72',
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
  bgBase: '17 19 22',
  bgSurface: '28 31 36',
  bgMuted: '38 42 48',
  bgHover: '96 165 250 / 0.12',
  sidebar: '31 35 41 / 0.82',
  sidebarActive: '52 58 66',
  sidebarHover: '255 255 255 / 0.08',
  sidebarTextPrimary: '232 238 246',
  sidebarTextSecondary: '181 191 205',
  sidebarTextMuted: '126 138 153',
  mobileDrawer: '24 39 58',
  border: '55 61 70',
  textPrimary: '241 245 249',
  textSecondary: '203 213 225',
  textMuted: '148 163 184',
  primary: '96 165 250',
  primaryContrast: '11 18 20',
  popover: '28 31 36',
  codeBg: '15 23 42',
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
  light: lightPalette,
  dark: darkPalette,
}
