// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef } from 'react'
import { apiClient } from '@/apis/client'

export interface LinkPreviewData {
  url: string
  title: string | null
  description: string | null
  image: string | null
  favicon: string | null
  site_name: string | null
  success: boolean
}

interface UseLinkPreviewResult {
  data: LinkPreviewData | null
  isLoading: boolean
  error: Error | null
}

// In-memory cache for link preview data
const previewCache = new Map<string, LinkPreviewData>()

// Track pending requests to avoid duplicate fetches
const pendingRequests = new Map<string, Promise<LinkPreviewData>>()

/**
 * Custom hook to fetch link preview data from the backend API.
 * Includes caching and deduplication of requests.
 *
 * @param url - The URL to fetch preview for (empty string to skip)
 * @returns Object containing data, isLoading state, and error
 */
export function useLinkPreview(url: string): UseLinkPreviewResult {
  const [data, setData] = useState<LinkPreviewData | null>(() => {
    // Check cache on initial render
    return previewCache.get(url) || null
  })
  const [isLoading, setIsLoading] = useState(!previewCache.has(url) && !!url)
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(false)

  // Separate effect for mount/unmount tracking
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    // Skip if URL is empty or invalid
    if (!url || !url.startsWith('http')) {
      setIsLoading(false)
      if (url) {
        setError(new Error('Invalid URL'))
      }
      return
    }

    // Return cached result if available
    const cached = previewCache.get(url)
    if (cached) {
      setData(cached)
      setIsLoading(false)
      return
    }

    // Check if there's already a pending request for this URL
    const pendingRequest = pendingRequests.get(url)
    if (pendingRequest) {
      setIsLoading(true)
      pendingRequest
        .then(result => {
          if (mountedRef.current) {
            setData(result)
            setIsLoading(false)
          }
        })
        .catch(err => {
          if (mountedRef.current) {
            setError(err)
            setIsLoading(false)
          }
        })
      return
    }

    // Create new request
    setIsLoading(true)
    setError(null)

    const fetchPreview = async (): Promise<LinkPreviewData> => {
      const result = await apiClient.get<LinkPreviewData>(
        `/utils/link-preview?url=${encodeURIComponent(url)}`
      )
      return result
    }

    const request = fetchPreview()
    pendingRequests.set(url, request)

    request
      .then(result => {
        // Cache the result
        previewCache.set(url, result)
        pendingRequests.delete(url)

        if (mountedRef.current) {
          setData(result)
          setIsLoading(false)
        }
      })
      .catch(err => {
        pendingRequests.delete(url)

        // Cache failed requests to avoid retrying
        const failedResult: LinkPreviewData = {
          url,
          title: null,
          description: null,
          image: null,
          favicon: null,
          site_name: null,
          success: false,
        }
        previewCache.set(url, failedResult)

        if (mountedRef.current) {
          setError(err)
          setData(failedResult)
          setIsLoading(false)
        }
      })
  }, [url])

  return { data, isLoading, error }
}

/**
 * Clear the link preview cache (useful for testing or manual refresh)
 */
export function clearLinkPreviewCache(): void {
  previewCache.clear()
}

/**
 * Prefetch link preview for a URL without waiting for result.
 */
export function prefetchLinkPreview(url: string): void {
  if (!url || !url.startsWith('http') || previewCache.has(url) || pendingRequests.has(url)) {
    return
  }

  const request = apiClient
    .get<LinkPreviewData>(`/utils/link-preview?url=${encodeURIComponent(url)}`)
    .then(result => {
      previewCache.set(url, result)
      pendingRequests.delete(url)
      return result
    })
    .catch(() => {
      const failedResult: LinkPreviewData = {
        url,
        title: null,
        description: null,
        image: null,
        favicon: null,
        site_name: null,
        success: false,
      }
      previewCache.set(url, failedResult)
      pendingRequests.delete(url)
      return failedResult
    })

  pendingRequests.set(url, request)
}
