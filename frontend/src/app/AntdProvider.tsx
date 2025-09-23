'use client'

import { useMemo, type ReactNode } from 'react'
import { ConfigProvider, App as AntdApp } from 'antd'
import { StyleProvider } from '@ant-design/cssinjs'

import { antdThemes } from '@/features/theme/themeConfig'
import { useTheme } from '@/features/theme/ThemeContext'

export default function AntdProvider({
  children,
}: {
  children: ReactNode
}) {
  const { mode } = useTheme()

  const themeConfig = useMemo(() => antdThemes[mode], [mode])

  return (
    <StyleProvider hashPriority="high">
      <ConfigProvider
        theme={themeConfig}
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
