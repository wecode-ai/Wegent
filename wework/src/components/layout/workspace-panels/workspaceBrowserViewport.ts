import {
  captureEmbeddedBrowserSnapshot,
  isEmbeddedBrowserLabelTransferred,
  setEmbeddedBrowserBounds,
  setEmbeddedBrowserDeviceMetrics,
  setEmbeddedBrowserZoom,
} from '@/lib/embedded-browser'
import { zoomPercentToScaleFactor } from '@/lib/browser-zoom'
import { computeDeviceViewportPlacement } from '@/lib/browser-device-toolbar'
import type { BrowserSessionModel } from './workspaceBrowserSessionTypes'
import {
  EMBEDDED_BROWSER_BOUNDS_DEBOUNCE_MS,
  EMBEDDED_BROWSER_POST_OPEN_SYNC_DELAYS_MS,
  getElementBounds,
} from './workspaceBrowserSessionTypes'
export function createBrowserViewport(model: BrowserSessionModel) {
  const syncEmbeddedBrowserBounds = async (visible = model.options.active): Promise<void> => {
    const generation = model.runtime.browserBoundsSyncGeneration + 1
    model.runtime.browserBoundsSyncGeneration = generation
    const isCurrent = () =>
      model.observed && model.runtime.browserBoundsSyncGeneration === generation
    if (
      !model.observed ||
      !model.embeddedBrowserAvailable ||
      !model.runtime.nativeBrowserOpen ||
      isEmbeddedBrowserLabelTransferred(model.options.label)
    ) {
      return
    }
    const host = model.dom.host
    if (!host) {
      if (!visible && isCurrent()) {
        await setEmbeddedBrowserBounds(
          { x: 0, y: 0, width: 1, height: 1 },
          false,
          model.options.label
        )
      }
      return
    }
    const bounds = getElementBounds(host)
    if (!bounds) {
      if (!visible && isCurrent()) {
        await setEmbeddedBrowserBounds(
          { x: 0, y: 0, width: 1, height: 1 },
          false,
          model.options.label
        )
      }
      return
    }
    const nativeVisible =
      visible &&
      !model.state.navigationError &&
      (model.electronRuntime ||
        !model.embeddedBrowserOccluded ||
        !model.runtime.occlusionSnapshotReady)
    const deviceState = model.state.deviceToolbar
    const placement = deviceState.isEnabled
      ? computeDeviceViewportPlacement(bounds, deviceState, model.state.zoomPercent)
      : null
    const nativeZoomScale = placement ? 1 : zoomPercentToScaleFactor(model.state.zoomPercent)
    if (placement) {
      model.runtime.deviceFitScale = placement.fitScale
      const hostRect = host.getBoundingClientRect()
      const nextVisualRect = {
        x: placement.visualRect.x - hostRect.left,
        y: placement.visualRect.y - hostRect.top,
        width: placement.visualRect.width,
        height: placement.visualRect.height,
        hostWidth: hostRect.width,
        hostHeight: hostRect.height,
      }
      model.set('deviceVisualRect', current =>
        current &&
        current.x === nextVisualRect.x &&
        current.y === nextVisualRect.y &&
        current.width === nextVisualRect.width &&
        current.height === nextVisualRect.height &&
        current.hostWidth === nextVisualRect.hostWidth &&
        current.hostHeight === nextVisualRect.hostHeight
          ? current
          : nextVisualRect
      )
      if (!isCurrent()) return
      await setEmbeddedBrowserBounds(placement.webviewBounds, nativeVisible, model.options.label)
      if (!isCurrent()) return
    } else {
      model.runtime.deviceFitScale = 1
      model.set('deviceVisualRect', current => (current === null ? current : null))
      if (!isCurrent()) return
      await setEmbeddedBrowserDeviceMetrics(null, model.options.label)
      if (!isCurrent()) return
      await setEmbeddedBrowserBounds(bounds, nativeVisible, model.options.label)
      if (!isCurrent()) return
    }
    // Regular pages use Electron zoom. Device mode keeps Electron zoom at 1
    // because setZoomFactor changes the emulated CSS viewport; CDP metrics
    // applies the combined fit and page zoom through its image scale instead.
    await setEmbeddedBrowserZoom(nativeZoomScale, model.options.label).catch(error => {
      console.error('Failed to apply embedded browser zoom:', error)
    })
    if (!isCurrent()) return
    // Electron applies zoom to the CSS viewport. Reassert device metrics
    // after zoom so window.innerWidth/innerHeight remain the selected preset.
    if (placement) {
      await setEmbeddedBrowserDeviceMetrics(
        {
          width: deviceState.width,
          height: deviceState.height,
          scale: placement.scale,
        },
        model.options.label
      )
    }
  }
  const hideEmbeddedBrowser = async (): Promise<void> => {
    if (
      !model.embeddedBrowserAvailable ||
      !model.runtime.nativeBrowserOpen ||
      isEmbeddedBrowserLabelTransferred(model.options.label)
    ) {
      return
    }
    await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, model.options.label)
  }
  const clearScheduledBoundsSync = (): void => {
    if (model.runtime.syncBoundsAnimationFrame !== null) {
      window.cancelAnimationFrame(model.runtime.syncBoundsAnimationFrame)
      model.runtime.syncBoundsAnimationFrame = null
    }
    if (model.runtime.syncBoundsTimer !== null) {
      window.clearTimeout(model.runtime.syncBoundsTimer)
      model.runtime.syncBoundsTimer = null
    }
    model.runtime.postOpenSyncTimer.forEach(timer => window.clearTimeout(timer))
    model.runtime.postOpenSyncTimer = []
  }
  const scheduleEmbeddedBrowserBoundsSync = (visible = model.options.active): void => {
    if (model.runtime.syncBoundsAnimationFrame !== null) {
      window.cancelAnimationFrame(model.runtime.syncBoundsAnimationFrame)
      model.runtime.syncBoundsAnimationFrame = null
    }
    if (model.runtime.syncBoundsTimer !== null) {
      window.clearTimeout(model.runtime.syncBoundsTimer)
      model.runtime.syncBoundsTimer = null
    }
    model.runtime.syncBoundsAnimationFrame = window.requestAnimationFrame(() => {
      model.runtime.syncBoundsAnimationFrame = null
      void model.actions.syncEmbeddedBrowserBounds(visible).catch(error => {
        console.error('Failed to sync embedded browser bounds:', error)
      })
    })
    model.runtime.syncBoundsTimer = window.setTimeout(() => {
      model.runtime.syncBoundsTimer = null
      void model.actions.syncEmbeddedBrowserBounds(visible).catch(error => {
        console.error('Failed to sync embedded browser bounds:', error)
      })
    }, EMBEDDED_BROWSER_BOUNDS_DEBOUNCE_MS)
  }
  const schedulePostOpenBoundsSync = (visible = model.options.active): void => {
    EMBEDDED_BROWSER_POST_OPEN_SYNC_DELAYS_MS.forEach(delay => {
      const timer = window.setTimeout(() => {
        model.runtime.postOpenSyncTimer = model.runtime.postOpenSyncTimer.filter(
          pendingTimer => pendingTimer !== timer
        )
        model.actions.scheduleEmbeddedBrowserBoundsSync(visible)
      }, delay)
      model.runtime.postOpenSyncTimer.push(timer)
    })
  }
  const syncOcclusionState = async (generation: number): Promise<void> => {
    if (!model.observed) return
    if (model.electronRuntime) {
      await model.actions.syncEmbeddedBrowserBounds(model.options.active)
      return
    }
    if (!model.options.active || !model.embeddedBrowserOccluded) {
      await model.actions.syncEmbeddedBrowserBounds(model.options.active)
      return
    }
    if (model.runtime.occlusionSnapshotInFlight || !model.runtime.nativeBrowserOpen) return
    model.runtime.occlusionSnapshotInFlight = true
    try {
      const fallbackTimeoutId = window.setTimeout(() => {
        if (
          model.observed &&
          model.options.active &&
          model.embeddedBrowserOccluded &&
          generation === model.state.browserOcclusion.generation
        ) {
          // A stuck native capture must not prevent the menu from becoming usable.
          model.runtime.occlusionSnapshotReady = true
          void model.actions.syncEmbeddedBrowserBounds(model.options.active)
        }
      }, 2000)
      model.runtime.occlusionSnapshotFallbackTimer = fallbackTimeoutId
      const snapshotUrl = await captureEmbeddedBrowserSnapshot(model.options.label)
      if (
        model.observed &&
        model.options.active &&
        model.embeddedBrowserOccluded &&
        generation === model.state.browserOcclusion.generation
      ) {
        model.set('occlusionSnapshot', { generation, url: snapshotUrl })
      }
    } catch (error) {
      console.error('Failed to capture embedded browser occlusion snapshot:', error)
      if (
        model.observed &&
        model.embeddedBrowserOccluded &&
        generation === model.state.browserOcclusion.generation
      ) {
        // Keep menus usable if snapshot capture fails, even though the native
        // browser cannot be visually preserved for this interaction.
        model.runtime.occlusionSnapshotReady = true
        await model.actions.syncEmbeddedBrowserBounds(model.options.active)
      }
    } finally {
      if (model.runtime.occlusionSnapshotFallbackTimer !== null) {
        window.clearTimeout(model.runtime.occlusionSnapshotFallbackTimer)
        model.runtime.occlusionSnapshotFallbackTimer = null
      }
      model.runtime.occlusionSnapshotInFlight = false
      if (
        model.observed &&
        model.embeddedBrowserOccluded &&
        generation !== model.state.browserOcclusion.generation
      ) {
        model.set('occlusionCaptureRetry', current => current + 1)
      }
    }
  }
  const handleOcclusionSnapshotLoad = (generation: number): void => {
    if (!model.embeddedBrowserOccluded || generation !== model.state.browserOcclusion.generation) {
      return
    }
    model.runtime.occlusionSnapshotReady = true
    void model.actions.syncEmbeddedBrowserBounds(model.options.active).catch(error => {
      console.error('Failed to hide embedded browser behind occlusion snapshot:', error)
    })
  }
  return {
    syncEmbeddedBrowserBounds,
    hideEmbeddedBrowser,
    clearScheduledBoundsSync,
    scheduleEmbeddedBrowserBoundsSync,
    schedulePostOpenBoundsSync,
    syncOcclusionState,
    handleOcclusionSnapshotLoad,
  }
}
