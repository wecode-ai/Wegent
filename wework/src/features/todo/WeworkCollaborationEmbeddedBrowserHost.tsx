import { X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import {
  closeEmbeddedBrowser,
  DEFAULT_EMBEDDED_BROWSER_LABEL,
  listenEmbeddedBrowserCloseRequests,
  listenEmbeddedBrowserOpenRequests,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { WorkspaceBrowserPanel } from '@/components/layout/workspace-panels/WorkspaceBrowserPanelContainer'

export function WeworkCollaborationEmbeddedBrowserHost() {
  const { t } = useTranslation('common')
  const [openRequest, setOpenRequest] = useState<EmbeddedBrowserOpenRequest | null>(null)
  const hasOpenedRef = useRef(false)
  const nativeLabelRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isElectronRuntime()) return
    const listener = listenEmbeddedBrowserOpenRequests(request => {
      hasOpenedRef.current = true
      setOpenRequest({
        ...request,
        label: DEFAULT_EMBEDDED_BROWSER_LABEL,
        baseLabel: DEFAULT_EMBEDDED_BROWSER_LABEL,
        targetLabel: DEFAULT_EMBEDDED_BROWSER_LABEL,
      })
    })
    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [])

  useEffect(() => {
    if (!isElectronRuntime()) return
    const listener = listenEmbeddedBrowserCloseRequests(request => {
      if (request.label !== DEFAULT_EMBEDDED_BROWSER_LABEL) return
      setOpenRequest(null)
      nativeLabelRef.current = null
      hasOpenedRef.current = false
    })
    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [])

  useEffect(() => {
    return () => {
      if (!hasOpenedRef.current || !isElectronRuntime()) return
      void closeEmbeddedBrowser(
        DEFAULT_EMBEDDED_BROWSER_LABEL,
        nativeLabelRef.current ?? undefined
      ).catch(() => {})
    }
  }, [])

  if (!openRequest) return null

  const close = () => {
    hasOpenedRef.current = false
    setOpenRequest(null)
    void closeEmbeddedBrowser(
      DEFAULT_EMBEDDED_BROWSER_LABEL,
      nativeLabelRef.current ?? undefined
    ).catch(error => {
      console.error('[Wework] Failed to close the collaboration browser', error)
    })
    nativeLabelRef.current = null
  }

  return (
    <aside
      className="fixed bottom-3 right-3 top-14 z-[80] flex w-[min(560px,calc(100vw-24px))] flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl max-sm:left-3 max-sm:w-auto"
      data-testid="collaboration-embedded-browser-panel"
      aria-label={t('workbench.browser')}
    >
      <header className="flex h-[52px] shrink-0 items-center justify-between border-b border-border px-4">
        <span className="text-sm font-medium text-text-primary">{t('workbench.browser')}</span>
        <button
          type="button"
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/70"
          data-testid="collaboration-embedded-browser-close"
          aria-label={t('workbench.close_browser')}
          onClick={close}
        >
          <X aria-hidden="true" className="h-4 w-4" />
        </button>
      </header>
      <div className="min-h-0 flex-1">
        <WorkspaceBrowserPanel
          active
          label={DEFAULT_EMBEDDED_BROWSER_LABEL}
          openRequest={openRequest}
          onNativeLabelChange={label => {
            nativeLabelRef.current = label
          }}
        />
      </div>
    </aside>
  )
}
