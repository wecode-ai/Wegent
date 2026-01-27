// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base share page.
 * Displays share info and redirects or shows no permission message.
 */

'use client'

import { AlertCircle, BookOpen, Loader2, Users } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { getKnowledgeShareInfo } from '@/apis/knowledge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeShareInfoResponse } from '@/types/knowledge'

export default function SharePage() {
  const params = useParams()
  const router = useRouter()
  const { t } = useTranslation('knowledge')
  const [shareInfo, setShareInfo] = useState<KnowledgeShareInfoResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const kbId = Number(params.id)

  useEffect(() => {
    async function fetchShareInfo() {
      if (!kbId || isNaN(kbId)) {
        setError('Invalid knowledge base ID')
        setIsLoading(false)
        return
      }

      try {
        const info = await getKnowledgeShareInfo(kbId)
        setShareInfo(info)

        // If user has permission, redirect to the knowledge base page
        if (info.has_permission) {
          router.replace(`/knowledge/document/${kbId}`)
        }
      } catch (err) {
        console.error('Failed to fetch share info:', err)
        setError('Knowledge base not found')
      } finally {
        setIsLoading(false)
      }
    }

    fetchShareInfo()
  }, [kbId, router])

  if (isLoading) {
    return (
      <div className="flex h-[calc(100vh-200px)] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex h-[calc(100vh-200px)] flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <p className="text-lg text-muted-foreground">{error}</p>
        <Button variant="outline" onClick={() => router.push('/knowledge')}>
          {t('chatPage.backToList')}
        </Button>
      </div>
    )
  }

  // User doesn't have permission - show no access page
  if (shareInfo && !shareInfo.has_permission) {
    const isGroupKb = shareInfo.namespace !== 'default' && shareInfo.namespace !== 'organization'

    return (
      <div className="flex h-[calc(100vh-200px)] items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <BookOpen className="h-8 w-8 text-muted-foreground" />
            </div>
            <CardTitle>{shareInfo.name}</CardTitle>
            {shareInfo.description && (
              <CardDescription>{shareInfo.description}</CardDescription>
            )}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>
                {t('share.no_permission.owner')}: {shareInfo.owner_username}
              </span>
            </div>

            <div className="rounded-lg bg-destructive/10 p-4 text-center">
              <AlertCircle className="mx-auto mb-2 h-6 w-6 text-destructive" />
              <p className="font-medium text-destructive">
                {t('share.no_permission.title')}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t('share.no_permission.description')}
              </p>
              {isGroupKb && (
                <p className="mt-2 text-sm text-muted-foreground">
                  {t('share.no_permission.group_hint')}
                </p>
              )}
            </div>

            <Button
              variant="outline"
              className="w-full"
              onClick={() => router.push('/knowledge')}
            >
              {t('chatPage.backToList')}
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  // Default loading/redirect state
  return (
    <div className="flex h-[calc(100vh-200px)] items-center justify-center">
      <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
    </div>
  )
}
