// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ThemeConfig } from 'antd'
import { theme as antdTheme } from 'antd'

export type ThemeMode = 'light' | 'dark'

export type ThemePalette = {
  appBackground: string
  surfaceBackground: string
  interactiveBackground: string
  border: string
  borderStrong: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  primary: string
  primaryContrast: string
  controlOutline: string
  success: string
  danger: string
  warning: string
}

export const themePalettes: Record<ThemeMode, ThemePalette> = {
  light: {
    appBackground: '#f5f7fb',
    surfaceBackground: '#ffffff',
    interactiveBackground: '#eef2ff',
    border: '#e5e7eb',
    borderStrong: '#cbd5f5',
    textPrimary: '#1f2329',
    textSecondary: '#6b7280',
    textMuted: '#9ca3af',
    primary: '#3b82f6',
    primaryContrast: '#ffffff',
    controlOutline: 'rgba(59, 130, 246, 0.2)',
    success: '#12b76a',
    danger: '#f97066',
    warning: '#f79009',
  },
  dark: {
    appBackground: '#0d1117',
    surfaceBackground: '#161b22',
    interactiveBackground: '#21262d',
    border: '#30363d',
    borderStrong: '#30363d',
    textPrimary: '#f0f6fc',
    textSecondary: '#9ca3af',
    textMuted: '#8b949e',
    primary: 'rgb(112,167,215)',
    primaryContrast: '#0d1117',
    controlOutline: 'rgba(112, 167, 215, 0.3)',
    success: '#56d364',
    danger: '#f85149',
    warning: '#d29922',
  },
}

const sharedToken = {
  fontSize: 12,
  controlHeight: 34,
  borderRadius: 6,
}

const createComponentTokens = (mode: ThemeMode, palette: ThemePalette): ThemeConfig['components'] => {
  const isDark = mode === 'dark'

  return {
    Select: {
      selectorBg: palette.surfaceBackground,
      clearBg: palette.surfaceBackground,
      optionSelectedBg: isDark ? palette.interactiveBackground : '#e0e7ff',
      optionActiveBg: palette.interactiveBackground,
      controlItemBgHover: isDark ? palette.interactiveBackground : '#eef2ff',
      multipleItemBg: palette.interactiveBackground,
      hoverBorderColor: palette.borderStrong,
      activeBorderColor: isDark ? palette.borderStrong : palette.primary,
      activeOutlineColor: isDark ? palette.borderStrong : palette.controlOutline,
      multipleItemBorderColor: palette.border,
      multipleItemBorderColorDisabled: 'disabled',
    },
    Radio: {
      buttonBg: palette.surfaceBackground,
      buttonCheckedBg: palette.primary,
      buttonColor: palette.textPrimary,
      buttonSolidCheckedColor: palette.primaryContrast,
      buttonSolidCheckedHoverBg: palette.primary,
      buttonSolidCheckedActiveBg: palette.primary,
    },
    Button: {
      defaultBg: isDark ? palette.interactiveBackground : '#f3f4f6',
      defaultColor: palette.textPrimary,
      defaultBorderColor: palette.border,
      defaultHoverBg: isDark ? palette.border : '#e5e7eb',
      defaultHoverColor: palette.textPrimary,
      defaultHoverBorderColor: isDark ? palette.borderStrong : palette.borderStrong,
      defaultActiveBg: isDark ? palette.border : '#dbeafe',
      defaultActiveColor: palette.textPrimary,
      defaultActiveBorderColor: palette.borderStrong,
      primaryColor: palette.primaryContrast,
      dangerColor: palette.primaryContrast,
      borderColorDisabled: palette.border,
      ghostBg: 'transparent',
      defaultGhostColor: palette.textPrimary,
      defaultGhostBorderColor: palette.border,
      solidTextColor: palette.primaryContrast,
      textTextColor: palette.textPrimary,
      textTextHoverColor: palette.textPrimary,
      textTextActiveColor: palette.textPrimary,
      paddingInline: 12,
      paddingInlineLG: 16,
      paddingInlineSM: 8,
      paddingBlock: 4,
      paddingBlockLG: 6,
      paddingBlockSM: 2,
      linkHoverBg: 'transparent',
      textHoverBg: isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(59, 130, 246, 0.08)',
      contentFontSize: 14,
      contentFontSizeLG: 16,
      contentFontSizeSM: 12,
    },
  }
}

const createThemeConfig = (mode: ThemeMode, palette: ThemePalette): ThemeConfig => {
  const algorithm = mode === 'dark' ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm

  return {
    algorithm,
    token: {
      ...sharedToken,
      colorBgBase: palette.appBackground,
      colorBgContainer: palette.surfaceBackground,
      colorBorder: palette.border,
      colorBorderSecondary: palette.borderStrong,
      colorText: palette.textPrimary,
      colorTextBase: palette.textPrimary,
      colorTextDescription: palette.textSecondary,
      colorTextHeading: palette.textPrimary,
      colorTextPlaceholder: palette.textMuted,
      colorPrimary: palette.primary,
      controlOutline: palette.controlOutline,
      colorSuccess: palette.success,
      colorError: palette.danger,
      colorWarning: palette.warning,
    },
    components: createComponentTokens(mode, palette),
  }
}

export const antdThemes: Record<ThemeMode, ThemeConfig> = {
  light: createThemeConfig('light', themePalettes.light),
  dark: createThemeConfig('dark', themePalettes.dark),
}
