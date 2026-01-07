import { Page } from '@playwright/test'

/**
 * Performance metrics interface
 */
export interface PerformanceMetrics {
  loadTime: number
  domContentLoaded: number
  firstContentfulPaint: number
  largestContentfulPaint: number
  timeToInteractive: number
  totalBlockingTime: number
  resourceCount: number
  totalTransferSize: number
}

/**
 * API timing interface
 */
export interface ApiTiming {
  url: string
  method: string
  duration: number
  status: number
}

/**
 * Performance Monitor class for measuring page and API performance
 */
export class PerformanceMonitor {
  private apiTimings: ApiTiming[] = []
  private isListening: boolean = false

  constructor(private page: Page) {}

  /**
   * Start listening to API requests
   */
  startListening(): void {
    if (this.isListening) return
    this.isListening = true

    this.page.on('request', request => {
      if (request.url().includes('/api/')) {
        ;(request as unknown as { _startTime: number })._startTime = Date.now()
      }
    })

    this.page.on('response', response => {
      const request = response.request()
      if (request.url().includes('/api/')) {
        const startTime = (request as unknown as { _startTime?: number })._startTime || Date.now()
        this.apiTimings.push({
          url: request.url(),
          method: request.method(),
          duration: Date.now() - startTime,
          status: response.status(),
        })
      }
    })
  }

  /**
   * Stop listening to API requests
   */
  stopListening(): void {
    this.isListening = false
    // Note: Playwright doesn't have a direct way to remove specific listeners
    // The listeners will be cleaned up when the page is closed
  }

  /**
   * Measure page load performance metrics
   */
  async measurePageLoad(): Promise<PerformanceMetrics> {
    const metrics = await this.page.evaluate(() => {
      const timing = performance.timing
      const paint = performance.getEntriesByType('paint')
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[]

      // Calculate FCP
      const fcp = paint.find(p => p.name === 'first-contentful-paint')?.startTime || 0

      // Calculate total transfer size
      const totalTransferSize = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0)

      return {
        loadTime: timing.loadEventEnd - timing.navigationStart,
        domContentLoaded: timing.domContentLoadedEventEnd - timing.navigationStart,
        firstContentfulPaint: fcp,
        largestContentfulPaint: 0, // Requires PerformanceObserver
        timeToInteractive: 0, // Requires calculation
        totalBlockingTime: 0, // Requires calculation
        resourceCount: resources.length,
        totalTransferSize,
      }
    })

