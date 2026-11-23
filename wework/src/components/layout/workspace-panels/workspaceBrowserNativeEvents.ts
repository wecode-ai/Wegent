import {
  listenEmbeddedBrowserAnnotationState,
  listenEmbeddedBrowserAgentState,
  listenEmbeddedBrowserAnnotationRequests,
  listenEmbeddedBrowserCloseRequests,
  listenEmbeddedBrowserInvalidTlsCertificates,
  listenEmbeddedBrowserLocalFilePreview,
  listenEmbeddedBrowserPageStateChanges,
  listenEmbeddedBrowserAgentCursor,
  type EmbeddedBrowserPageState,
} from '@/lib/embedded-browser'
import { subscribeEmbeddedBrowserDownloadEvents } from '@/lib/embedded-browser-download-store'
import { track } from '@/telemetry/client'
import { resetElectronEmbeddedBrowserView } from './electronEmbeddedBrowserHost'
import type { BrowserSessionModel } from './workspaceBrowserSessionTypes'
export function observeBrowserNativeEvents(model: BrowserSessionModel) {
  let listening = true
  let pageStateFrame: number | null = null
  let pendingPageState: { state: EmbeddedBrowserPageState; generation: number } | null = null
  const clearPendingPageState = () => {
    if (pageStateFrame !== null) window.cancelAnimationFrame(pageStateFrame)
    pageStateFrame = null
    pendingPageState = null
  }
  const stops: (() => void)[] = []
  const retain = (pending: Promise<() => void> | null | undefined) => {
    if (!pending) return
    void pending
      .then(stop => {
        if (listening) stops.push(stop)
        else stop()
      })
      .catch(error => console.error('Failed to subscribe to embedded browser events:', error))
  }
  stops.push(
    subscribeEmbeddedBrowserDownloadEvents(download => {
      if (!model.observed) return
      if (download.nativeLabel !== model.runtime.nativeLabel) return
      if (download.status === 'started' || download.status === 'progress') {
        model.runtime.activeDownloadIds.add(download.id)
      } else {
        model.runtime.activeDownloadIds.delete(download.id)
      }
      model.options.onDownloadActivityChange?.(model.runtime.activeDownloadIds.size > 0)
      if (model.options.active) {
        model.actions.applyDownloadEvent(download)
      }
      if (
        (download.status === 'finished' ||
          download.status === 'failed' ||
          download.status === 'deleted') &&
        !model.runtime.trackedTerminalDownloadIds.has(download.id)
      ) {
        model.runtime.trackedTerminalDownloadIds.add(download.id)
        track('browser_download_completed', {
          result:
            download.status === 'finished'
              ? 'success'
              : download.status === 'failed'
                ? 'failure'
                : 'cancelled',
        })
      }
    })
  )
  retain(
    listenEmbeddedBrowserAgentState(event => {
      if (!model.observed) return
      if (event.label !== model.options.label) return
      model.set('agentState', event)
    })
  )
  retain(
    listenEmbeddedBrowserAgentCursor(event => {
      if (!model.observed) return
      if (event.label !== model.options.label) return
      model.set('agentCursor', event)
    })
  )
  retain(
    listenEmbeddedBrowserInvalidTlsCertificates(certificate => {
      if (!model.observed) return
      if (!model.options.active || certificate.nativeLabel !== model.runtime.nativeLabel) return
      model.set('invalidTlsCertificate', certificate)
    })
  )
  retain(
    listenEmbeddedBrowserLocalFilePreview(event => {
      if (!model.observed) return
      if (!model.options.active || event.nativeLabel !== model.runtime.nativeLabel) return
      model.set('localFilePreviewToast', {
        id: Date.now(),
        message: model.options.t('workbench.browser_local_file_notice'),
      })
    })
  )
  retain(
    listenEmbeddedBrowserCloseRequests(event => {
      if (!model.observed) return
      if (event.label !== model.options.label || event.nativeLabel !== model.runtime.nativeLabel) {
        return
      }
      clearPendingPageState()
      console.info(
        '[Wework] Embedded browser close consumed',
        JSON.stringify({ label: event.label, nativeLabel: event.nativeLabel })
      )
      resetElectronEmbeddedBrowserView(event.label)
      model.runtime.nativeGeneration += 1
      model.runtime.nativeBrowserOpen = false
      model.runtime.nativeLabel = null
      model.runtime.adoptedDownloadOwnerLabel = null
      model.runtime.activeDownloadIds = new Set()
      model.options.onNativeLabelChange?.(null)
      model.options.onDownloadActivityChange?.(false)
      model.runtime.pendingNavigationUrl = null
      model.runtime.pageStateRequestGeneration += 1
      model.set('currentUrl', null)
      model.set('pageUrl', null)
      model.set('address', '')
      model.options.onUrlChange?.(null)
      model.set('status', 'ready')
      model.set('error', null)
      model.set('invalidTlsCertificate', null)
      model.set('annotationMode', false)
      model.set('originalViewHeld', false)
      model.set('annotations', [])
      model.set('downloads', [])
      model.set('downloadsOpen', false)
      model.set('localFilePreviewToast', null)
      model.set('clearDataNotice', null)
      model.set('clearingDataKind', null)
      model.set('agentState', null)
      model.set('agentCursor', null)
      model.options.onTitleChange?.(null)
      model.options.onFaviconChange?.(null)
    })
  )
  const ownsPageState = (pageState: EmbeddedBrowserPageState) =>
    model.observed &&
    (!pageState.label || pageState.label === model.options.label) &&
    (!model.runtime.nativeLabel || pageState.nativeLabel === model.runtime.nativeLabel)
  function applyPageState(pageState: EmbeddedBrowserPageState): void {
    if (!ownsPageState(pageState)) return
    model.actions.applyNativePageStatus(pageState)
    if (pageState.isLoading) return
    model.set('invalidTlsCertificate', pageState.invalidTlsCertificate ?? null)
    const nextUrl = pageState.url || model.state.currentUrl
    if (nextUrl && model.runtime.pendingNavigationUrl === nextUrl) {
      model.runtime.pendingNavigationUrl = null
    }
    model.actions.updatePageUrl(nextUrl, pageState.title)
  }
  retain(
    listenEmbeddedBrowserPageStateChanges(pageState => {
      if (!ownsPageState(pageState)) return
      pendingPageState = { state: pageState, generation: model.runtime.pageStateRequestGeneration }
      if (pageStateFrame !== null) return
      pageStateFrame = window.requestAnimationFrame(() => {
        const latest = pendingPageState
        clearPendingPageState()
        if (latest?.generation === model.runtime.pageStateRequestGeneration) {
          applyPageState(latest.state)
        }
      })
    })
  )
  retain(listenEmbeddedBrowserAnnotationState(model.actions.applyAnnotationState))
  retain(
    listenEmbeddedBrowserAnnotationRequests(request => {
      if (!model.observed) return
      if (
        !model.options.active ||
        request.label !== model.options.label ||
        request.nativeLabel !== model.runtime.nativeLabel
      ) {
        return
      }
      void model.actions.enterAnnotationMode({
        mode: request.mode,
        point: { x: request.x, y: request.y },
      })
    })
  )
  return () => {
    listening = false
    clearPendingPageState()
    stops.splice(0).forEach(stop => stop())
  }
}
