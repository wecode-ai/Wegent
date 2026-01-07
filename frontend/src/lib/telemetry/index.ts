// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Frontend Telemetry Module
 *
 * Provides OpenTelemetry instrumentation for browser-side tracing.
 *
 * @example
 * ```typescript
 * import { initFrontendTracer } from '@/lib/telemetry';
 *
 * // Initialize in your app entry point
 * if (typeof window !== 'undefined') {
 *   initFrontendTracer();
 * }
 * ```
 */

export {
  initFrontendTracer,
  isFrontendTracerInitialized,
  traceLocalAction,
  traceLocalActionSync,
  createSpan,
  getTracer,
  type FrontendTracerConfig,
} from './FrontendTracer'

export { default } from './FrontendTracer'
