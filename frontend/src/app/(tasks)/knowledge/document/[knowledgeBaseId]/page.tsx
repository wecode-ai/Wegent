// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { KnowledgeUrlStatus } from '@/features/knowledge/document/components/KnowledgeUrlStatus'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'
import { getOrganizationNamespace } from '@/apis/knowledge'
import { buildKbUrl, parseKnowledgeBaseId } from '@/utils/knowledgeUrl'

// Loading fallback component
function PageLoadingFallback() {
  return (
    <div className="flex h-screen items-center justify-center bg-base">
      <Spinner />
    </div>
  )
}

/**
 * Knowledge Base Compatibility Redirect Page
 *
 * This page handles the legacy URL format /knowledge/document/{knowledgeBaseId}
 * and redirects to the new virtual URL format /knowledge/{namespace}/{kbName}.
 *
 * Preserves all query parameters (taskId, doc, etc.) during redirect.
 */
function KnowledgeBaseCompatContent() {
  const params = useParams()
  const searchParams = useSearchParams()
  const router = useRouter()

  const knowledgeBaseId = params.knowledgeBaseId
    ? parseKnowledgeBaseId(params.knowledgeBaseId as string)
    : null

  const { knowledgeBase, loading, error, accessDenied, refresh } = useKnowledgeBaseDetail({
    knowledgeBaseId: knowledgeBaseId || 0,
    autoLoad: !!knowledgeBaseId,
  })

  useEffect(() => {
    if (!knowledgeBaseId || !knowledgeBase || knowledgeBase.id !== knowledgeBaseId) return
    const kb = knowledgeBase
    let isCurrent = true

    async function redirectToVirtualUrl() {
      let isOrganization = false

      try {
        const orgNamespace = await getOrganizationNamespace()
        isOrganization = orgNamespace.namespace === kb.namespace
      } catch (error) {
        console.error('Failed to resolve organization namespace for legacy KB redirect:', error)
      }

      if (!isCurrent) return

      router.replace(
        buildKbUrl(kb.namespace, kb.name, isOrganization, undefined, {
          knowledgeBaseId: kb.id,
          searchParams: searchParams.toString(),
        })
      )
    }

    redirectToVirtualUrl()

    return () => {
      isCurrent = false
    }
  }, [knowledgeBaseId, knowledgeBase, router, searchParams])

  if (!knowledgeBaseId || accessDenied || (!loading && !knowledgeBase && !error)) {
    return <KnowledgeUrlStatus status="not-found" onRetry={refresh} />
  }
  if (error) return <KnowledgeUrlStatus status="error" onRetry={refresh} />
  return <PageLoadingFallback />
}

export default function KnowledgeBaseCompatPage() {
  // Wrap in Suspense is handled by Next.js for useSearchParams
  return <KnowledgeBaseCompatContent />
}
