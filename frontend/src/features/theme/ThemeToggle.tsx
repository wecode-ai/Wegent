'use client'

import { Button } from 'antd'
import { MoonOutlined, SunOutlined } from '@ant-design/icons'

import { useTheme } from './ThemeProvider'
import { useTranslation } from '@/hooks/useTranslation'

export function ThemeToggle({ className = '' }: { className?: string }) {
  const { theme, toggleTheme } = useTheme()
  const { t } = useTranslation('common')
  const isDark = theme === 'dark'

  return (
    <Button
      shape="round"
      onClick={toggleTheme}
      className={className}
      icon={isDark ? <SunOutlined /> : <MoonOutlined />}
    >
      {t('actions.toggle_theme')}
    </Button>
  )
}