    return metrics
  }

  /**
   * Measure a specific API call duration
   */
  async measureApiCall<T>(apiCall: () => Promise<T>): Promise<{ result: T; duration: number }> {
    const start = Date.now()
    const result = await apiCall()
    const duration = Date.now() - start
    return { result, duration }
  }

  /**
   * Get all recorded API timings
   */
  getApiTimings(): ApiTiming[] {
    return [...this.apiTimings]
  }

  /**
   * Get average API response time
   */
  getAverageApiTime(): number {
    if (this.apiTimings.length === 0) return 0
    const total = this.apiTimings.reduce((sum, timing) => sum + timing.duration, 0)
    return total / this.apiTimings.length
  }

  /**
   * Get slowest API calls
   */
  getSlowestApiCalls(count: number = 5): ApiTiming[] {
    return [...this.apiTimings].sort((a, b) => b.duration - a.duration).slice(0, count)
  }

  /**
   * Clear API timings
   */
  clearApiTimings(): void {
    this.apiTimings = []
  }

  /**
   * Log performance metrics to console
   */
  async logMetrics(testName: string): Promise<void> {
    const metrics = await this.measurePageLoad()

    console.log(`\n📊 Performance Metrics for ${testName}:`)
    console.log(`  Load Time: ${metrics.loadTime}ms`)
    console.log(`  DOM Content Loaded: ${metrics.domContentLoaded}ms`)
    console.log(`  First Contentful Paint: ${metrics.firstContentfulPaint}ms`)
    console.log(`  Resource Count: ${metrics.resourceCount}`)
    console.log(`  Total Transfer Size: ${(metrics.totalTransferSize / 1024).toFixed(2)}KB`)

    if (this.apiTimings.length > 0) {
      console.log(`\n⚡ API Performance:`)
      console.log(`  Total API Calls: ${this.apiTimings.length}`)
      console.log(`  Average Response Time: ${this.getAverageApiTime().toFixed(2)}ms`)

      const slowest = this.getSlowestApiCalls(3)
      if (slowest.length > 0) {
        console.log(`  Slowest Calls:`)
        slowest.forEach((timing, i) => {
          console.log(`    ${i + 1}. ${timing.method} ${timing.url} - ${timing.duration}ms`)
        })
      }
    }
  }

  /**
   * Assert that page load time is within acceptable range
   */
  assertLoadTime(metrics: PerformanceMetrics, maxLoadTime: number = 3000): void {
    if (metrics.loadTime > maxLoadTime) {
      throw new Error(`Page load time ${metrics.loadTime}ms exceeds maximum ${maxLoadTime}ms`)
    }
  }

  /**
   * Assert that DOM content loaded time is within acceptable range
   */
  assertDomContentLoaded(metrics: PerformanceMetrics, maxTime: number = 2000): void {
    if (metrics.domContentLoaded > maxTime) {
      throw new Error(
        `DOM content loaded time ${metrics.domContentLoaded}ms exceeds maximum ${maxTime}ms`
      )
    }
  }

  /**
   * Assert that FCP is within acceptable range
   */
  assertFirstContentfulPaint(metrics: PerformanceMetrics, maxFcp: number = 2000): void {
    if (metrics.firstContentfulPaint > maxFcp) {
      throw new Error(
        `First Contentful Paint ${metrics.firstContentfulPaint}ms exceeds maximum ${maxFcp}ms`
      )
    }
  }

  /**
   * Assert that all API calls are within acceptable range
   */
  assertApiResponseTimes(maxTime: number = 1000): void {
    const slow = this.apiTimings.filter(timing => timing.duration > maxTime)
    if (slow.length > 0) {
      const details = slow.map(t => `${t.method} ${t.url}: ${t.duration}ms`).join('\n  ')
      throw new Error(`${slow.length} API calls exceeded ${maxTime}ms:\n  ${details}`)
    }
  }

  /**
   * Generate performance report object
   */
  async generateReport(testName: string): Promise<{
    testName: string
    timestamp: string
    pageMetrics: PerformanceMetrics
    apiMetrics: {
      totalCalls: number
      averageTime: number
      slowestCalls: ApiTiming[]
    }
  }> {
    const pageMetrics = await this.measurePageLoad()
    return {
      testName,
      timestamp: new Date().toISOString(),
      pageMetrics,
      apiMetrics: {
        totalCalls: this.apiTimings.length,
        averageTime: this.getAverageApiTime(),
        slowestCalls: this.getSlowestApiCalls(5),
      },
    }
  }
}

/**
 * Create a performance monitor instance
 */
export function createPerformanceMonitor(page: Page): PerformanceMonitor {
  return new PerformanceMonitor(page)
}

/**
 * Performance thresholds configuration
 */
// CI environments are typically slower, so we use higher thresholds
const isCI = process.env.CI === 'true'
const ciMultiplier = isCI ? 2 : 1

export const PerformanceThresholds = {
  pageLoad: {
    fast: 1000 * ciMultiplier,
    acceptable: 3000 * ciMultiplier,
    slow: 5000 * ciMultiplier,
  },
  domContentLoaded: {
    fast: 500 * ciMultiplier,
    acceptable: 2000 * ciMultiplier,
    slow: 4000 * ciMultiplier,
  },
  firstContentfulPaint: {
    fast: 1000 * ciMultiplier,
    acceptable: 2500 * ciMultiplier,
    slow: 4000 * ciMultiplier,
  },
  apiResponse: {
    fast: 200 * ciMultiplier,
    acceptable: 1000 * ciMultiplier,
    slow: 3000 * ciMultiplier,
  },
}
