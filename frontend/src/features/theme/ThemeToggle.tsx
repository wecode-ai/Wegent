// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { Button } from 'antd'
import { MoonFilled, SunFilled } from '@ant-design/icons'

import { useTheme } from './ThemeContext'
import { useTranslation } from '@/hooks/useTranslation'

export default function ThemeToggle({ showLabel = true }: { showLabel?: boolean }) {
  const { mode, toggleMode, isReady } = useTheme()
  const { t } = useTranslation('common')

  if (!isReady) {
    return null
  }

  const isDark = mode === 'dark'
  const icon = isDark ? <SunFilled /> : <MoonFilled />

  return (
    <Button
      type="primary"
      onClick={toggleMode}
      icon={icon}
      ghost={false}
    >
      {showLabel ? t('actions.switch_theme') : null}
    </Button>
  )
}
