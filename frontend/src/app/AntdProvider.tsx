'use client'

import React from 'react'
import { ConfigProvider, App as AntdApp } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'
import { theme } from 'antd'

export default function AntdProvider({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <StyleProvider hashPriority="high">
      <ConfigProvider
        theme={{
          algorithm: theme.darkAlgorithm,
          token: {
            colorBgBase: '#0d1117',
            colorBorder: '#30363d',
            colorPrimary: 'rgb(112,167,215)',
            colorBgContainer: '#161b22', // Dropdown background
            colorText: '#f0f6fc',
            colorTextPlaceholder: '#9ca3af',
            fontSize: 12,
            controlHeight: 34,
            borderRadius: 6,
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
              multipleItemBorderColorDisabled: 'disabled'
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
              contentFontSizeSM: 12
            }
          }
        }}
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