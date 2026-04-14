// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useParams, useRouter, useSearchParams } from 'next/navigation'
import { Spinner } from '@/components/ui/spinner'
import { useKnowledgeBaseDetail } from '@/features/knowledge/document/hooks'

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
    ? parseInt(params.knowledgeBaseId as string, 10)
    : null

  const { knowledgeBase } = useKnowledgeBaseDetail({
    knowledgeBaseId: knowledgeBaseId || 0,
    autoLoad: !!knowledgeBaseId,
  })

  useEffect(() => {
    if (!knowledgeBase) return
    // Build new virtual URL
    const newPath = `/knowledge/${encodeURIComponent(knowledgeBase.namespace)}/${encodeURIComponent(knowledgeBase.name)}`
    // Preserve query params (taskId, doc, etc.)
    const query = searchParams.toString()
    router.replace(query ? `${newPath}?${query}` : newPath)
  }, [knowledgeBase, router, searchParams])

  // Show loading while redirecting
  return <PageLoadingFallback />
}

export default function KnowledgeBaseCompatPage() {
  // Wrap in Suspense is handled by Next.js for useSearchParams
  return <KnowledgeBaseCompatContent />
}
