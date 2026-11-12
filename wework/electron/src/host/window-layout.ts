import type { BrowserWindowConstructorOptions } from 'electron'

export interface WindowContentSize {
  width: number
  height: number
}

export interface WindowViewBounds extends WindowContentSize {
  x: number
  y: number
}

export function centeredWindowBounds(
  size: WindowContentSize,
  workArea: WindowViewBounds
): WindowViewBounds {
  const width = Math.min(size.width, workArea.width)
  const height = Math.min(size.height, workArea.height)
  return {
    x: workArea.x + Math.floor((workArea.width - width) / 2),
    y: workArea.y + Math.floor((workArea.height - height) / 2),
    width,
    height,
  }
}

export interface MainWindowState {
  bounds: WindowViewBounds
  maximized: boolean
}

export function readMainWindowState(value: unknown): MainWindowState | null {
  if (!value || typeof value !== 'object') return null
  const { bounds, maximized } = value as Partial<MainWindowState>
  if (!bounds || typeof maximized !== 'boolean') return null
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isSafeInteger)) return null
  if (bounds.width <= 0 || bounds.height <= 0) return null
  return {
    bounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
    maximized,
  }
}

export function startupWindowLayout(
  workArea: WindowViewBounds,
  savedState?: unknown,
  workAreas: WindowViewBounds[] = [workArea]
): {
  bounds: WindowViewBounds
  maximized: boolean
} {
  const saved = readMainWindowState(savedState)
  if (saved) {
    const overlap = (area: WindowViewBounds) =>
      Math.max(
        0,
        Math.min(area.x + area.width, saved.bounds.x + saved.bounds.width) -
          Math.max(area.x, saved.bounds.x)
      ) *
      Math.max(
        0,
        Math.min(area.y + area.height, saved.bounds.y + saved.bounds.height) -
          Math.max(area.y, saved.bounds.y)
      )
    const area = workAreas.reduce(
      (best, candidate) => (overlap(candidate) > overlap(best) ? candidate : best),
      workArea
    )
    const width = Math.min(saved.bounds.width, area.width)
    const height = Math.min(saved.bounds.height, area.height)
    return {
      bounds: {
        x: Math.max(area.x, Math.min(saved.bounds.x, area.x + area.width - width)),
        y: Math.max(area.y, Math.min(saved.bounds.y, area.y + area.height - height)),
        width,
        height,
      },
      maximized: saved.maximized,
    }
  }
  return {
    bounds: centeredWindowBounds(
      {
        width: Math.min(1440, Math.floor(workArea.width * 0.9)),
        height: Math.min(960, Math.floor(workArea.height * 0.9)),
      },
      workArea
    ),
    maximized: false,
  }
}

export function primaryDshBounds({ width, height }: WindowContentSize): WindowViewBounds {
  return {
    x: 0,
    y: 0,
    width,
    height,
  }
}

export function desktopWindowFrameOptions(
  platform: NodeJS.Platform = process.platform
): Pick<
  BrowserWindowConstructorOptions,
  'acceptFirstMouse' | 'frame' | 'titleBarStyle' | 'trafficLightPosition'
> {
  if (platform === 'darwin') {
    return {
      acceptFirstMouse: true,
      frame: true,
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 12 },
    }
  }

  return {
    frame: false,
    titleBarStyle: 'hidden',
  }
}
