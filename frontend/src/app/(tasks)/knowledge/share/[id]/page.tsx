// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Knowledge base share page.
 * Displays share info and allows users to request access if they don't have permission.
 */

'use client'

import { AlertCircle, BookOpen, Clock, Loader2, Send, Users } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'

import { checkPendingRequest, getKnowledgeShareInfo } from '@/apis/knowledge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PermissionRequestDialog } from '@/features/knowledge/document/components/PermissionRequestDialog'
import { useTranslation } from '@/hooks/useTranslation'
import type { KnowledgeShareInfoResponse, PermissionRequestResponse } from '@/types/knowledge'

export default function SharePage() {
  const params = useParams()
  const router = useRouter()
  const { t } = useTranslation('knowledge')
  const [shareInfo, setShareInfo] = useState<KnowledgeShareInfoResponse | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [pendingRequest, setPendingRequest] = useState<PermissionRequestResponse | null>(null)
  const [isRequestDialogOpen, setIsRequestDialogOpen] = useState(false)

  const kbId = Number(params.id)

  const checkPending = useCallback(async () => {
    if (!kbId || isNaN(kbId)) return
    try {
      const result = await checkPendingRequest(kbId)
      setPendingRequest(result.pending_request)
    } catch (err) {
      console.error('Failed to check pending request:', err)
    }
  }, [kbId])

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
          return
        }

        // Check if user has a pending request
        await checkPending()
      } catch (err) {
        console.error('Failed to fetch share info:', err)
        setError('Knowledge base not found')
      } finally {
        setIsLoading(false)
      }
    }

    fetchShareInfo()
  }, [kbId, router, checkPending])

  const handleRequestSuccess = () => {
    checkPending()
  }

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

  // User doesn't have permission - show access request page
  if (shareInfo && !shareInfo.has_permission) {
    const isGroupKb = shareInfo.namespace !== 'default' && shareInfo.namespace !== 'organization'
    const isOrganizationKb = shareInfo.namespace === 'organization'

    return (
      <div className="flex h-[calc(100vh-200px)] items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
              <BookOpen className="h-8 w-8 text-muted-foreground" />
            </div>
            <CardTitle>{shareInfo.name}</CardTitle>
            {shareInfo.description && <CardDescription>{shareInfo.description}</CardDescription>}
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Users className="h-4 w-4" />
              <span>
                {t('share.no_permission.owner')}: {shareInfo.owner_username}
              </span>
            </div>

            {/* Show different content based on KB type */}
            {isOrganizationKb ? (
              // Organization KB - should be accessible to all, show error
              <div className="rounded-lg bg-destructive/10 p-4 text-center">
                <AlertCircle className="mx-auto mb-2 h-6 w-6 text-destructive" />
                <p className="font-medium text-destructive">{t('share.no_permission.title')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('share.no_permission.organization_hint')}
                </p>
              </div>
            ) : isGroupKb ? (
              // Group KB - need to join group first
              <div className="rounded-lg bg-amber-500/10 p-4 text-center">
                <AlertCircle className="mx-auto mb-2 h-6 w-6 text-amber-600" />
                <p className="font-medium text-amber-600">{t('share.no_permission.group_title')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('share.no_permission.group_hint')}
                </p>
              </div>
            ) : pendingRequest ? (
              // Personal KB with pending request
              <div className="rounded-lg bg-blue-500/10 p-4 text-center">
                <Clock className="mx-auto mb-2 h-6 w-6 text-blue-600" />
                <p className="font-medium text-blue-600">{t('share.pending_request.title')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('share.pending_request.description')}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('share.pending_request.submitted_at', {
                    time: new Date(pendingRequest.created_at).toLocaleString(),
                  })}
                </p>
              </div>
            ) : (
              // Personal KB without pending request - can apply
              <div className="rounded-lg bg-muted p-4 text-center">
                <Send className="mx-auto mb-2 h-6 w-6 text-primary" />
                <p className="font-medium">{t('share.request_access.title')}</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t('share.request_access.description')}
                </p>
              </div>
            )}

            <div className="flex flex-col gap-2">
              {/* Show request button only for personal KB without pending request */}
              {!isGroupKb && !isOrganizationKb && !pendingRequest && (
                <Button onClick={() => setIsRequestDialogOpen(true)}>
                  <Send className="mr-2 h-4 w-4" />
                  {t('share.request_access.button')}
                </Button>
              )}

              <Button variant="outline" onClick={() => router.push('/knowledge')}>
                {t('chatPage.backToList')}
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Permission request dialog */}
        {shareInfo && (
          <PermissionRequestDialog
            open={isRequestDialogOpen}
            onOpenChange={setIsRequestDialogOpen}
            kbInfo={shareInfo}
            onSuccess={handleRequestSuccess}
          />
        )}
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
