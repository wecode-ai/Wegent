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

// Cache for invalid URLs to avoid repeated validation
const invalidUrlCache = new Set<string>()

/**
 * Validate if a URL is complete and worth fetching metadata for.
 * This prevents excessive API calls during streaming when partial URLs appear.
 *
 * A valid URL must:
 * 1. Start with http:// or https://
 * 2. Have a valid domain with at least one dot (e.g., example.com)
 * 3. Domain part must be at least 4 characters (e.g., a.co)
 */
function isValidCompleteUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false

  // Check if already known to be invalid
  if (invalidUrlCache.has(url)) return false

  try {
    const urlObj = new URL(url)

    // Must be http or https
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
      invalidUrlCache.add(url)
      return false
    }

    const hostname = urlObj.hostname

    // Hostname must exist and have reasonable length
    if (!hostname || hostname.length < 4) {
      invalidUrlCache.add(url)
      return false
    }

    // Must have at least one dot (e.g., example.com, not just "localhost")
    // Exception: localhost and IP addresses
    if (!hostname.includes('.')) {
      // Allow localhost
      if (hostname === 'localhost') return true
      // Allow IP addresses (simple check for digits and dots pattern)
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
      invalidUrlCache.add(url)
      return false
    }

    // Domain must have valid TLD (at least 2 chars after last dot)
    const parts = hostname.split('.')
    const tld = parts[parts.length - 1]
    if (tld.length < 2) {
      invalidUrlCache.add(url)
      return false
    }

    return true
  } catch {
    // URL parsing failed - incomplete or malformed URL
    invalidUrlCache.add(url)
    return false
  }
}

/**
 * Custom hook to fetch URL metadata from the backend API.
 * Includes caching, deduplication of requests, and URL validation
 * to prevent excessive calls during streaming.
 */
export function useUrlMetadata(url: string): UseUrlMetadataResult {
  const [metadata, setMetadata] = useState<UrlMetadata | null>(() => {
    // Check cache on initial render
    return metadataCache.get(url) || null
  })
  const [isLoading, setIsLoading] = useState(!metadataCache.has(url))
  const [error, setError] = useState<Error | null>(null)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true

    // Skip if URL is empty or invalid (includes partial URLs during streaming)
    if (!url || !isValidCompleteUrl(url)) {
      setIsLoading(false)
      setError(new Error('Invalid or incomplete URL'))
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
        .then((result) => {
          if (mountedRef.current) {
            setMetadata(result)
            setIsLoading(false)
          }
        })
        .catch((err) => {
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
      .then((result) => {
        // Cache the result
        metadataCache.set(url, result)
        pendingRequests.delete(url)

        if (mountedRef.current) {
          setMetadata(result)
          setIsLoading(false)
        }
      })
      .catch((err) => {
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

    return () => {
      mountedRef.current = false
    }
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
 * Only fetches if URL is valid and complete (prevents streaming partial URLs).
 */
export function prefetchUrlMetadata(url: string): void {
  if (
    !url ||
    !isValidCompleteUrl(url) ||
    metadataCache.has(url) ||
    pendingRequests.has(url)
  ) {
    return
  }

  const request = apiClient
    .get<UrlMetadata>(`/utils/url-metadata?url=${encodeURIComponent(url)}`)
    .then((result) => {
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
