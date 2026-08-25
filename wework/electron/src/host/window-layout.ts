import type { BrowserWindowConstructorOptions } from 'electron'

export const CORE_TAB_STRIP_HEIGHT = 38

export interface WindowContentSize {
  width: number
  height: number
}

export interface WindowViewBounds extends WindowContentSize {
  x: number
  y: number
}

export function primaryDshBounds({ width, height }: WindowContentSize): WindowViewBounds {
  return {
    x: 0,
    y: 0,
    width,
    height,
  }
}

export function workbenchDshBounds(size: WindowContentSize): WindowViewBounds {
  const primary = primaryDshBounds(size)
  return {
    ...primary,
    y: CORE_TAB_STRIP_HEIGHT,
    height: Math.max(0, primary.height - CORE_TAB_STRIP_HEIGHT),
  }
}

export function desktopWindowFrameOptions(
  platform: NodeJS.Platform = process.platform
): Pick<BrowserWindowConstructorOptions, 'frame' | 'titleBarStyle' | 'trafficLightPosition'> {
  if (platform === 'darwin') {
    return {
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
