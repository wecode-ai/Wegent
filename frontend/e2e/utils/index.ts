/**
 * E2E Test Utilities Index
 * Export all utilities for easy importing
 */

// API Client
export { ApiClient, createApiClient } from './api-client'
export type { ApiResponse } from './api-client'

// Cleanup Manager
export { CleanupManager, createCleanupManager, cleanupE2ETestData } from './cleanup'
export type { CleanupResource, CleanupResourceType } from './cleanup'

// Helpers
export {
  // Smart wait utilities (use these instead of waitForTimeout)
  waitForPageStable,
  waitForLoadingComplete,
  waitForContentReady,
  waitForApiCall,
  waitForDialogOpen,
  waitForDialogClose,
  waitForToast,
  // Legacy wait utilities
  waitForElement,
  waitForElementHidden,
  waitForNavigation,
  retry,
  randomString,
  uniqueTestName,
  sleep,
  isCI,
  getBaseUrl,
  getApiUrl,
  debugScreenshot,
  setupConsoleErrorLogging,
  waitForApiResponseWithStatus,
  scrollToBottom,
  scrollToTop,
  getCookies,
  clearCookies,
  getLocalStorageItem,
  setLocalStorageItem,
  clearLocalStorage,
  formatDate,
  getTimestamp,
  extractNumber,
  truncate,
  createAuthenticatedApiClient,
  safeJsonParse,
  isInViewport,
  countElements,
  getAllTextContent,
  clickByText,
  doubleClick,
  rightClick,
  pressKey,
  typeWithDelay,
  downloadFile,
  uploadFile,
} from './helpers'

// Auth utilities (existing)
export { login, logout, isLoggedIn, TEST_USER } from './auth'
