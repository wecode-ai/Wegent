// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import dynamic from 'next/dynamic'
import { useParams, useRouter } from 'next/navigation'
import TopNavigation from '@/features/layout/TopNavigation'
import UserMenu from '@/features/layout/UserMenu'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { useTranslation } from '@/hooks/useTranslation'
import { saveLastTab } from '@/utils/userPreferences'
import { wikiStyles } from '@/features/knowledge/wikiStyles'
import { WikiDetailSidebar } from '@/features/knowledge/WikiDetailSidebar'
import { useMermaidInit } from '@/features/knowledge/useMermaidInit'
import { useWikiDetail } from '@/features/knowledge/useWikiDetail'

const WikiContent = dynamic(
  () => import('@/features/knowledge/WikiContent').then(mod => ({ default: mod.WikiContent })),
  { ssr: false }
)

export default function WikiDetailPage() {
  const { t: _t } = useTranslation()
  const params = useParams()
  const router = useRouter()
  const projectId = Number(params.projectId)

  // Use shared Hook to manage detail page data
  const { wikiDetail, loading, error, selectedContentId, selectedContent, handleSelectContent } =
    useWikiDetail(projectId)

  const handleBackToList = () => {
    router.back()
  }

  // Save last active tab to localStorage
  useEffect(() => {
    saveLastTab('wiki')
  }, [])

  // Use shared Mermaid initialization Hook
  useMermaidInit(selectedContent)

  return (
    <div>
      <style jsx global>
        {wikiStyles}
      </style>

      <div className="flex smart-h-screen bg-base text-text-primary box-border">
        <div className="flex-1 flex flex-col min-w-0">
          <TopNavigation activePage="wiki" variant="standalone">
            <GithubStarButton />
            <UserMenu />
          </TopNavigation>

          <div className="flex h-full">
            <WikiDetailSidebar
              wikiDetail={wikiDetail}
              loading={loading}
              error={error}
              selectedContentId={selectedContentId}
              onBackToList={handleBackToList}
              onSelectContent={handleSelectContent}
            />

            <div className="flex-1 overflow-auto p-6 bg-surface/5">
              <WikiContent content={selectedContent} loading={loading} error={error} />
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
