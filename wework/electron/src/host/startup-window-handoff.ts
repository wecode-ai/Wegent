import type { BrowserWindow, NativeImage, Rectangle } from 'electron'
import { centeredWindowBounds } from './window-layout.js'

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

export interface StartupWindowDisplays {
  main: number
  splash: number
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
    | 'before-relocation'
    | 'after-relocation'
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

function maximizedAtBounds(main: MainWindow, bounds?: Rectangle): boolean {
  // The OS owns the initial maximized frame; display workArea is not a window rectangle.
  // Exact bounds are required only when matching another already maximized window.
  if (!bounds) return main.isMaximized()
  const actual = main.getBounds()
  return (
    main.isMaximized() &&
    actual.x === bounds.x &&
    actual.y === bounds.y &&
    actual.width === bounds.width &&
    actual.height === bounds.height
  )
}

export async function maximizeStartupWindow(main: MainWindow, bounds?: Rectangle): Promise<void> {
  if (main.isDestroyed()) throw new Error('The startup destination closed before maximizing')
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      clearInterval(poll)
      main.removeListener('maximize', changed)
      main.removeListener('resize', changed)
      main.removeListener('move', changed)
      main.removeListener('closed', closed)
    }
    const changed = () => {
      try {
        if (main.isDestroyed()) {
          closed()
          return true
        }
        if (!maximizedAtBounds(main, bounds)) return false
        cleanup()
        resolve()
      } catch (error) {
        cleanup()
        reject(error)
      }
      return true
    }
    const closed = () => {
      cleanup()
      reject(new Error('The startup destination closed before maximizing'))
    }
    // Native bounds/state can settle without another Electron window event.
    const poll = setInterval(changed, 16)
    const timeout = setTimeout(() => {
      if (changed()) return
      cleanup()
      reject(
        new Error(
          `The startup destination did not maximize${bounds ? ' to the splash bounds' : ''} within 5000ms; ` +
            `maximized=${main.isMaximized()}, actual=${JSON.stringify(main.getBounds())}, ` +
            `expected=${JSON.stringify(bounds ?? null)}`
        )
      )
    }, 5000)
    main.on('maximize', changed)
    main.on('resize', changed)
    main.on('move', changed)
    main.on('closed', closed)
    try {
      if (main.isDestroyed()) closed()
      else {
        main.maximize()
        changed()
      }
    } catch (error) {
      cleanup()
      reject(error)
    }
  })
}

/** Presents a painted main window beneath the still-opaque splash without stealing focus. */
export async function prepareStartupMainWindow(
  main: MainWindow,
  splash: SplashWindow,
  show: boolean,
  displays: StartupWindowDisplays,
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
      if (show && splash.isMaximized()) {
        if (displays.main !== displays.splash) {
          trace.record('before-relocation')
          main.setBounds(centeredWindowBounds(splash.getNormalBounds(), bounds))
          trace.record('after-relocation')
        }
        trace.record('before-maximize')
        await maximizeStartupWindow(main, bounds)
        trace.record('after-maximize')
      } else {
        trace.record('before-set-bounds')
        main.setBounds(bounds)
        trace.record('after-set-bounds')
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
