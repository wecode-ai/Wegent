import { useMemo, useState, useSyncExternalStore } from 'react'
import { useDOMEvent, useElementGeometry } from '@wegent/collaboration/dom-events'
import {
  createWorkspaceBrowserSession,
  EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT,
  EMBEDDED_BROWSER_OCCLUSION_EVENT,
} from './workspaceBrowserSession'
import { createBrowserSessionDom } from './workspaceBrowserPanelDom'
import type { BrowserSessionOptions } from './workspaceBrowserSessionTypes'
export function useWorkspaceBrowserPanelSession({
  active,
  hideToolbar,
  label,
  transferFromLabel,
  transferredNativeLabel,
  transferredUrl,
  browserTabId,
  openRequest,
  codeCommentCount,
  codeCommentContexts,
  browserAnnotationCommand,
  onAddCodeComment,
  onReplaceBrowserCodeComments,
  onRemoveBrowserCodeComments,
  onNativeLabelChange,
  onDownloadActivityChange,
  onFaviconChange,
  onLoadingChange,
  onTitleChange,
  onAgentActiveChange,
  onUrlChange,
  t,
}: Omit<BrowserSessionOptions, 'geometry'>) {
  const [
    {
      browserPanelRef,
      geometryTargets,
      bindPanel,
      bindHost,
      bindAddressInput,
      readHost,
      readAddressInput,
    },
  ] = useState(createBrowserSessionDom)
  const geometry = useElementGeometry(geometryTargets)
  const options = useMemo(
    () => ({
      active,
      hideToolbar,
      label,
      transferFromLabel,
      transferredNativeLabel,
      transferredUrl,
      browserTabId,
      openRequest,
      codeCommentCount,
      codeCommentContexts,
      browserAnnotationCommand,
      onAddCodeComment,
      onReplaceBrowserCodeComments,
      onRemoveBrowserCodeComments,
      onNativeLabelChange,
      onDownloadActivityChange,
      onFaviconChange,
      onLoadingChange,
      onTitleChange,
      onAgentActiveChange,
      onUrlChange,
      t,
      geometry,
    }),
    [
      active,
      hideToolbar,
      label,
      transferFromLabel,
      transferredNativeLabel,
      transferredUrl,
      browserTabId,
      openRequest,
      codeCommentCount,
      codeCommentContexts,
      browserAnnotationCommand,
      onAddCodeComment,
      onReplaceBrowserCodeComments,
      onRemoveBrowserCodeComments,
      onNativeLabelChange,
      onDownloadActivityChange,
      onFaviconChange,
      onLoadingChange,
      onTitleChange,
      onAgentActiveChange,
      onUrlChange,
      t,
      geometry,
    ]
  )
  const [source] = useState(() =>
    createWorkspaceBrowserSession(options, {
      get host() {
        return readHost()
      },
      get addressInput() {
        return readAddressInput()
      },
    })
  )
  const observation = useMemo(() => source.observe(options), [source, options])
  useDOMEvent('window', 'resize', source.boundsChanged)
  useDOMEvent(window.visualViewport, 'resize', source.boundsChanged)
  useDOMEvent('window', 'scroll', source.recheckOverlay, { capture: true })
  useDOMEvent('window', 'pagehide', source.pageHide)
  useDOMEvent('window', 'pageshow', source.pageShow)
  useDOMEvent('window', 'blur', source.resetOriginalView)
  useDOMEvent('document', 'visibilitychange', source.documentVisibilityChanged)
  useDOMEvent('window', EMBEDDED_BROWSER_DEBUG_PANEL_VISIBILITY_EVENT, source.debugPanelVisibility)
  useDOMEvent('window', EMBEDDED_BROWSER_OCCLUSION_EVENT, source.browserOcclusionChanged)
  useDOMEvent('document', 'pointerover', source.recheckOverlay, { capture: true })
  useDOMEvent('document', 'pointerout', source.recheckOverlay, { capture: true })
  useDOMEvent('document', 'focusin', source.recheckOverlay, { capture: true })
  useDOMEvent('document', 'focusout', source.recheckOverlay, { capture: true })
  const state = useSyncExternalStore(observation.subscribe, source.getSnapshot, source.getSnapshot)

  return { state, source, browserPanelRef, bindPanel, bindHost, bindAddressInput }
}
