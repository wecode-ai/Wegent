/**
 * Code coverage helper for E2E tests
 * Collects coverage data from the browser during Playwright tests
 */

import { Page } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

const coverageDir = path.join(process.cwd(), '.nyc_output')

/**
 * Initialize coverage collection for a page
 */
export async function startCoverage(page: Page): Promise<void> {
  // Enable JavaScript coverage
  await page.coverage.startJSCoverage({
    resetOnNavigation: false,
  })
}

/**
 * Stop coverage collection and save results
 */
export async function stopCoverage(page: Page, testName: string): Promise<void> {
  try {
    const coverage = await page.coverage.stopJSCoverage()

    // Ensure coverage directory exists
    if (!fs.existsSync(coverageDir)) {
      fs.mkdirSync(coverageDir, { recursive: true })
    }

    // Filter coverage to only include our source files
    const filteredCoverage = coverage.filter(entry => {
      const url = entry.url
      // Only include files from our source code
      return (
        url.includes('/src/') &&
        !url.includes('node_modules') &&
        !url.includes('webpack') &&
        !url.includes('next/dist')
      )
    })

    if (filteredCoverage.length === 0) {
      return
    }

    // Convert Playwright coverage format to Istanbul format
    const istanbulCoverage: Record<string, unknown> = {}

    for (const entry of filteredCoverage) {
      const url = new URL(entry.url)
      // Extract file path from URL
      let filePath = url.pathname

      // Remove leading /_next/ or similar prefixes
      filePath = filePath.replace(/^\/_next\//, '')
      filePath = filePath.replace(/^\//, '')

      // Try to map back to source file
      if (filePath.startsWith('static/')) {
        continue // Skip webpack chunks
      }

      // Create Istanbul-compatible coverage object
      const functions: Record<string, number> = {}
      const statements: Record<string, number> = {}
      const branches: Record<string, number> = {}

      let statementIndex = 0
      for (const func of entry.functions) {
        for (const range of func.ranges) {
          statements[statementIndex] = range.count
          statementIndex++
        }
      }

      istanbulCoverage[entry.url] = {
        path: entry.url,
        statementMap: {},
        fnMap: functions,
        branchMap: branches,
        s: statements,
        f: {},
        b: {},
      }
    }

    // Save coverage data
    const sanitizedTestName = testName.replace(/[^a-z0-9]/gi, '_')
    const coverageFile = path.join(coverageDir, `coverage-${sanitizedTestName}-${Date.now()}.json`)

    fs.writeFileSync(coverageFile, JSON.stringify(istanbulCoverage, null, 2))
  } catch (error) {
    console.warn('Failed to collect coverage:', error)
  }
}

/**
 * Merge all coverage files
 */
export function mergeCoverage(): void {
  // This would typically be done by nyc/istanbul
  console.log('Coverage files saved to:', coverageDir)
  console.log('Run "npx nyc report" to generate coverage reports')
}
