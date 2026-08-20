import type { EmbeddedBrowserBounds } from '@/lib/embedded-browser'

// Device presets mirror the Codex in-app browser device toolbar.
export interface BrowserDevicePreset {
  id: string
  labelKey: string | null
  width: number
  height: number
}

export const BROWSER_DEVICE_PRESET_RESPONSIVE = 'responsive'

export const BROWSER_DEVICE_PRESETS: BrowserDevicePreset[] = [
  { id: BROWSER_DEVICE_PRESET_RESPONSIVE, labelKey: null, width: 390, height: 844 },
  {
    id: 'iphone-se',
    labelKey: 'workbench.browser_device_preset_iphone_se',
    width: 375,
    height: 667,
  },
  {
    id: 'iphone-15-pro',
    labelKey: 'workbench.browser_device_preset_iphone_15_pro',
    width: 393,
    height: 852,
  },
  {
    id: 'iphone-15-pro-max',
    labelKey: 'workbench.browser_device_preset_iphone_15_pro_max',
    width: 430,
    height: 932,
  },
  { id: 'pixel-8', labelKey: 'workbench.browser_device_preset_pixel_8', width: 412, height: 915 },
  {
    id: 'ipad-mini',
    labelKey: 'workbench.browser_device_preset_ipad_mini',
    width: 768,
    height: 1024,
  },
  {
    id: 'ipad-air',
    labelKey: 'workbench.browser_device_preset_ipad_air',
    width: 820,
    height: 1180,
  },
  {
    id: 'surface-duo',
    labelKey: 'workbench.browser_device_preset_surface_duo',
    width: 540,
    height: 720,
  },
  {
    id: 'surface-pro-7',
    labelKey: 'workbench.browser_device_preset_surface_pro_7',
    width: 912,
    height: 1368,
  },
  { id: 'laptop', labelKey: 'workbench.browser_device_preset_laptop', width: 1024, height: 768 },
  {
    id: 'laptop-l',
    labelKey: 'workbench.browser_device_preset_laptop_l',
    width: 1440,
    height: 900,
  },
  { id: '4k', labelKey: 'workbench.browser_device_preset_4k', width: 2560, height: 1440 },
]

// Input ranges match the Codex device toolbar.
export const BROWSER_DEVICE_MIN_WIDTH = 240
export const BROWSER_DEVICE_MIN_HEIGHT = 160
export const BROWSER_DEVICE_MAX_DIMENSION = 4096

// Page-zoom options offered by the device toolbar zoom select, as in Codex.
export const BROWSER_DEVICE_ZOOM_OPTIONS = [50, 75, 100, 125, 150, 200] as const
export type BrowserDeviceResizeEdge = 'left' | 'right' | 'bottom' | 'bottom-left' | 'bottom-right'

export interface BrowserDeviceToolbarState {
  isEnabled: boolean
  presetId: string
  width: number
  height: number
}

export function defaultBrowserDeviceToolbarState(): BrowserDeviceToolbarState {
  const responsive = BROWSER_DEVICE_PRESETS[0]
  return {
    isEnabled: false,
    presetId: responsive.id,
    width: responsive.width,
    height: responsive.height,
  }
}

export function resolveDevicePreset(presetId: string): BrowserDevicePreset | null {
  return BROWSER_DEVICE_PRESETS.find(preset => preset.id === presetId) ?? null
}

export function matchDevicePresetId(width: number, height: number): string {
  const matched = BROWSER_DEVICE_PRESETS.find(
    preset =>
      preset.id !== BROWSER_DEVICE_PRESET_RESPONSIVE &&
      preset.width === width &&
      preset.height === height
  )
  return matched?.id ?? BROWSER_DEVICE_PRESET_RESPONSIVE
}

export function clampDeviceDimension(
  value: number,
  min: number,
  max = BROWSER_DEVICE_MAX_DIMENSION
): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

export function deviceZoomOptions(currentZoomPercent: number): number[] {
  if ((BROWSER_DEVICE_ZOOM_OPTIONS as readonly number[]).includes(currentZoomPercent)) {
    return [...BROWSER_DEVICE_ZOOM_OPTIONS]
  }
  return [...BROWSER_DEVICE_ZOOM_OPTIONS, currentZoomPercent].sort((a, b) => a - b)
}

export interface DeviceViewportPlacement {
  /** Bounds the native webview should occupy (real layout viewport). */
  webviewBounds: EmbeddedBrowserBounds
  /** Auto-fit scale used to translate pointer movement into device dimensions. */
  fitScale: number
  /** Combined scale (auto-fit x page zoom) applied through the webview zoom. */
  scale: number
  /** Visually occupied rect inside the host, used for handles and backdrop. */
  visualRect: { x: number; y: number; width: number; height: number }
}

export function resolveDeviceFitScale(
  host: EmbeddedBrowserBounds,
  width: number,
  height: number
): number {
  return Math.min(1, host.width / width, host.height / height)
}

export function resizeDeviceDimensions(
  edge: BrowserDeviceResizeEdge,
  startWidth: number,
  startHeight: number,
  pointerDeltaX: number,
  pointerDeltaY: number,
  fitScale: number
): { width: number; height: number } {
  const scale = fitScale || 1
  const deltaX = pointerDeltaX / scale
  const deltaY = pointerDeltaY / scale
  let width = startWidth
  let height = startHeight
  if (edge.includes('right')) width += deltaX
  if (edge.includes('left')) width -= deltaX
  if (edge.includes('bottom')) height += deltaY
  return { width, height }
}

export function computeDeviceViewportPlacement(
  host: EmbeddedBrowserBounds,
  state: Pick<BrowserDeviceToolbarState, 'width' | 'height'>,
  pageZoomPercent: number
): DeviceViewportPlacement | null {
  const width = clampDeviceDimension(state.width, BROWSER_DEVICE_MIN_WIDTH)
  const height = clampDeviceDimension(state.height, BROWSER_DEVICE_MIN_HEIGHT)
  if (host.width < 1 || host.height < 1) return null
  // The fit scale shrinks the device viewport so it fits inside the host.
  // Page zoom magnifies the page content but must NOT enlarge the webview
  // bounds (otherwise the zoomed webview overflows the host). The webview
  // stays clipped to the fit rect; only the native zoom factor changes.
  const fitScale = resolveDeviceFitScale(host, width, height)
  const pageZoom = pageZoomPercent / 100
  const scale = fitScale * pageZoom
  const visualWidth = Math.max(1, Math.round(width * fitScale))
  const visualHeight = Math.max(1, Math.round(height * fitScale))
  const visualX = host.x + (host.width - visualWidth) / 2
  const visualY = host.y + (host.height - visualHeight) / 2
  // The webview occupies the fit rect (clipped inside the host); the native
  // zoom (scale) magnifies the page content within that rect, so the device
  // CSS viewport stays exact and overflow never leaves the host.
  return {
    webviewBounds: {
      x: Math.round(visualX),
      y: Math.round(visualY),
      width: visualWidth,
      height: visualHeight,
    },
    fitScale,
    scale,
    visualRect: {
      x: Math.round(visualX),
      y: Math.round(visualY),
      width: visualWidth,
      height: visualHeight,
    },
  }
}
