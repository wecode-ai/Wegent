// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Frontend OpenTelemetry Tracer
 *
 * Initializes OpenTelemetry for browser-side tracing, including:
 * - Fetch API requests (auto-instrumented)
 * - Document load performance (auto-instrumented)
 * - Manual tracing for user actions (copy, download, share, etc.)
 *
 * NOTE: Automatic user interaction tracking (clicks, submits) is DISABLED.
 * Use the `useTraceAction` hook or `traceLocalAction` function to manually
 * trace meaningful user actions with proper context and attributes.
 *
 * Traces are sent to /otlp/traces (same origin) to avoid CORS issues,
 * which then proxies to the OTEL Collector.
 *
 * NOTE: We use /otlp prefix instead of /api/otlp to avoid conflict with
 * the /api/* rewrite rule in next.config.js that proxies to backend.
 */

import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core'
import { WebTracerProvider } from '@opentelemetry/sdk-trace-web'
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'
import { registerInstrumentations } from '@opentelemetry/instrumentation'
import { resourceFromAttributes, detectResources } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { browserDetector } from '@opentelemetry/opentelemetry-browser-detector'
import { FetchInstrumentation } from '@opentelemetry/instrumentation-fetch'
import { DocumentLoadInstrumentation } from '@opentelemetry/instrumentation-document-load'
import { trace, SpanStatusCode, Attributes, Span } from '@opentelemetry/api'
import { getRuntimeConfigSync } from '@/lib/runtime-config'

// Track initialization state
let isInitialized = false

/**
 * Configuration options for the frontend tracer
 */
export interface FrontendTracerConfig {
  /** Service name for traces (default: wegent-frontend) */
  serviceName?: string
  /** OTLP endpoint URL (default: /otlp/traces) */
  otlpEndpoint?: string
  /** Batch delay in milliseconds (default: 500) */
  batchDelayMs?: number
  /** Whether to trace fetch requests (default: true) */
  traceFetch?: boolean
  /** Whether to trace document load (default: true) */
  traceDocumentLoad?: boolean
  /** URL patterns to propagate trace headers to (default: all) */
  propagateTraceHeaderCorsUrls?: RegExp | RegExp[]
  /** URL patterns to ignore from tracing (default: Next.js internal URLs) */
  ignoreUrls?: RegExp[]
}

/**
 * Default URL patterns to ignore from tracing
 * These are internal Next.js endpoints that don't need to be traced
 */
const DEFAULT_IGNORE_URLS: RegExp[] = [
  // Next.js internal endpoints
  /__nextjs_original-stack-frames/,
  /__nextjs_launch-editor/,
  /_next\/static/,
  /_next\/webpack-hmr/,
  // Source maps
  /\.map$/,
  // Quota API (no need to trace)
  /\/api\/quota/,
]

/**
 * Default configuration
 */
const getDefaultConfig = (): Required<FrontendTracerConfig> => {
  const runtimeConfig = getRuntimeConfigSync()
  return {
    serviceName: runtimeConfig.otelServiceName,
    otlpEndpoint: '/otlp/traces',
    batchDelayMs: 500,
    traceFetch: true,
    traceDocumentLoad: true,
    propagateTraceHeaderCorsUrls: /.*/,
    ignoreUrls: DEFAULT_IGNORE_URLS,
  }
}

/**
 * Initialize the frontend OpenTelemetry tracer.
 *
 * This function should be called once when the application starts.
 * It sets up:
 * - WebTracerProvider with resource detection
 * - BatchSpanProcessor with OTLP HTTP exporter
 * - W3C Trace Context propagation
 * - Auto-instrumentation for fetch and document load
 * - Manual tracing support via traceLocalAction/useTraceAction
 *
 * NOTE: Automatic user interaction tracking is DISABLED.
 * Use useTraceAction hook for meaningful action tracing.
 *
 * @param config - Optional configuration overrides
 * @returns Promise that resolves when initialization is complete
 *
 * @example
 * ```typescript
 * // In your app entry point
 * if (typeof window !== 'undefined') {
 *   initFrontendTracer();
 * }
 * ```
 */
