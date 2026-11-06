import type { BrowserWindow, Rectangle } from 'electron'

type MainWindow = Pick<
  BrowserWindow,
  | 'getBounds'
  | 'getMediaSourceId'
  | 'hide'
  | 'isDestroyed'
  | 'maximize'
  | 'setBounds'
  | 'setOpacity'
  | 'showInactive'
  | 'webContents'
>
type SplashWindow = Pick<BrowserWindow, 'getBounds' | 'isMaximized' | 'moveAbove'>

export interface StartupWindowBounds {
  splash: Rectangle
  main: Rectangle
}

/** Presents a painted main window beneath the still-opaque splash without stealing focus. */
export async function prepareStartupMainWindow(
  main: MainWindow,
  splash: SplashWindow,
  show: boolean
): Promise<StartupWindowBounds> {
  const bounds = splash.getBounds()
  main.setOpacity(0)
  try {
    if (show) {
      main.showInactive()
    }
    // Initial native mapping may normalize hidden-window bounds, so align after showing.
    main.setBounds(bounds)
    if (show && splash.isMaximized()) main.maximize()
    if (show) splash.moveAbove(main.getMediaSourceId())
    // Capturing forces a composited frame even when Windows suspends rAF in an occluded window.
    const frame = await main.webContents.capturePage()
    if (frame.isEmpty()) throw new Error('The startup destination did not produce a frame')
    return { splash: bounds, main: main.getBounds() }
  } catch (error) {
    if (!main.isDestroyed()) main.hide()
    throw error
  } finally {
    if (!main.isDestroyed()) main.setOpacity(1)
  }
}
