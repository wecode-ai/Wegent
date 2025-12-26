// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useState, useEffect, useRef } from 'react';
import { fetchUrlMetadata } from '@/apis/utils';

export interface UrlMetadata {
  url: string;
  title: string | null;
  description: string | null;
  favicon: string | null;
  success: boolean;
}

interface UseUrlMetadataResult {
  metadata: UrlMetadata | null;
  loading: boolean;
  error: Error | null;
}

// In-memory cache for URL metadata
// Key: URL, Value: { metadata, timestamp }
const metadataCache = new Map<string, { metadata: UrlMetadata; timestamp: number }>();

// Cache expiration time (15 minutes)
const CACHE_EXPIRATION_MS = 15 * 60 * 1000;

/**
 * Check if cached metadata is still valid
 */
function isCacheValid(timestamp: number): boolean {
  return Date.now() - timestamp < CACHE_EXPIRATION_MS;
}

/**
 * Get cached metadata if available and valid
 */
function getCachedMetadata(url: string): UrlMetadata | null {
  const cached = metadataCache.get(url);
  if (cached && isCacheValid(cached.timestamp)) {
    return cached.metadata;
  }
  // Clean up expired cache
  if (cached) {
    metadataCache.delete(url);
  }
  return null;
}

/**
 * Set metadata in cache
 */
function setCachedMetadata(url: string, metadata: UrlMetadata): void {
  metadataCache.set(url, { metadata, timestamp: Date.now() });
}

/**
 * Hook to fetch URL metadata with caching
 * Uses an in-memory cache to avoid repeated API calls for the same URL
 *
 * @param url - The URL to fetch metadata for
 * @returns Object containing metadata, loading state, and error
 */
export function useUrlMetadata(url: string): UseUrlMetadataResult {
  const [metadata, setMetadata] = useState<UrlMetadata | null>(() => getCachedMetadata(url));
  const [loading, setLoading] = useState<boolean>(!getCachedMetadata(url));
  const [error, setError] = useState<Error | null>(null);

  // Track if component is mounted
  const isMountedRef = useRef(true);
  // Track current URL to handle race conditions
  const currentUrlRef = useRef(url);

  useEffect(() => {
    isMountedRef.current = true;
    currentUrlRef.current = url;

    // Check cache first
    const cached = getCachedMetadata(url);
    if (cached) {
      setMetadata(cached);
      setLoading(false);
      setError(null);
      return;
    }

    // Reset states for new URL
    setMetadata(null);
    setLoading(true);
    setError(null);

    // Fetch metadata
    const fetchData = async () => {
      try {
        const result = await fetchUrlMetadata(url);

        // Only update state if component is still mounted and URL hasn't changed
        if (isMountedRef.current && currentUrlRef.current === url) {
          // Cache the result
          setCachedMetadata(url, result);
          setMetadata(result);
          setLoading(false);
        }
      } catch (err) {
        // Only update state if component is still mounted and URL hasn't changed
        if (isMountedRef.current && currentUrlRef.current === url) {
          setError(err instanceof Error ? err : new Error('Failed to fetch metadata'));
          setLoading(false);
        }
      }
    };

    fetchData();

    return () => {
      isMountedRef.current = false;
    };
  }, [url]);

  return { metadata, loading, error };
}

/**
 * Batch fetch metadata for multiple URLs
 * This can be used to pre-fetch metadata for all links in a message
 *
 * @param urls - Array of URLs to fetch metadata for
 * @returns Promise resolving to Map of URL -> UrlMetadata
 */
export async function batchFetchUrlMetadata(urls: string[]): Promise<Map<string, UrlMetadata>> {
  const results = new Map<string, UrlMetadata>();

  // Check cache first, collect URLs that need fetching
  const urlsToFetch: string[] = [];
  for (const url of urls) {
    const cached = getCachedMetadata(url);
    if (cached) {
      results.set(url, cached);
    } else {
      urlsToFetch.push(url);
    }
  }

  // Fetch remaining URLs in parallel
  if (urlsToFetch.length > 0) {
    const fetchPromises = urlsToFetch.map(async url => {
      try {
        const metadata = await fetchUrlMetadata(url);
        setCachedMetadata(url, metadata);
        results.set(url, metadata);
      } catch {
        // On error, create a failed metadata entry
        const failedMetadata: UrlMetadata = {
          url,
          title: null,
          description: null,
          favicon: null,
          success: false,
        };
        results.set(url, failedMetadata);
      }
    });

    await Promise.allSettled(fetchPromises);
  }

  return results;
}

/**
 * Clear the metadata cache (useful for testing or manual refresh)
 */
export function clearMetadataCache(): void {
  metadataCache.clear();
}
