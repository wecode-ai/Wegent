import { Page, expect } from '@playwright/test'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Visual comparison options
 */
export interface VisualCompareOptions {
  maxDiffPixels?: number
  threshold?: number
  fullPage?: boolean
}

/**
 * Visual Regression testing class
 * Provides methods for capturing and comparing screenshots
 */
export class VisualRegression {
  private baselineDir: string
  private diffDir: string

  constructor(
    private page: Page,
    basePath: string = path.join(process.cwd(), 'e2e/screenshots')
  ) {
    this.baselineDir = path.join(basePath, 'baseline')
    this.diffDir = path.join(basePath, 'diff')
    this.ensureDirectories()
  }

  /**
   * Ensure screenshot directories exist
   */
  private ensureDirectories(): void {
    if (!fs.existsSync(this.baselineDir)) {
      fs.mkdirSync(this.baselineDir, { recursive: true })
    }
    if (!fs.existsSync(this.diffDir)) {
      fs.mkdirSync(this.diffDir, { recursive: true })
    }
  }

  /**
   * Capture a baseline screenshot
   */
  async captureBaseline(name: string, fullPage: boolean = true): Promise<string> {
    const filePath = path.join(this.baselineDir, `${name}.png`)
    await this.page.screenshot({
      path: filePath,
      fullPage,
    })
    return filePath
  }

  /**
   * Compare current page with baseline screenshot
   */
  async compareWithBaseline(name: string, options: VisualCompareOptions = {}): Promise<void> {
    const { maxDiffPixels = 100, threshold = 0.2, fullPage = true } = options

    // Use Playwright's built-in visual comparison
    await expect(this.page).toHaveScreenshot(`${name}.png`, {
      maxDiffPixels,
      threshold,
      fullPage,
    })
  }

  /**
   * Capture screenshot of a specific element
   */
  async captureElement(selector: string, name: string): Promise<string> {
    const element = this.page.locator(selector)
    const filePath = path.join(this.baselineDir, `${name}-element.png`)
    await element.screenshot({
      path: filePath,
    })
    return filePath
  }

  /**
   * Compare a specific element with baseline
   */
  async compareElement(
    selector: string,
    name: string,
    options: VisualCompareOptions = {}
  ): Promise<void> {
    const { maxDiffPixels = 50, threshold = 0.2 } = options
    const element = this.page.locator(selector)
    await expect(element).toHaveScreenshot(`${name}-element.png`, {
      maxDiffPixels,
      threshold,
    })
  }

  /**
   * Capture screenshot with custom viewport
   */
  async captureWithViewport(
    name: string,
    viewport: { width: number; height: number }
  ): Promise<string> {
    const originalViewport = this.page.viewportSize()

    await this.page.setViewportSize(viewport)
    const filePath = await this.captureBaseline(name)

    // Restore original viewport
    if (originalViewport) {
      await this.page.setViewportSize(originalViewport)
    }

    return filePath
  }

  /**
   * Capture mobile viewport screenshot
   */
  async captureMobile(name: string): Promise<string> {
    return this.captureWithViewport(`${name}-mobile`, { width: 375, height: 812 })
  }

  /**
   * Capture tablet viewport screenshot
   */
  async captureTablet(name: string): Promise<string> {
    return this.captureWithViewport(`${name}-tablet`, { width: 768, height: 1024 })
  }

  /**
   * Capture desktop viewport screenshot
   */
  async captureDesktop(name: string): Promise<string> {
    return this.captureWithViewport(`${name}-desktop`, { width: 1920, height: 1080 })
  }

  /**
   * Compare across multiple viewports
   */
  async compareResponsive(
    name: string,
    viewports: { name: string; width: number; height: number }[]
  ): Promise<void> {
    const originalViewport = this.page.viewportSize()

    for (const viewport of viewports) {
      await this.page.setViewportSize({ width: viewport.width, height: viewport.height })
      await this.compareWithBaseline(`${name}-${viewport.name}`)
    }

    // Restore original viewport
    if (originalViewport) {
      await this.page.setViewportSize(originalViewport)
    }
  }

  /**
   * Mask sensitive elements before screenshot
   */
  async captureWithMask(
    name: string,
    maskSelectors: string[],
    fullPage: boolean = true
  ): Promise<string> {
    // Add mask overlay to sensitive elements
    for (const selector of maskSelectors) {
      await this.page.evaluate(sel => {
        const elements = document.querySelectorAll(sel)
        elements.forEach(el => {
          const elem = el as HTMLElement
          elem.style.backgroundColor = '#000'
          elem.style.color = '#000'
        })
      }, selector)
    }

    const filePath = await this.captureBaseline(name, fullPage)

    // Remove masks by reloading styles
    await this.page.reload()

    return filePath
  }

  /**
   * Get list of baseline screenshots
   */
  getBaselineList(): string[] {
    if (!fs.existsSync(this.baselineDir)) {
      return []
    }
    return fs.readdirSync(this.baselineDir).filter(f => f.endsWith('.png'))
  }

  /**
   * Check if baseline exists
   */
  baselineExists(name: string): boolean {
    return fs.existsSync(path.join(this.baselineDir, `${name}.png`))
  }

  /**
   * Delete baseline screenshot
   */
  deleteBaseline(name: string): void {
    const filePath = path.join(this.baselineDir, `${name}.png`)
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath)
    }
  }

  /**
   * Clear all baselines
   */
  clearBaselines(): void {
    if (fs.existsSync(this.baselineDir)) {
      const files = fs.readdirSync(this.baselineDir)
      files.forEach(file => {
        fs.unlinkSync(path.join(this.baselineDir, file))
      })
    }
  }

  /**
   * Clear all diff screenshots
   */
  clearDiffs(): void {
    if (fs.existsSync(this.diffDir)) {
      const files = fs.readdirSync(this.diffDir)
      files.forEach(file => {
        fs.unlinkSync(path.join(this.diffDir, file))
      })
    }
  }
}

/**
 * Create a visual regression instance
 */
export function createVisualRegression(page: Page, basePath?: string): VisualRegression {
  return new VisualRegression(page, basePath)
}

/**
 * Common viewport configurations
 */
export const ViewportConfigs = {
  mobile: { name: 'mobile', width: 375, height: 812 },
  mobileS: { name: 'mobile-s', width: 320, height: 568 },
  mobileL: { name: 'mobile-l', width: 425, height: 896 },
  tablet: { name: 'tablet', width: 768, height: 1024 },
  laptop: { name: 'laptop', width: 1024, height: 768 },
  laptopL: { name: 'laptop-l', width: 1440, height: 900 },
  desktop: { name: 'desktop', width: 1920, height: 1080 },
  desktop4K: { name: 'desktop-4k', width: 2560, height: 1440 },
}

/**
 * Standard responsive viewports for testing
 */
export const ResponsiveViewports = [
  ViewportConfigs.mobile,
  ViewportConfigs.tablet,
  ViewportConfigs.laptop,
  ViewportConfigs.desktop,
]
