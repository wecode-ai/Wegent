// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { ConfigProvider, App as AntdApp } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { theme } from 'antd'
import { useTheme, ThemeMode } from '@/features/theme/ThemeProvider'

type ThemeConfig = {
  algorithm: typeof theme.defaultAlgorithm
  token: Record<string, unknown>
  components: Record<string, Record<string, unknown>>
}

const sharedTokens = {
  fontSize: 12,
  controlHeight: 34,
  borderRadius: 6,
}

const themeConfigs: Record<ThemeMode, ThemeConfig> = {
  dark: {
    algorithm: theme.darkAlgorithm,
    token: {
      ...sharedTokens,
      colorBgBase: '#0d1117',
      colorBorder: '#30363d',
      colorPrimary: 'rgb(112,167,215)',
      colorBgContainer: '#161b22',
      colorText: '#f0f6fc',
      colorTextPlaceholder: '#9ca3af',
      controlOutline: 'rgba(112, 167, 215, 0.3)',
    },
    components: {
      Select: {
        selectorBg: '#0d1117',
        clearBg: '#0d1117',
        optionSelectedBg: '#21262d',
        optionActiveBg: '#21262d',
        controlItemBgHover: '#21262d',
        multipleItemBg: '#21262d',
        hoverBorderColor: '#30363d',
        activeBorderColor: '#30363d',
        activeOutlineColor: '#30363d',
        multipleItemBorderColor: '#30363d',
        multipleItemBorderColorDisabled: 'disabled',
      },
      Radio: {
        buttonBg: '#0d1117',
        buttonCheckedBg: 'rgb(112,167,215)',
        buttonColor: '#f0f6fc',
        buttonSolidCheckedColor: '#0d1117',
        buttonSolidCheckedHoverBg: 'rgb(112,167,215)',
        buttonSolidCheckedActiveBg: 'rgb(112,167,215)',
      },
      Button: {
        defaultBg: '#21262d',
        defaultColor: '#f0f6fc',
        defaultBorderColor: '#30363d',
        defaultHoverBg: '#30363d',
        defaultHoverColor: '#f0f6fc',
        defaultHoverBorderColor: '#8b949e',
        defaultActiveBg: '#30363d',
        defaultActiveColor: '#f0f6fc',
        defaultActiveBorderColor: '#8b949e',
        primaryColor: '#f0f6fc',
        dangerColor: '#ffffff',
        borderColorDisabled: '#30363d',
        ghostBg: 'transparent',
        defaultGhostColor: '#f0f6fc',
        defaultGhostBorderColor: '#30363d',
        solidTextColor: '#0d1117',
        textTextColor: '#f0f6fc',
        textTextHoverColor: '#f0f6fc',
        textTextActiveColor: '#f0f6fc',
        paddingInline: 12,
        paddingInlineLG: 16,
        paddingInlineSM: 8,
        paddingBlock: 4,
        paddingBlockLG: 6,
        paddingBlockSM: 2,
        linkHoverBg: 'transparent',
        textHoverBg: 'rgba(255, 255, 255, 0.08)',
        contentFontSize: 14,
        contentFontSizeLG: 16,
        contentFontSizeSM: 12,
      },
      Tooltip: {
        colorBgSpotlight: '#161b22',
        colorTextLightSolid: '#f0f6fc',
        borderRadius: 6,
        boxShadowSecondary: '0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05)',
      },
    },
  },
  light: {
    algorithm: theme.defaultAlgorithm,
    token: {
      ...sharedTokens,
      colorBgBase: '#ffffff',
      colorBorder: '#d1d5db',
      colorPrimary: '#2563eb',
      colorBgContainer: '#f8fafc',
      colorText: '#0f172a',
      colorTextPlaceholder: '#6b7280',
      controlOutline: 'rgba(37, 99, 235, 0.3)',
    },
    components: {
      Select: {
        selectorBg: '#ffffff',
        clearBg: '#ffffff',
        optionSelectedBg: '#e0e7ff',
        optionActiveBg: '#dbeafe',
        controlItemBgHover: '#f1f5f9',
        multipleItemBg: '#e2e8f0',
        hoverBorderColor: '#60a5fa',
        activeBorderColor: '#2563eb',
        activeOutlineColor: 'rgba(37, 99, 235, 0.25)',
        multipleItemBorderColor: '#cbd5f5',
        multipleItemBorderColorDisabled: 'rgba(148, 163, 184, 0.5)',
      },
      Radio: {
        buttonBg: '#ffffff',
        buttonCheckedBg: '#2563eb',
        buttonColor: '#0f172a',
        buttonSolidCheckedColor: '#ffffff',
        buttonSolidCheckedHoverBg: '#1d4ed8',
        buttonSolidCheckedActiveBg: '#1d4ed8',
      },
      Button: {
        defaultBg: '#f8fafc',
        defaultColor: '#0f172a',
        defaultBorderColor: '#d1d5db',
        defaultHoverBg: '#e2e8f0',
        defaultHoverColor: '#0f172a',
        defaultHoverBorderColor: '#94a3b8',
        defaultActiveBg: '#cbd5f5',
        defaultActiveColor: '#0f172a',
        defaultActiveBorderColor: '#94a3b8',
        primaryColor: '#ffffff',
        dangerColor: '#ffffff',
        borderColorDisabled: '#e2e8f0',
        ghostBg: 'transparent',
        defaultGhostColor: '#0f172a',
        defaultGhostBorderColor: '#d1d5db',
        solidTextColor: '#0f172a',
        textTextColor: '#0f172a',
        textTextHoverColor: '#0f172a',
        textTextActiveColor: '#0f172a',
        paddingInline: 12,
        paddingInlineLG: 16,
        paddingInlineSM: 8,
        paddingBlock: 4,
        paddingBlockLG: 6,
        paddingBlockSM: 2,
        linkHoverBg: 'rgba(37, 99, 235, 0.08)',
        textHoverBg: 'rgba(15, 23, 42, 0.06)',
        contentFontSize: 14,
        contentFontSizeLG: 16,
        contentFontSizeSM: 12,
      },
      Tooltip: {
        colorBgSpotlight: '#ffffff',
        colorTextLightSolid: '#0f172a',
        borderRadius: 6,
        boxShadowSecondary: '0 6px 16px 0 rgba(0, 0, 0, 0.08), 0 3px 6px -4px rgba(0, 0, 0, 0.12), 0 9px 28px 8px rgba(0, 0, 0, 0.05)',
      },
    },
  },
}

export default function AntdProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const { theme: mode } = useTheme()
  const currentTheme = themeConfigs[mode]

  return (
    <StyleProvider hashPriority="high">
      <ConfigProvider
        theme={currentTheme}
      >
        <AntdApp
          message={{
            top: 100,
            maxCount: 3,
            duration: 3,
            prefixCls: 'custom-message',
          }}
        >
          {children}
        </AntdApp>
      </ConfigProvider>
    </StyleProvider>
  )
}
