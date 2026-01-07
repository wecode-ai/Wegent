// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect } from 'react'
import { fetchLatestCompletedWikiGeneration, fetchWikiGenerationDetail } from '@/apis/wiki'
import { WikiGenerationDetail, WikiContent } from '@/types/wiki'
import { getSortedContents } from './wikiUtils'

/**
 * Wiki detail page data loading Hook
 * Encapsulates detail page data fetching and state management logic
 */
export function useWikiDetail(projectId: number) {
  const [wikiDetail, setWikiDetail] = useState<WikiGenerationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedContentId, setSelectedContentId] = useState<number | null>(null)
  const [selectedContent, setSelectedContent] = useState<WikiContent | null>(null)

  const handleSelectContent = (contentId: number) => {
    setSelectedContentId(contentId)
    const content = wikiDetail?.contents.find(c => c.id === contentId) || null
    setSelectedContent(content)
  }

  useEffect(() => {
    const loadWikiDetail = async () => {
      try {
        setLoading(true)
        const generationId = await fetchLatestCompletedWikiGeneration(projectId)

        if (!generationId) {
          setError('No completed generation record found')
          setLoading(false)
          return
        }

        const detail = await fetchWikiGenerationDetail(generationId)

        if (!detail) {
          setError('Failed to get detail')
          setLoading(false)
          return
        }

        setWikiDetail(detail)

        // Default select first content
        if (detail.contents && detail.contents.length > 0) {
          const sortedContents = getSortedContents(detail)
          if (sortedContents.length > 0) {
            setSelectedContentId(sortedContents[0].id)
            setSelectedContent(sortedContents[0])
          }
        }

        setError(null)
      } catch (err) {
        console.error('Failed to load wiki detail:', err)
        setError('Failed to load detail')
      } finally {
        setLoading(false)
      }
    }

    if (projectId) {
      loadWikiDetail()
    }
  }, [projectId])

  return {
    wikiDetail,
    loading,
    error,
    selectedContentId,
    selectedContent,
    handleSelectContent,
  }
}
