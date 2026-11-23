import { deviceSurfaceExtension } from '@extensions/device-surface'
import { pollWorkbenchPresentation } from '@/desktop/workbenchWindowActivity'
import {
  canUseEmbeddedBrowser,
  consumeEmbeddedBrowserLabelTransfer,
  setEmbeddedBrowserAnnotationOriginalView,
  EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
  EMBEDDED_BROWSER_OCCLUSION_EVENT,
  type EmbeddedBrowserOcclusionChange,
} from '@/lib/embedded-browser'
import { isElectronRuntime } from '@/lib/runtime-environment'
import {
  embeddedBrowserOverlayMutationAffectsVisibility,
  hasEmbeddedBrowserOverlayConflict,
} from '@/lib/embedded-browser-overlay'
import { BROWSER_ZOOM_DEFAULT_PERCENT } from '@/lib/browser-zoom'
import { createBrowserNavigation } from './workspaceBrowserNavigation'
import { createBrowserViewport } from './workspaceBrowserViewport'
import { createBrowserAnnotations } from './workspaceBrowserAnnotations'
import { createBrowserActions } from './workspaceBrowserActions'
import { observeBrowserNativeEvents } from './workspaceBrowserNativeEvents'
import {
  browserOcclusionReducer,
  createBrowserSessionInitial,
  DOWNLOAD_PEEK_DURATION_MS,
  EMBEDDED_BROWSER_STATE_INTERVAL_MS,
  type BrowserSessionActions,
  type BrowserSessionDom,
  type BrowserSessionModel,
  type BrowserSessionOptions,
  type BrowserSessionState,
} from './workspaceBrowserSessionTypes'

