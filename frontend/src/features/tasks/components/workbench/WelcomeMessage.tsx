// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useMemo } from 'react'
import { Lightbulb } from 'lucide-react'
import { userApis } from '@/apis/user'
import { useTranslation } from '@/hooks/useTranslation'
import type { WelcomeConfigResponse, ChatTipItem, ChatSloganItem } from '@/types/api'

interface WelcomeMessageProps {
  className?: string
  taskType?: 'chat' | 'code'
}

export function WelcomeMessage({ className = '', taskType = 'chat' }: WelcomeMessageProps) {
  const { i18n } = useTranslation()
  const [welcomeConfig, setWelcomeConfig] = useState<WelcomeConfigResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // Get current language
  const currentLang = i18n.language?.startsWith('zh') ? 'zh' : 'en'

  // Fetch welcome config
  useEffect(() => {
    const fetchWelcomeConfig = async () => {
      try {
        setIsLoading(true)
        const response = await userApis.getWelcomeConfig()
        setWelcomeConfig(response)
      } catch (error) {
        console.error('Failed to fetch welcome config:', error)
      } finally {
        setIsLoading(false)
      }
    }

    fetchWelcomeConfig()
  }, [])

  // Random slogan - select once when config is loaded, filtered by mode
  const randomSlogan = useMemo<ChatSloganItem | null>(() => {
    if (!welcomeConfig?.slogans || welcomeConfig.slogans.length === 0) {
      return null
    }
    // Filter slogans by mode
    const filteredSlogans = welcomeConfig.slogans.filter(slogan => {
      const sloganMode = slogan.mode || 'both'
      return sloganMode === taskType || sloganMode === 'both'
    })
    if (filteredSlogans.length === 0) {
      return null
    }
    const randomIndex = Math.floor(Math.random() * filteredSlogans.length)
    return filteredSlogans[randomIndex]
  }, [welcomeConfig?.slogans, taskType])

  // Random tip - select once when config is loaded, filtered by mode
  const randomTip = useMemo<ChatTipItem | null>(() => {
    if (!welcomeConfig?.tips || welcomeConfig.tips.length === 0) {
      return null
    }
    // Filter tips by mode
    const filteredTips = welcomeConfig.tips.filter(tip => {
      const tipMode = tip.mode || 'both'
      return tipMode === taskType || tipMode === 'both'
    })
    if (filteredTips.length === 0) {
      return null
    }
    const randomIndex = Math.floor(Math.random() * filteredTips.length)
    return filteredTips[randomIndex]
  }, [welcomeConfig?.tips, taskType])

  // Get localized content
  const sloganText = randomSlogan ? randomSlogan[currentLang] || randomSlogan.en : ''
  const tipText = randomTip ? randomTip[currentLang] || randomTip.en : ''

  // Don't render anything while loading or if no config
  if (isLoading || !welcomeConfig) {
    return null
  }

  return (
    <div className={`flex flex-col items-center text-center mb-6 ${className}`}>
      {/* Slogan */}
      {sloganText && <h1 className="text-xl font-semibold text-text-primary mb-4">{sloganText}</h1>}

      {/* Random Tip */}
      {tipText && (
        <div className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-surface border border-border">
          <Lightbulb className="h-4 w-4 text-primary flex-shrink-0" />
          <span className="text-sm text-text-secondary">{tipText}</span>
        </div>
      )}
    </div>
  )
}

export default WelcomeMessage
