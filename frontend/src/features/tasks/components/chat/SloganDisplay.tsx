// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ChatSloganItem } from '@/types/api'

interface SloganDisplayProps {
  slogan: ChatSloganItem | null
}

/**
 * SloganDisplay Component
 *
 * Displays a slogan/welcome message above the chat input when no messages exist.
 * Always renders a container with fixed height to prevent layout shift when switching tabs.
 *
 * @param slogan - The slogan item containing translations for different languages
 */
export function SloganDisplay({ slogan }: SloganDisplayProps) {
  const { i18n } = useTranslation()
  const currentLang = i18n.language?.startsWith('zh') ? 'zh' : 'en'
  const sloganText = slogan ? (currentLang === 'zh' ? slogan.zh : slogan.en) : ''

  // Always render the container to maintain consistent layout height
  // This prevents the chat input from "jumping" when switching between /chat and /code tabs
  return (
    <div className="text-center mb-8 min-h-[2.5rem] sm:min-h-[3rem]">
      {sloganText && (
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-text-primary tracking-tight">
          {sloganText}
        </h1>
      )}
    </div>
  )
}

export default SloganDisplay
