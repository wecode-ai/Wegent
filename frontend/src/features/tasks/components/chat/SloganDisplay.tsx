// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { FolderOpen } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { ChatSloganItem } from '@/types/api'

interface ProjectInfo {
  name: string
  path?: string | null
}

interface SloganDisplayProps {
  slogan: ChatSloganItem | null
  project?: ProjectInfo | null
}

export function SloganDisplay({ slogan, project }: SloganDisplayProps) {
  const { t, i18n } = useTranslation('projects')
  const currentLang = i18n.language?.startsWith('zh') ? 'zh' : 'en'

  if (project) {
    const greeting = t('workspace.greeting', { name: '__PROJECT_NAME__' })
    const parts = greeting.split('__PROJECT_NAME__')

    return (
      <div className="text-center mb-8 min-h-[2.5rem] sm:min-h-[3rem]">
        <h1 className="text-2xl sm:text-3xl md:text-4xl font-bold text-text-primary tracking-tight">
          {parts[0]}
          <span className="text-primary">{project.name}</span>
          {parts[1]}
        </h1>
        {project.path && (
          <div className="mt-3 flex items-center justify-center gap-1.5 text-sm text-text-secondary">
            <FolderOpen className="h-4 w-4" />
            <span className="font-mono">{project.path}</span>
          </div>
        )}
      </div>
    )
  }

  const sloganText = slogan ? (currentLang === 'zh' ? slogan.zh : slogan.en) : ''

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
