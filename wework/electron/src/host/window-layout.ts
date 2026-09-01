import type { BrowserWindowConstructorOptions } from 'electron'

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