export async function initFrontendTracer(config: FrontendTracerConfig = {}): Promise<void> {
  // Prevent double initialization
  if (isInitialized) {
    console.warn('[FrontendTracer] Already initialized, skipping')
    return
  }

  // Check if telemetry is enabled via runtime config
  const runtimeConfig = getRuntimeConfigSync()
  if (!runtimeConfig.otelEnabled) {
    console.info('[FrontendTracer] Telemetry is disabled')
    return
  }

  // Merge config with defaults
  const defaultConfig = getDefaultConfig()
  const finalConfig = { ...defaultConfig, ...config }

  try {
    // Dynamically import ZoneContextManager to support async operations
    const { ZoneContextManager } = await import('@opentelemetry/context-zone')

    // Create base resource with service name
    let resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: finalConfig.serviceName,
    })

    // Detect browser-specific resources (user agent, platform, etc.)
    const detectedResources = await detectResources({
      detectors: [browserDetector],
    })
    resource = resource.merge(detectedResources)

    // Create the OTLP exporter pointing to our proxy endpoint
    const exporter = new OTLPTraceExporter({
      url: finalConfig.otlpEndpoint,
    })

    // Create the tracer provider with batch processing
    const provider = new WebTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          scheduledDelayMillis: finalConfig.batchDelayMs,
        }),
      ],
    })

    // Register the provider with context manager and propagators
    provider.register({
      contextManager: new ZoneContextManager(),
      propagator: new CompositePropagator({
        propagators: [new W3CBaggagePropagator(), new W3CTraceContextPropagator()],
      }),
    })

    // Build the list of instrumentations
    // NOTE: UserInteractionInstrumentation is intentionally NOT included.
    // Automatic click/submit tracking produces too much noise with unhelpful
    // information (e.g., "click on DIV at //html/body/div[5]/div/div").
    // Instead, use the useTraceAction hook or traceLocalAction function
    // to manually trace meaningful user actions with proper context.
    const instrumentations = []

    // Fetch instrumentation
    if (finalConfig.traceFetch) {
      instrumentations.push(
        new FetchInstrumentation({
          propagateTraceHeaderCorsUrls: finalConfig.propagateTraceHeaderCorsUrls,
          clearTimingResources: true,
          // Ignore internal Next.js URLs and other blacklisted patterns
          ignoreUrls: finalConfig.ignoreUrls,
          applyCustomAttributesOnSpan: (span, request) => {
            // Add custom attributes to fetch spans
            if (request instanceof Request) {
              span.setAttribute('http.request.method', request.method)
            }
          },
        })
      )
    }

    // Document load instrumentation
    if (finalConfig.traceDocumentLoad) {
      instrumentations.push(new DocumentLoadInstrumentation())
    }

    // Register all instrumentations
    registerInstrumentations({
      tracerProvider: provider,
      instrumentations,
    })

    isInitialized = true
    console.info(
      `[FrontendTracer] Initialized successfully for service '${finalConfig.serviceName}'`
    )
  } catch (error) {
    console.error('[FrontendTracer] Failed to initialize:', error)
    throw error
  }
}

/**
 * Check if the frontend tracer has been initialized.
 *
 * @returns true if initialized, false otherwise
 */
export function isFrontendTracerInitialized(): boolean {
  return isInitialized
}

// Tracer name for manual spans
const TRACER_NAME = 'wegent-frontend-manual'

/**
 * Get the tracer instance for creating manual spans.
 * Returns a tracer that can be used to create spans for local actions.
 *
 * @returns The tracer instance
 */
export function getTracer() {
  return trace.getTracer(TRACER_NAME)
}

/**
 * Trace a local action that doesn't involve network requests.
 * Use this for actions like copy to clipboard, local storage operations, etc.
 *
 * @param name - The name of the action (e.g., 'copy-to-clipboard', 'download-file')
 * @param attributes - Optional attributes to add to the span
 * @param fn - The function to execute within the span context
 * @returns The result of the function
 *
 * @example
 * ```typescript
 * // Trace a copy action
 * const handleCopy = async () => {
 *   await traceLocalAction('copy-message', { 'message.id': messageId }, async () => {
 *     await navigator.clipboard.writeText(text)
 *   })
 * }
 * ```
 */
export async function traceLocalAction<T>(
  name: string,
  attributes: Attributes,
  fn: () => T | Promise<T>
): Promise<T> {
  // If telemetry is not enabled or not initialized, just run the function
  if (!isInitialized) {
    return fn()
  }

  const tracer = getTracer()
  const span = tracer.startSpan(name, {
    attributes: {
      'action.type': 'local',
      ...attributes,
    },
  })

  try {
    const result = await fn()
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    })
    span.recordException(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    span.end()
  }
}

/**
 * Trace a synchronous local action.
 * Use this for synchronous operations that don't involve async/await.
 *
 * @param name - The name of the action
 * @param attributes - Optional attributes to add to the span
 * @param fn - The synchronous function to execute
 * @returns The result of the function
 *
 * @example
 * ```typescript
 * // Trace a local storage operation
 * const saveToLocalStorage = () => {
 *   traceLocalActionSync('save-settings', { 'settings.key': 'theme' }, () => {
 *     localStorage.setItem('theme', 'dark')
 *   })
 * }
 * ```
 */
export function traceLocalActionSync<T>(name: string, attributes: Attributes, fn: () => T): T {
  // If telemetry is not enabled or not initialized, just run the function
  if (!isInitialized) {
    return fn()
  }

  const tracer = getTracer()
  const span = tracer.startSpan(name, {
    attributes: {
      'action.type': 'local',
      ...attributes,
    },
  })

  try {
    const result = fn()
    span.setStatus({ code: SpanStatusCode.OK })
    return result
  } catch (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    })
    span.recordException(error instanceof Error ? error : new Error(String(error)))
    throw error
  } finally {
    span.end()
  }
}

/**
 * Create a span for manual tracing with full control.
 * Use this when you need more control over the span lifecycle.
 *
 * @param name - The name of the span
 * @param attributes - Optional attributes to add to the span
 * @returns The span instance, or undefined if telemetry is disabled
 *
 * @example
 * ```typescript
 * // Manual span management
 * const span = createSpan('complex-operation', { 'operation.type': 'copy' })
 * try {
 *   // ... do work ...
 *   span?.setStatus({ code: SpanStatusCode.OK })
 * } catch (error) {
 *   span?.setStatus({ code: SpanStatusCode.ERROR, message: error.message })
 *   span?.recordException(error)
 * } finally {
 *   span?.end()
 * }
 * ```
 */
export function createSpan(name: string, attributes?: Attributes): Span | undefined {
  if (!isInitialized) {
    return undefined
  }

  const tracer = getTracer()
  return tracer.startSpan(name, { attributes })
}

/**
 * Default export for convenience
 */
export default initFrontendTracer
