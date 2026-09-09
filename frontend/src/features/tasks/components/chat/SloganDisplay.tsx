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
      <div className="mb-10 min-h-8 text-center md:mb-8 md:min-h-[3rem]">
        <h1 className="text-xl font-bold tracking-tight text-text-primary md:text-3xl lg:text-4xl">
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
    <div className="mb-10 min-h-8 text-center md:mb-8 md:min-h-[3rem]">
      {sloganText && (
        <h1 className="text-xl font-bold tracking-tight text-text-primary md:text-3xl lg:text-4xl">
          {sloganText}
        </h1>
      )}
    </div>
  )
}

export default SloganDisplay
