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
  borderRadius: 10,
}

const themeConfigs: Record<ThemeMode, ThemeConfig> = {
  dark: {
    algorithm: theme.darkAlgorithm,
    token: {
      ...sharedTokens,
      colorBgBase: '#0f1419',
      colorBorder: '#374151',
      colorPrimary: '#818cf8',
      colorBgContainer: '#1a1f26',
      colorText: '#f3f4f6',
      colorTextPlaceholder: '#9ca3af',
      controlOutline: 'rgba(129, 140, 248, 0.4)',
    },
    components: {
      Select: {
        selectorBg: '#0f1419',
        clearBg: '#0f1419',
        optionSelectedBg: '#252b33',
        optionActiveBg: '#252b33',
        controlItemBgHover: '#252b33',
        multipleItemBg: '#252b33',
        hoverBorderColor: '#4b5563',
        activeBorderColor: '#4b5563',
        activeOutlineColor: '#4b5563',
        multipleItemBorderColor: '#4b5563',
        multipleItemBorderColorDisabled: 'disabled',
      },
      Radio: {
        buttonBg: '#0f1419',
        buttonCheckedBg: '#818cf8',
        buttonColor: '#f3f4f6',
        buttonSolidCheckedColor: '#0f1419',
        buttonSolidCheckedHoverBg: '#6366f1',
        buttonSolidCheckedActiveBg: '#6366f1',
      },
      Button: {
        defaultBg: '#252b33',
        defaultColor: '#f3f4f6',
        defaultBorderColor: '#374151',
        defaultHoverBg: '#374151',
        defaultHoverColor: '#f3f4f6',
        defaultHoverBorderColor: '#4b5563',
        defaultActiveBg: '#374151',
        defaultActiveColor: '#f3f4f6',
        defaultActiveBorderColor: '#4b5563',
        primaryColor: '#f3f4f6',
        dangerColor: '#ffffff',
        borderColorDisabled: '#374151',
        ghostBg: 'transparent',
        defaultGhostColor: '#f3f4f6',
        defaultGhostBorderColor: '#374151',
        solidTextColor: '#0f1419',
        textTextColor: '#f3f4f6',
        textTextHoverColor: '#f3f4f6',
        textTextActiveColor: '#f3f4f6',
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
        colorBgSpotlight: '#1a1f26',
        colorTextLightSolid: '#f3f4f6',
        borderRadius: 10,
        boxShadowSecondary: '0 4px 12px rgba(0, 0, 0, 0.5)',
      },
    },
  },
  light: {
    algorithm: theme.defaultAlgorithm,
    token: {
      ...sharedTokens,
      colorBgBase: '#fafbfc',
      colorBorder: '#d1d5db',
      colorPrimary: '#6366f1',
      colorBgContainer: '#f3f4f6',
      colorText: '#111827',
      colorTextPlaceholder: '#6b7280',
      controlOutline: 'rgba(99, 102, 241, 0.4)',
    },
    components: {
      Select: {
        selectorBg: '#fafbfc',
        clearBg: '#fafbfc',
        optionSelectedBg: '#e5e7eb',
        optionActiveBg: '#ddd6fe',
        controlItemBgHover: '#f3f4f6',
        multipleItemBg: '#e5e7eb',
        hoverBorderColor: '#9ca3af',
        activeBorderColor: '#6366f1',
        activeOutlineColor: 'rgba(99, 102, 241, 0.25)',
        multipleItemBorderColor: '#d1d5db',
        multipleItemBorderColorDisabled: 'rgba(156, 163, 175, 0.5)',
      },
      Radio: {
        buttonBg: '#fafbfc',
        buttonCheckedBg: '#6366f1',
        buttonColor: '#111827',
        buttonSolidCheckedColor: '#ffffff',
        buttonSolidCheckedHoverBg: '#4f46e5',
        buttonSolidCheckedActiveBg: '#4f46e5',
      },
      Button: {
        defaultBg: '#f3f4f6',
        defaultColor: '#111827',
        defaultBorderColor: '#d1d5db',
        defaultHoverBg: '#e5e7eb',
        defaultHoverColor: '#111827',
        defaultHoverBorderColor: '#9ca3af',
        defaultActiveBg: '#d1d5db',
        defaultActiveColor: '#111827',
        defaultActiveBorderColor: '#9ca3af',
        primaryColor: '#ffffff',
        dangerColor: '#ffffff',
        borderColorDisabled: '#e5e7eb',
        ghostBg: 'transparent',
        defaultGhostColor: '#111827',
        defaultGhostBorderColor: '#d1d5db',
        solidTextColor: '#111827',
        textTextColor: '#111827',
        textTextHoverColor: '#111827',
        textTextActiveColor: '#111827',
        paddingInline: 12,
        paddingInlineLG: 16,
        paddingInlineSM: 8,
        paddingBlock: 4,
        paddingBlockLG: 6,
        paddingBlockSM: 2,
        linkHoverBg: 'rgba(99, 102, 241, 0.08)',
        textHoverBg: 'rgba(17, 24, 39, 0.06)',
        contentFontSize: 14,
        contentFontSizeLG: 16,
        contentFontSizeSM: 12,
      },
      Tooltip: {
        colorBgSpotlight: '#ffffff',
        colorTextLightSolid: '#111827',
        borderRadius: 10,
        boxShadowSecondary: '0 4px 12px rgba(0, 0, 0, 0.1)',
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
