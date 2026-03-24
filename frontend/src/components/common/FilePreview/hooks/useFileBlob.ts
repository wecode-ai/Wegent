// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useCallback } from 'react'
import { getToken } from '@/apis/user'
import { getAttachmentDownloadUrl } from '@/apis/attachments'

interface UseFileBlobReturn {
  blob: Blob | null
  blobUrl: string | null
  isLoading: boolean
  error: string | null
  refetch: () => void
}

/**
 * Hook for fetching file blob from attachment ID or using provided blob
 */
export function useFileBlob(
  attachmentId?: number,
  externalBlob?: Blob,
  shareToken?: string
): UseFileBlobReturn {
  const [blob, setBlob] = useState<Blob | null>(externalBlob || null)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(!externalBlob && !!attachmentId)
  const [error, setError] = useState<string | null>(null)
  const [retryKey, setRetryKey] = useState(0)

  const refetch = useCallback(() => {
    setRetryKey(prev => prev + 1)
  }, [])

  useEffect(() => {
    // If external blob is provided, use it directly
    if (externalBlob) {
      setBlob(externalBlob)
      const url = URL.createObjectURL(externalBlob)
      setBlobUrl(url)
      setIsLoading(false)
      return
    }

    // If no attachmentId, reset state
    if (!attachmentId) {
      setBlob(null)
      setBlobUrl(null)
      setIsLoading(false)
      return
    }

    let isMounted = true
    let currentBlobUrl: string | null = null

    const fetchBlob = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const token = getToken()
        const url = getAttachmentDownloadUrl(attachmentId, shareToken)

        const response = await fetch(url, {
          headers: {
            ...(!shareToken && token && { Authorization: `Bearer ${token}` }),
          },
        })

        if (!response.ok) {
          if (response.status === 403) {
            throw new Error('分享链接已过期或无效')
          }
          if (response.status === 404) {
            throw new Error('附件不存在或已被删除')
          }
          throw new Error('加载失败')
        }

        const fetchedBlob = await response.blob()

        if (isMounted) {
          setBlob(fetchedBlob)
          const url = URL.createObjectURL(fetchedBlob)
          currentBlobUrl = url
          setBlobUrl(url)
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : '加载失败')
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    fetchBlob()

    return () => {
      isMounted = false
      if (currentBlobUrl) {
        URL.revokeObjectURL(currentBlobUrl)
      }
    }
  }, [attachmentId, externalBlob, shareToken, retryKey])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (blobUrl && blobUrl.startsWith('blob:')) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [blobUrl])

  return { blob, blobUrl, isLoading, error, refetch }
}
