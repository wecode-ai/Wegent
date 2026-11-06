import type { BrowserWindow, NativeImage, Rectangle } from 'electron'

type GeometryWindow = Pick<
  BrowserWindow,
  | 'getBounds'
  | 'getContentBounds'
  | 'getContentSize'
  | 'getNormalBounds'
  | 'isDestroyed'
  | 'isFocused'
  | 'isMaximized'
  | 'isMinimized'
  | 'isVisible'
> & { webContents: Pick<BrowserWindow['webContents'], 'getZoomFactor' | 'isDestroyed'> }

type MainWindow = GeometryWindow &
  Pick<
    BrowserWindow,
    | 'getMediaSourceId'
    | 'hide'
    | 'isDestroyed'
    | 'maximize'
    | 'on'
    | 'removeListener'
    | 'setBounds'
    | 'setOpacity'
    | 'showInactive'
    | 'webContents'
  >
type SplashWindow = GeometryWindow & Pick<BrowserWindow, 'moveAbove'>

export interface StartupWindowBounds {
  splash: Rectangle
  main: Rectangle
}

export interface StartupWindowGeometry {
  bounds: Rectangle
  contentBounds: Rectangle
  normalBounds: Rectangle
  contentSize: { width: number; height: number }
  zoomFactor: number | null
  visible: boolean
  focused: boolean
  minimized: boolean
  maximized: boolean
}

export interface StartupWindowHandoffTrace {
  phase:
    | 'before-map'
    | 'after-opacity-hide'
    | 'before-show'
    | 'after-show'
    | 'before-set-bounds'
    | 'after-set-bounds'
    | 'before-maximize'
    | 'after-maximize'
    | 'before-stack'
    | 'after-stack'
    | 'before-capture'
    | 'after-capture'
    | 'capture-failed'
    | 'native-resize'
    | 'native-move'
    | 'destination-hidden'
    | 'before-opacity-restore'
    | 'after-opacity-restore'
  requestedBounds: Rectangle
  main: StartupWindowGeometry | null
  splash: StartupWindowGeometry | null
  nativeEvents: { observed: number; omitted: number }
  capturedFrameSize?: { width: number; height: number }
  error?: { name: string; message: string }
}

function windowGeometry(window: GeometryWindow): StartupWindowGeometry | null {
  if (window.isDestroyed()) return null
  const [width, height] = window.getContentSize()
  return {
    bounds: { ...window.getBounds() },
    contentBounds: { ...window.getContentBounds() },
    normalBounds: { ...window.getNormalBounds() },
    contentSize: { width, height },
    zoomFactor: window.webContents.isDestroyed() ? null : window.webContents.getZoomFactor(),
    visible: window.isVisible(),
    focused: window.isFocused(),
    minimized: window.isMinimized(),
    maximized: window.isMaximized(),
  }
}

function diagnosticError(error: unknown): { name: string; message: string } {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: 'Error', message: String(error) }
}

function createGeometryTracer(
  main: MainWindow,
  splash: SplashWindow,
  requestedBounds: Rectangle,
  onTrace?: (event: StartupWindowHandoffTrace) => void
) {
  const nativeEvents = { observed: 0, omitted: 0 }
  const record = (
    phase: StartupWindowHandoffTrace['phase'],
    error?: unknown,
    frame?: Pick<NativeImage, 'getSize'>
  ) => {
    if (!onTrace) return
    try {
      onTrace({
        phase,
        requestedBounds: { ...requestedBounds },
        main: windowGeometry(main),
        splash: windowGeometry(splash),
        nativeEvents: { ...nativeEvents },
        ...(frame ? { capturedFrameSize: frame.getSize() } : {}),
        ...(error === undefined ? {} : { error: diagnosticError(error) }),
      })
    } catch (traceError) {
      console.error('[startup-window-handoff] Could not record native geometry', {
        phase,
        error: diagnosticError(traceError),
      })
    }
  }
  const nativeEvent = (phase: 'native-resize' | 'native-move') => {
    nativeEvents.observed += 1
    if (nativeEvents.observed > 32) nativeEvents.omitted += 1
    else record(phase)
  }
  const resize = () => nativeEvent('native-resize')
  const move = () => nativeEvent('native-move')
  if (onTrace) {
    main.on('resize', resize)
    main.on('move', move)
  }
  return {
    record,
    dispose: () => {
      if (!onTrace) return
      main.removeListener('resize', resize)
      main.removeListener('move', move)
    },
  }
}

/** Presents a painted main window beneath the still-opaque splash without stealing focus. */
export async function prepareStartupMainWindow(
  main: MainWindow,
  splash: SplashWindow,
  show: boolean,
  onTrace?: (event: StartupWindowHandoffTrace) => void
): Promise<StartupWindowBounds> {
  const bounds = splash.getBounds()
  const trace = createGeometryTracer(main, splash, bounds, onTrace)
  try {
    trace.record('before-map')
    main.setOpacity(0)
    trace.record('after-opacity-hide')
    try {
      if (show) {
        trace.record('before-show')
        main.showInactive()
        trace.record('after-show')
      }
      // Initial native mapping may normalize hidden-window bounds, so align after showing.
      trace.record('before-set-bounds')
      main.setBounds(bounds)
      trace.record('after-set-bounds')
      if (show && splash.isMaximized()) {
        trace.record('before-maximize')
        main.maximize()
        trace.record('after-maximize')
      }
      if (show) {
        trace.record('before-stack')
        splash.moveAbove(main.getMediaSourceId())
        trace.record('after-stack')
      }
      // Capturing forces a composited frame even when Windows suspends rAF in an occluded window.
      trace.record('before-capture')
      const frame = await main.webContents.capturePage().catch(error => {
        trace.record('capture-failed', error)
        throw error
      })
      trace.record('after-capture', undefined, frame)
      if (frame.isEmpty()) throw new Error('The startup destination did not produce a frame')
      return { splash: bounds, main: main.getBounds() }
    } catch (error) {
      if (!main.isDestroyed()) {
        main.hide()
        trace.record('destination-hidden', error)
      }
      throw error
    } finally {
      if (!main.isDestroyed()) {
        trace.record('before-opacity-restore')
        main.setOpacity(1)
        trace.record('after-opacity-restore')
      }
    }
  } finally {
    trace.dispose()
  }
}
