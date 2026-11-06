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

export function startupWindowLayout(workArea: WindowViewBounds): {
  bounds: WindowViewBounds
  maximized: boolean
} {
  const preferredWidth = 1440
  const preferredHeight = 960
  return {
    bounds: centeredWindowBounds({ width: preferredWidth, height: preferredHeight }, workArea),
    // A window that fills an available axis needs the system's maximized frame.
    maximized: preferredWidth >= workArea.width || preferredHeight >= workArea.height,
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
