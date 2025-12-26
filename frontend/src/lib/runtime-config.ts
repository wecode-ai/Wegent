// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime Configuration Manager
 *
 * Fetches and caches runtime configuration from the server.
 * This allows configuration to be changed without rebuilding the app.
 *
 * Configuration priority:
 * 1. RUNTIME_* environment variables (read at server startup)
 * 2. NEXT_PUBLIC_* environment variables (build-time fallback)
 * 3. Default values (empty string = use proxy)
 */

export interface RuntimeConfig {
  /** Backend API URL. Empty string means use '/api' proxy */
  apiUrl: string;
  /** Socket.IO direct URL. Empty string means use proxy */
  socketDirectUrl: string;
  /** Enable chat context feature (knowledge base background) */
  enableChatContext: boolean;
}

// Cache for runtime config to avoid repeated API calls
let runtimeConfigCache: RuntimeConfig | null = null;
let runtimeConfigPromise: Promise<RuntimeConfig> | null = null;

/**
 * Fetch runtime configuration from the server
 * Results are cached to avoid repeated API calls
 */
export const fetchRuntimeConfig = async (): Promise<RuntimeConfig> => {
  // Return cached config if available
  if (runtimeConfigCache) {
    return runtimeConfigCache;
  }

  // Return existing promise if fetch is in progress
  if (runtimeConfigPromise) {
    return runtimeConfigPromise;
  }

  // Fetch config from API
  runtimeConfigPromise = fetch('/runtime-config')
    .then(res => {
      if (!res.ok) {
        throw new Error('Failed to fetch runtime config');
      }
      return res.json();
    })
    .then((config: RuntimeConfig) => {
      runtimeConfigCache = config;
      return config;
    })
    .catch(err => {
      console.warn('[RuntimeConfig] Failed to fetch, using build-time config:', err);
      // Fallback to build-time env vars
      const fallback: RuntimeConfig = {
        apiUrl: process.env.NEXT_PUBLIC_API_URL || '',
        socketDirectUrl: process.env.NEXT_PUBLIC_SOCKET_DIRECT_URL || '',
        enableChatContext: process.env.NEXT_PUBLIC_ENABLE_CHAT_CONTEXT === 'true',
      };
      runtimeConfigCache = fallback;
      return fallback;
    })
    .finally(() => {
      runtimeConfigPromise = null;
    });

  return runtimeConfigPromise;
};

/**
 * Get runtime config synchronously (uses cached value or build-time fallback)
 * Use this when you need config immediately and can't await
 */
export const getRuntimeConfigSync = (): RuntimeConfig => {
  if (runtimeConfigCache) {
    return runtimeConfigCache;
  }
  // Fallback to build-time env vars
  return {
    apiUrl: process.env.NEXT_PUBLIC_API_URL || '',
    socketDirectUrl: process.env.NEXT_PUBLIC_SOCKET_DIRECT_URL || '',
    enableChatContext: process.env.NEXT_PUBLIC_ENABLE_CHAT_CONTEXT === 'true',
  };
};

/**
 * Get API base URL
 * Returns the configured API URL with /api suffix, or '/api' for proxy mode
 *
 * Examples:
 * - '' (empty) -> '/api' (proxy mode)
 * - 'http://localhost:8000' -> 'http://localhost:8000/api'
 * - 'http://localhost:8000/api' -> 'http://localhost:8000/api' (unchanged)
 * - '/api' -> '/api' (unchanged)
 */
export const getApiBaseUrl = (): string => {
  const config = getRuntimeConfigSync();

  // If apiUrl is not set or empty, use '/api' proxy mode
  if (!config.apiUrl || config.apiUrl.trim() === '') {
    return '/api';
  }

  const apiUrl = config.apiUrl.trim();

  // If it's already '/api' or ends with '/api', return as-is
  if (apiUrl === '/api' || apiUrl.endsWith('/api')) {
    return apiUrl;
  }

  // If it's a full URL (http:// or https://), append /api
  if (apiUrl.startsWith('http://') || apiUrl.startsWith('https://')) {
    // Remove trailing slash if present, then append /api
    return apiUrl.replace(/\/+$/, '') + '/api';
  }

  // For other cases (relative paths), return as-is
  return apiUrl;
};

/**
 * Get Socket.IO URL
 * Returns the configured socket URL or empty string for proxy mode
 */
export const getSocketUrl = (): string => {
  const config = getRuntimeConfigSync();
  return config.socketDirectUrl;
};

/**
 * Check if chat context feature is enabled
 * Returns true if the feature is enabled, false otherwise
 */
export const isChatContextEnabled = (): boolean => {
  const config = getRuntimeConfigSync();
  return config.enableChatContext;
};

/**
 * Clear the config cache (useful for testing or forcing refresh)
 */
export const clearRuntimeConfigCache = (): void => {
  runtimeConfigCache = null;
  runtimeConfigPromise = null;
};

/**
 * Initialize runtime config
 * Call this early in app initialization to pre-fetch config
 */
export const initRuntimeConfig = async (): Promise<RuntimeConfig> => {
  return fetchRuntimeConfig();
};
