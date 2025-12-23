// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for URL parsing functionality in Chat Shell.
 *
 * Provides automatic URL detection and parsing with state management.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { parseUrls, detectUrls, type ParsedUrlResult, type UrlType } from '@/apis/url-parser';

/**
 * State for a single parsed URL
 */
export interface ParsedUrlState {
  /** Original URL */
  url: string;
  /** Type of content */
  type: UrlType;
  /** Page title (for webpages and PDFs) */
  title?: string | null;
  /** Parsed content */
  content?: string | null;
  /** Whether content was truncated */
  truncated: boolean;
  /** Error message if parsing failed */
  error?: string | null;
  /** Content size in bytes */
  size?: number | null;
  /** Whether this URL is currently being parsed */
  isLoading: boolean;
}

/**
 * Hook state
 */
export interface UseUrlParserState {
  /** Map of URL to parsed state */
  parsedUrls: Map<string, ParsedUrlState>;
  /** Whether any URLs are currently being parsed */
  isLoading: boolean;
  /** Global error message */
  error: string | null;
}

/**
 * Hook return type
 */
export interface UseUrlParserReturn {
  /** Current state */
  state: UseUrlParserState;
  /** Parse URLs from text */
  parseUrlsFromText: (text: string) => Promise<void>;
  /** Parse specific URLs */
  parseSpecificUrls: (urls: string[]) => Promise<void>;
  /** Remove a parsed URL */
  removeUrl: (url: string) => void;
  /** Clear all parsed URLs */
  clearAll: () => void;
  /** Get parsed URLs as array */
  getParsedUrlsArray: () => ParsedUrlState[];
  /** Check if there are any successfully parsed URLs */
  hasValidUrls: boolean;
  /** Check if any URL is currently being parsed */
  isAnyUrlLoading: boolean;
}

/**
 * Hook for URL parsing functionality.
 *
 * @returns URL parser state and methods
 */
export function useUrlParser(): UseUrlParserReturn {
  const [parsedUrls, setParsedUrls] = useState<Map<string, ParsedUrlState>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Track if there's a pending debounce request (URL detected but not yet parsed)
  const [isPendingParse, setIsPendingParse] = useState(false);

  // Track URLs that have been parsed to avoid re-parsing
  const parsedUrlsRef = useRef<Set<string>>(new Set());

  // Debounce timer for text parsing
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  /**
   * Parse specific URLs.
   */
  const parseSpecificUrls = useCallback(async (urls: string[]) => {
    if (urls.length === 0) return;

    // Filter out already parsed URLs
    const newUrls = urls.filter(url => !parsedUrlsRef.current.has(url));
    if (newUrls.length === 0) return;

    // Mark URLs as being parsed
    newUrls.forEach(url => parsedUrlsRef.current.add(url));

    // Set loading state for new URLs
    setParsedUrls(prev => {
      const next = new Map(prev);
      newUrls.forEach(url => {
        next.set(url, {
          url,
          type: 'unknown',
          isLoading: true,
          truncated: false,
        });
      });
      return next;
    });

    setIsLoading(true);
    setError(null);

    try {
      const response = await parseUrls(newUrls);

      // Update state with results
      setParsedUrls(prev => {
        const next = new Map(prev);
        response.results.forEach((result: ParsedUrlResult) => {
          next.set(result.url, {
            url: result.url,
            type: result.type,
            title: result.title,
            content: result.content,
            truncated: result.truncated,
            error: result.error,
            size: result.size,
            isLoading: false,
          });
        });
        return next;
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to parse URLs';
      setError(errorMessage);

      // Mark URLs as failed
      setParsedUrls(prev => {
        const next = new Map(prev);
        newUrls.forEach(url => {
          next.set(url, {
            url,
            type: 'unknown',
            isLoading: false,
            truncated: false,
            error: errorMessage,
          });
        });
        return next;
      });
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Parse URLs from text with debouncing.
   */
  const parseUrlsFromText = useCallback(
    async (text: string) => {
      // Clear existing debounce timer
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      // Detect URLs immediately to check if we need to set pending state
      const urls = detectUrls(text);
      // Filter out already parsed URLs
      const newUrls = urls.filter(url => !parsedUrlsRef.current.has(url));

      if (newUrls.length > 0) {
        // Set pending state immediately when new URLs are detected
        setIsPendingParse(true);

        // Debounce URL parsing to avoid parsing while user is still typing
        debounceTimerRef.current = setTimeout(async () => {
          // Keep isPendingParse true until parseSpecificUrls sets isLoading
          // parseSpecificUrls will handle the loading state transition
          await parseSpecificUrls(newUrls);
          // Only clear pending state after parsing is complete or started
          // Note: parseSpecificUrls sets isLoading=true synchronously before the API call
          setIsPendingParse(false);
        }, 500); // 500ms debounce
      } else {
        // No new URLs to parse, clear pending state
        setIsPendingParse(false);
      }
    },
    [parseSpecificUrls]
  );

  /**
   * Remove a parsed URL.
   */
  const removeUrl = useCallback((url: string) => {
    parsedUrlsRef.current.delete(url);
    setParsedUrls(prev => {
      const next = new Map(prev);
      next.delete(url);
      return next;
    });
  }, []);

  /**
   * Clear all parsed URLs.
   */
  const clearAll = useCallback(() => {
    // Clear any pending debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    setIsPendingParse(false);
    parsedUrlsRef.current.clear();
    setParsedUrls(new Map());
    setError(null);
  }, []);

  /**
   * Get parsed URLs as array.
   */
  const getParsedUrlsArray = useCallback((): ParsedUrlState[] => {
    return Array.from(parsedUrls.values());
  }, [parsedUrls]);

  /**
   * Check if there are any successfully parsed URLs.
   */
  const hasValidUrls = Array.from(parsedUrls.values()).some(
    url => !url.isLoading && !url.error && url.content
  );

  /**
   * Check if any URL is currently being parsed.
   * This includes:
   * - Pending debounce state (URL detected but waiting for debounce)
   * - Global isLoading state (API request in progress)
   * - Individual URL loading states
   */
  const isAnyUrlLoading =
    isPendingParse || isLoading || Array.from(parsedUrls.values()).some(url => url.isLoading);

  return {
    state: {
      parsedUrls,
      isLoading,
      error,
    },
    parseUrlsFromText,
    parseSpecificUrls,
    removeUrl,
    clearAll,
    getParsedUrlsArray,
    hasValidUrls,
    isAnyUrlLoading,
  };
}
