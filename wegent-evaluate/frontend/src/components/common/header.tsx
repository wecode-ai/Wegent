'use client'

import { Bell, User, Globe } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLanguage } from '@/contexts/LanguageContext'
import { VersionSelector } from '@/components/common/version-selector'

export function Header() {
  const { t } = useTranslation()
  const { language, setLanguage } = useLanguage()

  const toggleLanguage = () => {
    setLanguage(language === 'en' ? 'zh-CN' : 'en')
  }

  return (
    <header className="flex h-14 items-center justify-between border-b bg-card px-4">
      <div className="flex items-center gap-4">
        <span className="text-sm text-muted-foreground">
          RAG {t('common.evaluation', 'Evaluation')} Service
        </span>
      </div>
      <div className="flex items-center gap-3">
        <VersionSelector />
        <button
          onClick={toggleLanguage}
          className="flex items-center gap-1 rounded-full px-3 py-1.5 text-sm hover:bg-secondary"
          title={language === 'en' ? 'Switch to Chinese' : '切换到英文'}
        >
          <Globe className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground">
            {language === 'en' ? 'EN' : '中文'}
          </span>
        </button>
        <button className="rounded-full p-2 hover:bg-secondary">
          <Bell className="h-5 w-5 text-muted-foreground" />
        </button>
        <button className="flex items-center gap-2 rounded-full p-2 hover:bg-secondary">
          <User className="h-5 w-5 text-muted-foreground" />
        </button>
      </div>
    </header>
  )
}
