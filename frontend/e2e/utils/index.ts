/**
 * E2E Test Utilities Index
 * Export all utilities for easy importing
 */

// API Client
export { ApiClient, createApiClient } from './api-client'
export type { ApiResponse } from './api-client'

// Performance Monitor
export { PerformanceMonitor, createPerformanceMonitor, PerformanceThresholds } from './performance'
export type { PerformanceMetrics, ApiTiming } from './performance'

// Visual Regression
export {
  VisualRegression,
  createVisualRegression,
  ViewportConfigs,
  ResponsiveViewports,
} from './visual-regression'
export type { VisualCompareOptions } from './visual-regression'

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

// API Mock utilities (existing)
export {
  setupApiMocks,
  mockTaskExecution,
  waitForApiResponse,
  logApiRequests,
  MOCK_AI_RESPONSE,
  MOCK_SSE_RESPONSE,
} from './api-mock'