/** One logical browser tab owns native event state; React visibility never closes its session. */
export function createWorkspaceBrowserSession(
  initial: BrowserSessionOptions,
  dom: BrowserSessionDom
) {
  const initialState = createBrowserSessionInitial(initial)
  let state = initialState.state
  let options = initial
  let actions: BrowserSessionActions | null = null
  const listeners = new Set<() => void>()
  let stopEvents: (() => void) | null = null
  let overlayObserver: MutationObserver | null = null
  let overlayFrame: number | null = null
  let stopPagePolling: (() => void) | undefined
  let peekTimer: number | null = null
  let findTimer: number | null = null
  let observationGeneration = 0
  let scheduled = false
  let previousState: BrowserSessionState | null = null
  let previousOptions: BrowserSessionOptions | null = null
  const callbacks = {
    onAddCodeComment: (
      ...args: Parameters<NonNullable<BrowserSessionOptions['onAddCodeComment']>>
    ) => {
      if (model.observed) options.onAddCodeComment?.(...args)
    },
    onReplaceBrowserCodeComments: (
      ...args: Parameters<NonNullable<BrowserSessionOptions['onReplaceBrowserCodeComments']>>
    ) => {
      if (model.observed) options.onReplaceBrowserCodeComments?.(...args)
    },
    onRemoveBrowserCodeComments: (
      ...args: Parameters<NonNullable<BrowserSessionOptions['onRemoveBrowserCodeComments']>>
    ) => {
      if (model.observed) options.onRemoveBrowserCodeComments?.(...args)
    },
    onNativeLabelChange: (
      ...args: Parameters<NonNullable<BrowserSessionOptions['onNativeLabelChange']>>
    ) => {
      if (model.observed) options.onNativeLabelChange?.(...args)
    },
    onDownloadActivityChange: (
      ...args: Parameters<NonNullable<BrowserSessionOptions['onDownloadActivityChange']>>
    ) => {
      if (model.observed) options.onDownloadActivityChange?.(...args)
    },
    onFaviconChange: (
      ...args: Parameters<NonNullable<BrowserSessionOptions['onFaviconChange']>>
    ) => {
      if (model.observed) options.onFaviconChange?.(...args)
    },
    onLoadingChange: (
      ...args: Parameters<NonNullable<BrowserSessionOptions['onLoadingChange']>>
    ) => {
      if (model.observed) options.onLoadingChange?.(...args)
    },
    onTitleChange: (...args: Parameters<NonNullable<BrowserSessionOptions['onTitleChange']>>) => {
      if (model.observed) options.onTitleChange?.(...args)
    },
    onAgentActiveChange: (
      ...args: Parameters<NonNullable<BrowserSessionOptions['onAgentActiveChange']>>
    ) => {
      if (model.observed) options.onAgentActiveChange?.(...args)
    },
    onUrlChange: (...args: Parameters<NonNullable<BrowserSessionOptions['onUrlChange']>>) => {
      if (model.observed) options.onUrlChange?.(...args)
    },
  }
  let guardedOptions: BrowserSessionOptions = { ...initial, ...callbacks }
  const model: BrowserSessionModel = {
    get state() {
      return state
    },
    get options() {
      return guardedOptions
    },
    runtime: initialState.runtime,
    dom,
    get observed() {
      return listeners.size > 0
    },
    get actions() {
      if (!actions) throw new Error('Browser session commands are not initialized')
      return actions
    },
    electronRuntime: isElectronRuntime(),
    embeddedBrowserAvailable: canUseEmbeddedBrowser(),
    get activePageUrl() {
      return state.pageUrl ?? state.currentUrl
    },
    get internalExtensionPage() {
      return Boolean(
        model.activePageUrl && deviceSurfaceExtension.isInternalPageUrl(model.activePageUrl)
      )
    },
    get embeddedBrowserOccluded() {
      return (
        state.browserOcclusion.overlayIds.size > 0 ||
        (options.active &&
          Boolean(state.currentUrl) &&
          state.browserOcclusion.documentOverlayOccluded)
      )
    },
    get pendingCommentContextCount() {
      return Math.max(options.codeCommentCount, options.codeCommentContexts.length)
    },
    get hasQueuedTweaks() {
      return state.annotations.some(annotation => annotation.designChanges.length > 0)
    },
    get originalViewEnabled() {
      return state.annotationMode && model.hasQueuedTweaks && state.originalViewHeld
    },
    get canUsePageFind() {
      return Boolean(model.activePageUrl) && !model.internalExtensionPage
    },
    set(key, update) {
      if (!model.observed) return
      const value = typeof update === 'function' ? update(state[key]) : update
      if (Object.is(state[key], value)) return
      state = { ...state, [key]: value }
      for (const listener of listeners) listener()
      scheduleReconciliation()
    },
    dispatchOcclusion(action) {
      model.set('browserOcclusion', current => browserOcclusionReducer(current, action))
    },
  }
  actions = {
    ...createBrowserNavigation(model),
    ...createBrowserViewport(model),
    ...createBrowserAnnotations(model),
    ...createBrowserActions(model),
  }

  function scheduleReconciliation() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      if (model.observed) reconcileSession()
    })
  }

  function recheckOverlay() {
    if (overlayFrame !== null || !model.observed) return
    overlayFrame = window.requestAnimationFrame(() => {
      overlayFrame = null
      if (
        !model.observed ||
        !options.active ||
        !model.embeddedBrowserAvailable ||
        !state.currentUrl
      )
        return
      const host = dom.host
      model.dispatchOcclusion({
        type: 'document',
        occluded: Boolean(host && hasEmbeddedBrowserOverlayConflict(host)),
      })
    })
  }

  function reconcileSession() {
    const before = previousState
    const configuration = previousOptions
    previousState = state
    previousOptions = options
    const activeChanged = configuration?.active !== options.active
    const navigationChanged =
      !before ||
      before.currentUrl !== state.currentUrl ||
      before.browserOpenAttempt !== state.browserOpenAttempt
    const geometryChanged = configuration?.geometry !== options.geometry
    if (
      before?.status !== state.status ||
      configuration?.onLoadingChange !== options.onLoadingChange
    )
      callbacks.onLoadingChange(state.status === 'loading')
    if (
      configuration?.onAgentActiveChange !== options.onAgentActiveChange &&
      configuration?.onAgentActiveChange
    )
      configuration.onAgentActiveChange(false)
    if (
      !before ||
      before.agentState?.status !== state.agentState?.status ||
      before.agentCursor?.visible !== state.agentCursor?.visible ||
      configuration?.onAgentActiveChange !== options.onAgentActiveChange
    ) {
      callbacks.onAgentActiveChange(
        state.agentState?.status === 'running' || Boolean(state.agentCursor?.visible)
      )
    }
    if (activeChanged) {
      model.runtime.pageStateRequestGeneration += 1
      if (options.active && model.runtime.nativeLabel)
        model.actions.reconcileDownloadSnapshot(model.runtime.nativeLabel)
      if (!options.active) {
        model.set('originalViewHeld', false)
        model.set('occlusionSnapshot', null)
      }
    }
    model.actions.consumeOpenRequest()
    model.actions.consumeAnnotationCommand()
    if (navigationChanged || activeChanged) {
      model.actions.ensureNativeBrowser()
      model.actions.adoptExistingBrowser()
    }
    if (!options.active && activeChanged)
      void model.actions
        .hideEmbeddedBrowser()
        .catch(error => console.error('Failed to hide embedded browser:', error))
    if (
      geometryChanged ||
      activeChanged ||
      navigationChanged ||
      before?.navigationError !== state.navigationError
    ) {
      model.actions.scheduleEmbeddedBrowserBoundsSync(options.active)
      recheckOverlay()
    }
    if (
      before?.status !== state.status &&
      state.status === 'ready' &&
      (state.zoomPercent !== BROWSER_ZOOM_DEFAULT_PERCENT || model.runtime.deviceFitScale !== 1)
    )
      model.actions.scheduleEmbeddedBrowserBoundsSync(options.active)
    if (!model.hasQueuedTweaks && state.originalViewHeld) model.set('originalViewHeld', false)
    const previousOriginal =
      before &&
      before.annotationMode &&
      before.originalViewHeld &&
      before.annotations.some(annotation => annotation.designChanges.length > 0)
    if (
      state.annotationMode &&
      (before?.annotationMode !== state.annotationMode ||
        Boolean(previousOriginal) !== model.originalViewEnabled)
    ) {
      void setEmbeddedBrowserAnnotationOriginalView(model.originalViewEnabled, options.label).catch(
        error => console.error('Failed to update embedded browser original view state:', error)
      )
    }
    const beforeOccluded =
      before &&
      (before.browserOcclusion.overlayIds.size > 0 ||
        (configuration?.active &&
          Boolean(before.currentUrl) &&
          before.browserOcclusion.documentOverlayOccluded))
    if (!model.embeddedBrowserOccluded && state.occlusionSnapshot)
      model.set('occlusionSnapshot', null)
    if (
      !before ||
      before.browserOcclusion.generation !== state.browserOcclusion.generation ||
      Boolean(beforeOccluded) !== model.embeddedBrowserOccluded ||
      before.occlusionCaptureRetry !== state.occlusionCaptureRetry ||
      activeChanged
    ) {
      model.runtime.occlusionSnapshotReady = model.electronRuntime || !model.embeddedBrowserOccluded
      void model.actions
        .syncOcclusionState(state.browserOcclusion.generation)
        .catch(error =>
          console.error('Failed to sync embedded browser occlusion visibility:', error)
        )
    }
    if (before?.downloadPeek !== state.downloadPeek) {
      if (peekTimer !== null) window.clearTimeout(peekTimer)
      peekTimer = state.downloadPeek
        ? window.setTimeout(() => model.set('downloadPeek', null), DOWNLOAD_PEEK_DURATION_MS)
        : null
    }
    if (!state.findOpen) model.runtime.findPageUrl = model.activePageUrl
    const pageSearchChanged =
      state.status === 'ready' && model.runtime.findPageUrl !== model.activePageUrl
    if (pageSearchChanged) model.runtime.findPageUrl = model.activePageUrl
    if (
      !before ||
      before.findOpen !== state.findOpen ||
      before.findQuery !== state.findQuery ||
      pageSearchChanged
    ) {
      if (findTimer !== null) window.clearTimeout(findTimer)
      findTimer = state.findOpen
        ? window.setTimeout(() => model.actions.runFindSearch(state.findQuery), 150)
        : null
    }
    const polling =
      options.active && model.embeddedBrowserAvailable && model.runtime.nativeBrowserOpen
    if (!polling) {
      stopPagePolling?.()
      stopPagePolling = undefined
    } else if (!stopPagePolling) {
      stopPagePolling = pollWorkbenchPresentation(
        () => void model.actions.refreshPageState(),
        EMBEDDED_BROWSER_STATE_INTERVAL_MS,
        5_000
      )
    }
  }

  function stopObservation() {
    stopEvents?.()
    stopEvents = null
    overlayObserver?.disconnect()
    overlayObserver = null
    if (overlayFrame !== null) window.cancelAnimationFrame(overlayFrame)
    overlayFrame = null
    stopPagePolling?.()
    stopPagePolling = undefined
    if (peekTimer !== null) window.clearTimeout(peekTimer)
    if (findTimer !== null) window.clearTimeout(findTimer)
    peekTimer = findTimer = null
    model.actions.clearScheduledBoundsSync()
    model.runtime.pageStateRequestGeneration += 1
    model.runtime.findRequestSequence += 1
    model.runtime.browserBoundsSyncGeneration += 1
    if (model.runtime.occlusionSnapshotFallbackTimer !== null)
      window.clearTimeout(model.runtime.occlusionSnapshotFallbackTimer)
    model.runtime.occlusionSnapshotFallbackTimer = null
    options.onAgentActiveChange?.(false)
    // Explicit close-tab commands own native close. Offscreen only releases these observers.
    consumeEmbeddedBrowserLabelTransfer(options.label)
    previousState = previousOptions = null
  }

  return {
    actions: model.actions,
    setAddressEditing: (editing: boolean) => {
      model.runtime.addressEditing = editing
    },
    getPageUrl: () => model.activePageUrl,
    set: model.set,
    getSnapshot: () => state,
    recheckOverlay,
    boundsChanged: () => {
      if (model.observed) model.actions.scheduleEmbeddedBrowserBoundsSync(options.active)
      recheckOverlay()
    },
    pageHide: () => {
      if (!model.observed) return
      model.set('originalViewHeld', false)
      void model.actions
        .hideEmbeddedBrowser()
        .catch(error => console.error('Failed to hide embedded browser before page unload:', error))
    },
    pageShow: () => {
      if (options.active) model.actions.scheduleEmbeddedBrowserBoundsSync(true)
    },
    resetOriginalView: () => model.set('originalViewHeld', false),
    documentVisibilityChanged: () => {
      if (document.visibilityState === 'hidden') model.set('originalViewHeld', false)
    },
    debugPanelVisibility: (event: Event) => {
      const expanded = Boolean((event as CustomEvent<{ expanded?: boolean }>).detail?.expanded)
      if (!options.active && expanded) return
      model.dispatchOcclusion({ id: 'debug-panel', occluded: expanded, type: 'overlay' })
    },
    browserOcclusionChanged: (event: Event) => {
      const detail = (event as CustomEvent<EmbeddedBrowserOcclusionChange>).detail
      if (!detail?.id || (!options.active && detail.occluded)) return
      model.dispatchOcclusion({ id: detail.id, occluded: detail.occluded, type: 'overlay' })
    },
    observe(next: BrowserSessionOptions) {
      return {
        subscribe(listener: () => void) {
          options = next
          guardedOptions = {
            ...options,
            ...callbacks,
            onAddCodeComment: options.onAddCodeComment ? callbacks.onAddCodeComment : undefined,
            onReplaceBrowserCodeComments: options.onReplaceBrowserCodeComments
              ? callbacks.onReplaceBrowserCodeComments
              : undefined,
          }
          const generation = ++observationGeneration
          const first = stopEvents === null
          listeners.add(listener)
          if (first) {
            stopEvents = observeBrowserNativeEvents(model)
            overlayObserver =
              typeof MutationObserver === 'undefined'
                ? null
                : new MutationObserver(mutations => {
                    if (embeddedBrowserOverlayMutationAffectsVisibility(mutations)) recheckOverlay()
                  })
            overlayObserver?.observe(document.body, {
              attributes: true,
              attributeFilter: [
                'aria-hidden',
                'aria-modal',
                'class',
                'data-embedded-browser-occlusion',
                'hidden',
                'role',
                'style',
              ],
              childList: true,
              subtree: true,
            })
          }
          scheduleReconciliation()
          return () => {
            listeners.delete(listener)
            if (!listeners.size)
              queueMicrotask(() => {
                if (observationGeneration === generation && !listeners.size) stopObservation()
              })
          }
        },
      }
    },
  }
}
export { EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT, EMBEDDED_BROWSER_OCCLUSION_EVENT }
