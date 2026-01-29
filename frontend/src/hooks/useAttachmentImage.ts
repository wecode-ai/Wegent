// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useState } from 'react'
import { getToken } from '@/apis/user'
import { getAttachmentPreviewUrl } from '@/apis/attachments'

interface AttachmentImageState {
  blobUrl: string | null
  isLoading: boolean
  error: boolean
}

export function useAttachmentImage(attachmentId: number, enabled: boolean): AttachmentImageState {
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!enabled) return

    let isMounted = true

    const fetchImage = async () => {
      setIsLoading(true)
      setError(false)

      try {
        const token = getToken()
        const response = await fetch(getAttachmentPreviewUrl(attachmentId), {
          headers: {
            ...(token && { Authorization: `Bearer ${token}` }),
          },
        })

        if (!response.ok) {
          throw new Error(`Failed to fetch image: ${response.status}`)
        }

        const blob = await response.blob()
        if (isMounted) {
          const url = URL.createObjectURL(blob)
          setBlobUrl(url)
        }
      } catch (err) {
        console.error('Failed to load attachment image:', err)
        if (isMounted) {
          setError(true)
        }
      } finally {
        if (isMounted) {
          setIsLoading(false)
        }
      }
    }

    fetchImage()

    return () => {
      isMounted = false
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [attachmentId, enabled])

  useEffect(() => {
    return () => {
      if (blobUrl) {
        URL.revokeObjectURL(blobUrl)
      }
    }
  }, [blobUrl])

  return { blobUrl, isLoading, error }
}
