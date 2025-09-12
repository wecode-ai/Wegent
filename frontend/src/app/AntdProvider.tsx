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
            }
          }
        }}
      >
        <AntdApp>
          {children}
        </AntdApp>
      </ConfigProvider>
    </StyleProvider>
  )
}