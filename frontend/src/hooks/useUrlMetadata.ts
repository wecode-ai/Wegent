// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef } from 'react'
import apiClient from '@/apis/client'

/**
 * URL metadata response from the backend API
 */
export interface UrlMetadata {
  /** The original URL */
  url: string
  /** The page title */
  title: string | null
  /** The page description */
  description: string | null
  /** The favicon URL */
  favicon: string | null
  /** Whether the metadata fetch was successful */
  success: boolean
}

/**
 * Cache for URL metadata to avoid redundant API calls
 */
const metadataCache = new Map<string, UrlMetadata>()

/**
 * Set of URLs currently being fetched to prevent duplicate requests
 */
const pendingRequests = new Set<string>()

/**
 * Listeners waiting for metadata of a specific URL
 */
const pendingListeners = new Map<string, Array<(metadata: UrlMetadata) => void>>()

/**
 * Custom hook to fetch URL metadata from the backend API
 * Includes caching and deduplication of requests
 *
 * @param url The URL to fetch metadata for
 * @returns Object containing metadata, loading state, and error state
 */
export function useUrlMetadata(url: string): {
  metadata: UrlMetadata | null
  isLoading: boolean
  error: string | null
} {
  const [metadata, setMetadata] = useState<UrlMetadata | null>(() => {
    // Check cache on initial render
    return metadataCache.get(url) || null
  })
  const [isLoading, setIsLoading] = useState(!metadataCache.has(url))
  const [error, setError] = useState<string | null>(null)
  const isMountedRef = useRef(true)

  useEffect(() => {
    isMountedRef.current = true

    // If already cached, use cached value
    const cached = metadataCache.get(url)
    if (cached) {
      setMetadata(cached)
      setIsLoading(false)
      setError(null)
      return
    }

    // If already fetching this URL, wait for the result
    if (pendingRequests.has(url)) {
      // Add listener for when the request completes
      const listeners = pendingListeners.get(url) || []
      const listener = (result: UrlMetadata) => {
        if (isMountedRef.current) {
          setMetadata(result)
          setIsLoading(false)
          setError(result.success ? null : 'Failed to fetch metadata')
        }
      }
      listeners.push(listener)
      pendingListeners.set(url, listeners)

      return () => {
        isMountedRef.current = false
        // Remove listener on unmount
        const currentListeners = pendingListeners.get(url)
        if (currentListeners) {
          const index = currentListeners.indexOf(listener)
          if (index > -1) {
            currentListeners.splice(index, 1)
          }
        }
      }
    }

    // Start fetching
    setIsLoading(true)
    setError(null)
    pendingRequests.add(url)

    const fetchMetadata = async () => {
      try {
        const response = await apiClient.get<UrlMetadata>(
          `/utils/url-metadata?url=${encodeURIComponent(url)}`
        )

        // Cache the result
        metadataCache.set(url, response)

        // Update state if still mounted
        if (isMountedRef.current) {
          setMetadata(response)
          setIsLoading(false)
          setError(response.success ? null : 'Failed to fetch metadata')
        }

        // Notify all listeners
        const listeners = pendingListeners.get(url) || []
        listeners.forEach((listener) => listener(response))
        pendingListeners.delete(url)
      } catch (err) {
        console.error('[useUrlMetadata] Failed to fetch metadata:', err)

        // Create error response
        const errorResult: UrlMetadata = {
          url,
          title: null,
          description: null,
          favicon: null,
          success: false,
        }

        // Cache even error results to avoid repeated failures
        metadataCache.set(url, errorResult)

        if (isMountedRef.current) {
          setMetadata(errorResult)
          setIsLoading(false)
          setError(err instanceof Error ? err.message : 'Unknown error')
        }

        // Notify all listeners
        const listeners = pendingListeners.get(url) || []
        listeners.forEach((listener) => listener(errorResult))
        pendingListeners.delete(url)
      } finally {
        pendingRequests.delete(url)
      }
    }

    fetchMetadata()

    return () => {
      isMountedRef.current = false
    }
  }, [url])

  return { metadata, isLoading, error }
}

/**
 * Clear the metadata cache (useful for testing or memory management)
 */
export function clearMetadataCache(): void {
  metadataCache.clear()
}

/**
 * Prefetch metadata for multiple URLs
 * Useful for preloading metadata before rendering
 *
 * @param urls Array of URLs to prefetch
 */
export async function prefetchUrlMetadata(urls: string[]): Promise<void> {
  const uncachedUrls = urls.filter((url) => !metadataCache.has(url))

  await Promise.all(
    uncachedUrls.map(async (url) => {
      if (pendingRequests.has(url)) return

      pendingRequests.add(url)
      try {
        const response = await apiClient.get<UrlMetadata>(
          `/utils/url-metadata?url=${encodeURIComponent(url)}`
        )
        metadataCache.set(url, response)
      } catch (err) {
        console.error('[prefetchUrlMetadata] Failed to prefetch:', url, err)
        metadataCache.set(url, {
          url,
          title: null,
          description: null,
          favicon: null,
          success: false,
        })
      } finally {
        pendingRequests.delete(url)
      }
    })
  )
}
