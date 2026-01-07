// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState, useEffect, useRef } from 'react'
import { apiClient } from '@/apis/client'

export interface UrlMetadata {
  url: string
  title: string | null
  description: string | null
  favicon: string | null
  success: boolean
}

interface UseUrlMetadataResult {
  metadata: UrlMetadata | null
  isLoading: boolean
  error: Error | null
}

// In-memory cache for URL metadata
const metadataCache = new Map<string, UrlMetadata>()

// Track pending requests to avoid duplicate fetches
const pendingRequests = new Map<string, Promise<UrlMetadata>>()

/**
 * Custom hook to fetch URL metadata from the backend API.
 * Includes caching and deduplication of requests.
 *
 * Note: To prevent excessive API calls during streaming, use the `disabled`
 * prop on LinkCard/SmartLink components instead of relying on URL validation here.
 */
export function useUrlMetadata(url: string): UseUrlMetadataResult {
  const [metadata, setMetadata] = useState<UrlMetadata | null>(() => {
    // Check cache on initial render
    return metadataCache.get(url) || null
  })
  const [isLoading, setIsLoading] = useState(!metadataCache.has(url))
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(false)

  // Separate effect for mount/unmount tracking only
  // This ensures mountedRef is only set to false on actual component unmount,
  // not on every url change which could flip it mid-fetch
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
      setError(new Error('Invalid URL'))
      return
    }

    // Return cached result if available
    const cached = metadataCache.get(url)
    if (cached) {
      setMetadata(cached)
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
            setMetadata(result)
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

    const fetchMetadata = async (): Promise<UrlMetadata> => {
      const result = await apiClient.get<UrlMetadata>(
        `/utils/url-metadata?url=${encodeURIComponent(url)}`
      )
      return result
    }

    const request = fetchMetadata()
    pendingRequests.set(url, request)

    request
      .then(result => {
        // Cache the result
        metadataCache.set(url, result)
        pendingRequests.delete(url)

        if (mountedRef.current) {
          setMetadata(result)
          setIsLoading(false)
        }
      })
      .catch(err => {
        pendingRequests.delete(url)

        // Cache failed requests to avoid retrying
        const failedResult: UrlMetadata = {
          url,
          title: null,
          description: null,
          favicon: null,
          success: false,
        }
        metadataCache.set(url, failedResult)

        if (mountedRef.current) {
          setError(err)
          setMetadata(failedResult)
          setIsLoading(false)
        }
      })
  }, [url])

  return { metadata, isLoading, error }
}

/**
 * Clear the metadata cache (useful for testing or manual refresh)
 */
export function clearMetadataCache(): void {
  metadataCache.clear()
}

/**
 * Prefetch metadata for a URL without waiting for result.
 */
export function prefetchUrlMetadata(url: string): void {
  if (!url || !url.startsWith('http') || metadataCache.has(url) || pendingRequests.has(url)) {
    return
  }

  const request = apiClient
    .get<UrlMetadata>(`/utils/url-metadata?url=${encodeURIComponent(url)}`)
    .then(result => {
      metadataCache.set(url, result)
      pendingRequests.delete(url)
      return result
    })
    .catch(() => {
      const failedResult: UrlMetadata = {
        url,
        title: null,
        description: null,
        favicon: null,
        success: false,
      }
      metadataCache.set(url, failedResult)
      pendingRequests.delete(url)
      return failedResult
    })

  pendingRequests.set(url, request)
}
