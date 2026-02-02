// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'
import { getAttachmentPreview } from '@/apis/attachments'
import type { AttachmentPreviewResponse } from '@/apis/attachments'

const attachmentPreviewCache = new Map<number, AttachmentPreviewResponse>()

interface AttachmentPreviewState {
  data: AttachmentPreviewResponse | null
  isLoading: boolean
  error: string | null
}

export function useAttachmentPreview(attachmentId: number): AttachmentPreviewState {
  const cached = attachmentPreviewCache.get(attachmentId) || null
  const [data, setData] = useState<AttachmentPreviewResponse | null>(cached)
  const [isLoading, setIsLoading] = useState(!cached)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (cached) {
      setData(cached)
      setIsLoading(false)
      setError(null)
      return
    }

    let isMounted = true
    setData(null)
    setError(null)

    const fetchPreview = async () => {
      try {
        setIsLoading(true)
        const response = await getAttachmentPreview(attachmentId)
        attachmentPreviewCache.set(attachmentId, response)
        if (isMounted) {
          setData(response)
          setError(null)
        }
      } catch (err) {
        console.error('Failed to fetch attachment preview:', err)
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load attachment preview')
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    fetchPreview()

    return () => {
      isMounted = false
    }
  }, [attachmentId, cached])

  return { data, isLoading, error }
}
