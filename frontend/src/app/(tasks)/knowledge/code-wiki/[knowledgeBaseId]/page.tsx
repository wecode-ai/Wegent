// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import TopNavigation from '@/features/layout/TopNavigation'
import UserMenu from '@/features/layout/UserMenu'
import { GithubStarButton } from '@/features/layout/GithubStarButton'
import { CodeWikiReader } from '@/features/knowledge/code-wiki/CodeWikiReader'
import { codeWikiApi } from '@/apis/code-wiki'
import type { CodeWikiSummary } from '@/types/code-wiki'
import '@/app/tasks/tasks.css'
import '@/features/common/scrollbar.css'

export default function CodeWikiPage() {
  const params = useParams()
  const router = useRouter()
  const knowledgeBaseId = Number(params.knowledgeBaseId)

  const [wiki, setWiki] = useState<CodeWikiSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    // The list is the only place a wiki's summary comes from, and it is the same
    // request that decides whether this reader may show anything at all.
    let cancelled = false
    codeWikiApi
      .list()
      .then(response => {
        if (cancelled) return
        setWiki(response.items.find(item => item.id === knowledgeBaseId) ?? null)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [knowledgeBaseId])

  return (
    <div className="flex smart-h-screen flex-col bg-base text-text-primary">
      <TopNavigation activePage="wiki" variant="standalone">
        <GithubStarButton />
        <UserMenu />
      </TopNavigation>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-border px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/knowledge?type=code')}
            data-testid="code-wiki-back-to-list"
          >
            <ArrowLeft className="mr-1.5 h-4 w-4" />
            {wiki?.project_name ?? ''}
          </Button>
        </div>

        {loading ? (
          <div className="flex flex-1 justify-center py-16">
            <Spinner />
          </div>
        ) : wiki ? (
          <CodeWikiReader wiki={wiki} />
        ) : (
          <p className="py-16 text-center text-sm text-text-tertiary">404</p>
        )}
      </div>
    </div>
  )
}
