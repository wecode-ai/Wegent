// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { AlertCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useTranslation } from '@/hooks/useTranslation'
import { knowledgePermissionApi } from '@/apis/knowledge-permission'

/**
 * Legacy Knowledge Base Share Page - Redirects to new token-based URL
 *
 * This page handles old share links (e.g., /knowledge/share/123) and redirects
 * them to the new token-based format (e.g., /shared/knowledge?token=xxx).
 */
export default function KnowledgeBaseShareRedirectPage() {
  const { t } = useTranslation('shared-knowledge')
  const router = useRouter()
  const params = useParams()

  // Parse and validate kbId
  const kbIdParam = params.id
  const parsedKbId = typeof kbIdParam === 'string' ? Number(kbIdParam) : NaN
  const isValidKbId = Number.isInteger(parsedKbId) && parsedKbId > 0
  const kbId = isValidKbId ? parsedKbId : 0

  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!isValidKbId) {
      setError(t('error_invalid_link'))
      return
    }

    const fetchShareToken = async () => {
      try {
        // Get share token for this KB
        const result = await knowledgePermissionApi.getShareTokenByKbId(kbId)
        if (result.share_token) {
          // Redirect to new token-based URL
          router.replace(`/shared/knowledge?token=${encodeURIComponent(result.share_token)}`)
        } else {
          setError(t('error_kb_not_found'))
        }
      } catch (err) {
        console.error('Failed to get share token:', err)
        const errorMessage = (err as Error)?.message || ''

        if (errorMessage.includes('not found')) {
          setError(t('error_kb_not_found'))
        } else {
          setError(t('error_load_failed'))
        }
      }
    }

    fetchShareToken()
  }, [isValidKbId, kbId, router, t])

  // Invalid kbId - show error
  if (!isValidKbId || error) {
    return (
      <div className="flex h-screen items-center justify-center bg-base">
        <Card padding="lg" className="max-w-md text-center">
          <div className="flex justify-center mb-4">
            <div className="w-12 h-12 rounded-full bg-error/10 flex items-center justify-center">
              <AlertCircle className="w-6 h-6 text-error" />
            </div>
          </div>
          <div className="text-error mb-4">{error || t('error_invalid_link')}</div>
          <Button variant="outline" onClick={() => router.push('/knowledge')}>
            {t('go_home')}
          </Button>
        </Card>
      </div>
    )
  }

  // Loading state - redirecting
  return (
    <div className="flex h-screen items-center justify-center bg-base">
      <div className="text-center">
        <Spinner className="w-8 h-8 mx-auto mb-4" />
        <p className="text-text-muted">Redirecting...</p>
      </div>
    </div>
  )
}
