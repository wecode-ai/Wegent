import type { FormEvent } from 'react'
import { deviceSurfaceExtension } from '@extensions/device-surface'
import {
  navigateEmbeddedBrowser,
  openEmbeddedBrowser,
  readEmbeddedBrowserPageState,
  reloadEmbeddedBrowser,
  setEmbeddedBrowserBounds,
  type EmbeddedBrowserDownloadEvent,
  type EmbeddedBrowserNavigationError,
  type EmbeddedBrowserPageState,
} from '@/lib/embedded-browser'
import { readEmbeddedBrowserDownloadSnapshot } from '@/lib/embedded-browser-download-store'
import { openInExternalBrowser } from '@/lib/external-links'
import { browserDiagnosticOrigin, normalizeBrowserUrl } from '@/lib/browser-url'
import { track } from '@/telemetry/client'
import type { BrowserSessionModel } from './workspaceBrowserSessionTypes'
import {
  logBrowserAnnotation,
  getFallbackBrowserTitle,
  getFallbackFaviconUrl,
  haveSameOrigin,
  getElementBounds,
  waitForVisibleBrowserHost,
  logBrowserOpenDiagnostic,
} from './workspaceBrowserSessionTypes'
export function createBrowserNavigation(model: BrowserSessionModel) {
  const applyNativePageStatus = (pageState: {
    isLoading: boolean
    canGoBack?: boolean
    canGoForward?: boolean
    navigationError?: EmbeddedBrowserNavigationError | null
  }): void => {
    const nextNavigationError = pageState.navigationError ?? null
    model.set('navigationError', nextNavigationError)
    model.set('status', nextNavigationError ? 'error' : pageState.isLoading ? 'loading' : 'ready')
    model.set('canGoBack', Boolean(pageState.canGoBack))
    model.set('canGoForward', Boolean(pageState.canGoForward))
  }
  const applyDownloadEvent = (download: EmbeddedBrowserDownloadEvent): void => {
    model.set('downloads', current => {
      const remaining = current.filter(item => item.id !== download.id)
      if (download.status === 'deleted') return remaining
      return [download, ...remaining].slice(0, 10)
    })
    // Codex-style interaction: the downloads list never opens itself. A
    // transient peek card surfaces completion or failure and dismisses itself.
    if (download.status === 'finished' || download.status === 'failed') {
      model.set('downloadPeek', {
        id: `${download.id}-${Date.now()}`,
        fileName: download.path?.split(/[\\/]/).pop() || download.url,
        path: download.path,
        status: download.status,
      })
    }
  }
  const reconcileDownloadSnapshot = (nativeLabel: string): void => {
    const snapshot = readEmbeddedBrowserDownloadSnapshot(nativeLabel).slice(0, 10)
    model.set('downloads', snapshot)
    model.runtime.activeDownloadIds = new Set(
      snapshot
        .filter(download => download.status === 'started' || download.status === 'progress')
        .map(download => download.id)
    )
    model.options.onDownloadActivityChange?.(model.runtime.activeDownloadIds.size > 0)
  }
  const adoptNativeLabel = (nativeLabel: string, logicalLabel: string): void => {
    if (
      model.runtime.nativeLabel === nativeLabel &&
      model.runtime.adoptedDownloadOwnerLabel === logicalLabel
    ) {
      return
    }
    model.runtime.nativeLabel = nativeLabel
    model.runtime.adoptedDownloadOwnerLabel = logicalLabel
    model.options.onNativeLabelChange?.(nativeLabel)
    model.actions.reconcileDownloadSnapshot(nativeLabel)
  }
  const updatePageUrl = (url: string | null, pageTitle?: string | null): void => {
    const pendingNavigationUrl = model.runtime.pendingNavigationUrl
    if (pendingNavigationUrl && url && url !== pendingNavigationUrl) return
    model.set('pageUrl', url)
    model.options.onUrlChange?.(url)
    if (url) {
      if (!model.runtime.addressEditing && document.activeElement !== model.dom.addressInput) {
        model.set('address', url)
      }
      model.options.onTitleChange?.(pageTitle || getFallbackBrowserTitle(url))
      model.options.onFaviconChange?.(getFallbackFaviconUrl(url))
      return
    }
    model.options.onTitleChange?.(null)
    model.options.onFaviconChange?.(null)
  }
  const refreshPageState = async (): Promise<boolean> => {
    if (!model.observed || !model.embeddedBrowserAvailable || !model.runtime.nativeBrowserOpen)
      return false
    const requestGeneration = model.runtime.pageStateRequestGeneration + 1
    model.runtime.pageStateRequestGeneration = requestGeneration
    try {
      const pageState = await readEmbeddedBrowserPageState(model.options.label)
      if (!model.observed || model.runtime.pageStateRequestGeneration !== requestGeneration) {
        return false
      }
      model.actions.adoptNativeLabel(pageState.nativeLabel, model.options.label)
      model.actions.applyNativePageStatus(pageState)
      model.set('invalidTlsCertificate', pageState.invalidTlsCertificate ?? null)
      const nextUrl = pageState.url || model.state.currentUrl
      if (
        nextUrl &&
        deviceSurfaceExtension.isInternalPageUrl(nextUrl) &&
        model.state.annotationMode
      ) {
        logBrowserAnnotation('exit annotation mode for internal extension page', {
          label: model.options.label,
        })
        model.actions.exitAnnotationMode()
      }
      if (!pageState.isLoading && nextUrl && model.runtime.pendingNavigationUrl === nextUrl) {
        model.runtime.pendingNavigationUrl = null
      }
      model.actions.updatePageUrl(nextUrl, pageState.title)
      return true
    } catch (error) {
      if (!model.observed || model.runtime.pageStateRequestGeneration !== requestGeneration) {
        return false
      }
      console.error('Failed to read embedded browser page state:', error)
      return false
    }
  }
  const runBrowserCommand = async (command: () => Promise<void>): Promise<void> => {
    try {
      await command()
      await model.actions.refreshPageState()
    } catch (error) {
      console.error('Failed to control embedded browser:', error)
      model.set('status', 'error')
      model.set('error', model.options.t('workbench.browser_control_failed'))
    }
  }
  const reloadCurrentUrl = (url: string): void => {
    model.set('navigationError', null)
    if (!model.embeddedBrowserAvailable) {
      model.set('currentUrl', null)
      window.setTimeout(() => model.set('currentUrl', url), 0)
      model.set('status', 'ready')
      return
    }
    if (!model.runtime.nativeBrowserOpen) {
      model.set('status', 'loading')
      model.set('error', null)
      model.set('currentUrl', url)
      model.set('browserOpenAttempt', attempt => attempt + 1)
      return
    }
    model.set('status', 'loading')
    model.set('error', null)
    void model.actions.runBrowserCommand(() => reloadEmbeddedBrowser(model.options.label))
  }
  const openBrowserUrl = (rawUrl: string): void => {
    const nextUrl = normalizeBrowserUrl(rawUrl)
    if (!nextUrl) {
      model.set('status', 'error')
      model.set('error', model.options.t('workbench.browser_invalid_url'))
      return
    }
    model.set('address', nextUrl)
    model.set('error', null)
    model.set('navigationError', null)
    model.set('localFilePreviewToast', null)
    model.set('invalidTlsCertificate', certificate =>
      certificate && haveSameOrigin(certificate.url, nextUrl) ? certificate : null
    )
    model.runtime.pageStateRequestGeneration += 1
    model.runtime.pendingNavigationUrl = nextUrl
    if (nextUrl === model.activePageUrl) {
      model.actions.updatePageUrl(nextUrl)
      model.runtime.pendingNavigationUrl = null
      model.actions.reloadCurrentUrl(nextUrl)
      return
    }
    model.actions.updatePageUrl(nextUrl)
    if (model.embeddedBrowserAvailable && model.runtime.nativeBrowserOpen) {
      model.set('status', 'loading')
      void model.actions
        .runBrowserCommand(() => navigateEmbeddedBrowser(nextUrl, model.options.label))
        .then(async () => {
          model.runtime.pendingNavigationUrl = null
          model.set('currentUrl', nextUrl)
          await model.actions.refreshPageState()
          track('browser_navigation_completed', { runtime: 'embedded' })
        })
      return
    }
    model.set('currentUrl', nextUrl)
    model.set('status', model.embeddedBrowserAvailable ? 'loading' : 'ready')
    if (!model.embeddedBrowserAvailable) model.runtime.pendingNavigationUrl = null
    track('browser_navigation_completed', { runtime: 'fallback' })
  }
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const urlInput = event.currentTarget.elements.namedItem('url') as HTMLInputElement | null
    const submittedAddress = urlInput?.value ?? model.state.address
    model.actions.openBrowserUrl(submittedAddress)
    model.runtime.addressEditing = false
    urlInput?.blur()
  }
  const handleReload = (): void => {
    if (!model.activePageUrl) return
    if (model.state.annotationMode) model.actions.exitAnnotationMode()
    model.actions.reloadCurrentUrl(model.activePageUrl)
  }
  const handleOpenExternal = (): void => {
    if (!model.activePageUrl || model.internalExtensionPage) return
    model.set('error', null)
    console.info('[Wework] External browser open requested', {
      protocol: new URL(model.activePageUrl).protocol,
    })
    void openInExternalBrowser(model.activePageUrl)
      .then(() => console.info('[Wework] External browser open completed'))
      .catch(error => {
        console.error('[Wework] External browser open failed', {
          errorName: error instanceof Error ? error.name : typeof error,
        })
        model.set('error', model.options.t('workbench.browser_open_external_failed'))
      })
  }
  const ensureNativeBrowser = () => {
    if (!model.observed || !model.embeddedBrowserAvailable || !model.state.currentUrl) return
    if (model.runtime.nativeBrowserOpen) {
      model.actions.schedulePostOpenBoundsSync(model.options.active)
      return
    }
    if (model.runtime.nativeBrowserOpening) return
    const requestId = model.runtime.activeOpenRequestId
    const generation = model.runtime.nativeGeneration
    const openingLabel = model.options.label
    const openingUrl = model.state.currentUrl
    const nativeOpeningUrl = requestId ? 'about:blank' : openingUrl
    const isAbandoned = () => !model.observed || model.runtime.nativeGeneration !== generation
    model.runtime.nativeBrowserOpening = true
    model.set('status', 'loading')
    const revealHiddenBrowser = async (visible: boolean) => {
      if (visible || !model.options.active) return
      const visibleBounds = await waitForVisibleBrowserHost(
        () => model.dom.host,
        isAbandoned,
        () => model.options.active,
        detail =>
          logBrowserOpenDiagnostic('host_waiting', {
            ...detail,
            label: openingLabel,
            requestId,
            url: openingUrl,
          })
      )
      if (visibleBounds) {
        await setEmbeddedBrowserBounds(visibleBounds, true, openingLabel)
        logBrowserOpenDiagnostic('host_visible', {
          bounds: visibleBounds,
          label: openingLabel,
          requestId,
          url: openingUrl,
        })
        return
      }
      await setEmbeddedBrowserBounds({ x: 0, y: 0, width: 1, height: 1 }, false, openingLabel, true)
    }
    const adoptOpenedBrowser = async (initialPageState: EmbeddedBrowserPageState) => {
      model.actions.adoptNativeLabel(initialPageState.nativeLabel, openingLabel)
      model.runtime.nativeBrowserOpen = true
      const bridgeNavigationPending = model.runtime.activeOpenRequestId !== null
      const pendingUrl = model.runtime.pendingNavigationUrl
      const queuedUrl =
        !bridgeNavigationPending && pendingUrl && pendingUrl !== openingUrl ? pendingUrl : null
      let pageState = initialPageState
      if (queuedUrl) {
        await navigateEmbeddedBrowser(queuedUrl, openingLabel)
        if (isAbandoned()) return false
        pageState = await readEmbeddedBrowserPageState(openingLabel)
        if (isAbandoned()) return false
      }
      if (model.runtime.activeOpenRequestId === requestId) {
        model.runtime.activeOpenRequestId = null
      }
      const requestedUrl = queuedUrl ?? openingUrl
      if (!bridgeNavigationPending && model.runtime.pendingNavigationUrl === requestedUrl) {
        model.runtime.pendingNavigationUrl = null
      }
      model.set('invalidTlsCertificate', pageState.invalidTlsCertificate ?? null)
      model.actions.updatePageUrl(
        bridgeNavigationPending ? openingUrl : pageState.url || requestedUrl
      )
      model.actions.schedulePostOpenBoundsSync(model.options.active)
      model.actions.applyNativePageStatus(pageState)
      return true
    }
    const recoverBrowserFromPageState = async () => {
      const recoveryDelays = [0, 120, 300, 600]
      for (const delay of recoveryDelays) {
        if (delay > 0) {
          await new Promise<void>(resolve => window.setTimeout(resolve, delay))
        }
        try {
          const pageState = await readEmbeddedBrowserPageState(openingLabel)
          if (isAbandoned()) return true
          await adoptOpenedBrowser(pageState)
          return true
        } catch {
          // No existing browser state to recover yet.
        }
      }
      return false
    }
    const openWhenHostIsReady = async () => {
      console.info('[Wework][browser-open] nativeOpenStart', {
        label: model.options.label,
        currentUrl: browserDiagnosticOrigin(openingUrl),
        active: model.options.active,
      })
      try {
        const host = model.dom.host
        const measuredBounds = model.options.active && host ? getElementBounds(host) : null
        const visible = measuredBounds !== null
        const bounds = measuredBounds ?? { x: 0, y: 0, width: 1, height: 1 }
        if (isAbandoned()) return
        logBrowserOpenDiagnostic('host_ready', {
          active: model.options.active,
          bounds,
          label: openingLabel,
          requestId,
          url: openingUrl,
          visible,
        })
        logBrowserOpenDiagnostic('native_open_started', {
          active: model.options.active,
          label: openingLabel,
          requestId,
          url: openingUrl,
          visible,
        })
        const pageState = visible
          ? requestId
            ? await openEmbeddedBrowser(nativeOpeningUrl, bounds, openingLabel, true, true, false)
            : await openEmbeddedBrowser(nativeOpeningUrl, bounds, openingLabel)
          : requestId
            ? await openEmbeddedBrowser(
                nativeOpeningUrl,
                bounds,
                openingLabel,
                false,
                !model.options.active,
                false
              )
            : await openEmbeddedBrowser(
                nativeOpeningUrl,
                bounds,
                openingLabel,
                false,
                !model.options.active
              )
        if (isAbandoned()) {
          logBrowserOpenDiagnostic('lifecycle_cancelled', {
            active: model.options.active,
            label: openingLabel,
            requestId,
            url: openingUrl,
          })
          return
        }
        if (!(await adoptOpenedBrowser(pageState))) return
        await revealHiddenBrowser(visible)
        logBrowserOpenDiagnostic('native_open_succeeded', {
          active: model.options.active,
          label: openingLabel,
          nativeLabel: pageState.nativeLabel,
          requestId,
          url: pageState.url || openingUrl,
        })
      } catch (error) {
        const errorType = error instanceof Error ? error.name : typeof error
        const abandoned = isAbandoned()
        console.error(
          '[Wework] Embedded browser open failed',
          JSON.stringify({
            active: model.options.active,
            disposed: abandoned,
            error: errorType,
            label: openingLabel,
            requestId,
            url: browserDiagnosticOrigin(openingUrl),
          })
        )
        logBrowserOpenDiagnostic('native_open_failed', {
          active: model.options.active,
          disposed: abandoned,
          error: errorType,
          label: openingLabel,
          requestId,
          url: openingUrl,
        })
        if (!abandoned) {
          if (await recoverBrowserFromPageState()) return
          model.set('status', 'error')
          model.set('error', model.options.t('workbench.browser_open_failed'))
        }
      } finally {
        model.runtime.nativeBrowserOpening = false
        if (
          model.observed &&
          generation !== model.runtime.nativeGeneration &&
          model.state.currentUrl
        )
          model.actions.ensureNativeBrowser()
      }
    }
    void openWhenHostIsReady()
  }
  const adoptExistingBrowser = () => {
    if (
      !model.options.active ||
      !model.embeddedBrowserAvailable ||
      model.runtime.nativeBrowserOpen ||
      model.state.currentUrl
    )
      return
    const generation = ++model.runtime.pageStateRequestGeneration
    const attachExistingBrowser = async () => {
      try {
        const pageState = await readEmbeddedBrowserPageState(model.options.label)
        if (
          !model.observed ||
          generation !== model.runtime.pageStateRequestGeneration ||
          model.state.currentUrl
        )
          return
        model.actions.adoptNativeLabel(pageState.nativeLabel, model.options.label)
        model.set('invalidTlsCertificate', pageState.invalidTlsCertificate ?? null)
        if (!pageState.url) return
        model.runtime.nativeBrowserOpen = true
        model.set('currentUrl', pageState.url)
        model.actions.updatePageUrl(pageState.url, pageState.title)
        model.runtime.pendingNavigationUrl = null
        model.actions.applyNativePageStatus(pageState)
        model.actions.schedulePostOpenBoundsSync(model.options.active)
      } catch {
        // No existing native browser for this label.
      }
    }
    void attachExistingBrowser()
  }
  const consumeOpenRequest = () => {
    if (!model.options.openRequest?.url) return
    if (
      model.options.openRequest.label &&
      model.options.openRequest.label !== model.options.label
    ) {
      console.info('[Wework][browser-open] openRequestLabelMismatch', {
        requestId: model.options.openRequest.id,
        requestLabel: model.options.openRequest.label,
        panelLabel: model.options.label,
      })
      return
    }
    if (model.runtime.handledOpenRequestId === model.options.openRequest.id) return
    model.runtime.handledOpenRequestId = model.options.openRequest.id
    // Only agent (bridge) opens defer the initial navigation to the bridge and
    // therefore create the host with about:blank. User, popup, and restore
    // requests bind the target URL directly during host creation.
    model.runtime.activeOpenRequestId =
      model.options.openRequest.source === 'agent' ? model.options.openRequest.id : null
    logBrowserOpenDiagnostic('request_consumed', {
      active: model.options.active,
      label: model.options.label,
      requestId: model.options.openRequest.id,
      requestLabel: model.options.openRequest.label,
      url: model.options.openRequest.url,
    })
    model.actions.openBrowserUrl(model.options.openRequest.url)
  }
  return {
    applyNativePageStatus,
    applyDownloadEvent,
    reconcileDownloadSnapshot,
    adoptNativeLabel,
    updatePageUrl,
    refreshPageState,
    runBrowserCommand,
    reloadCurrentUrl,
    openBrowserUrl,
    handleSubmit,
    handleReload,
    handleOpenExternal,
    ensureNativeBrowser,
    adoptExistingBrowser,
    consumeOpenRequest,
  }
}
