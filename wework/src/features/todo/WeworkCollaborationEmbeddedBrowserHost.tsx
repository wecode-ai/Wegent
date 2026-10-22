import { X } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'

import { useTranslation } from '@/hooks/useTranslation'
import {
  closeEmbeddedBrowser,
  DEFAULT_EMBEDDED_BROWSER_LABEL,
  listenEmbeddedBrowserCloseRequests,
  listenEmbeddedBrowserOpenRequests,
  listenEmbeddedBrowserPopupRequests,
  type EmbeddedBrowserOpenRequest,
} from '@/lib/embedded-browser'
import { isElectronRuntime } from '@/lib/runtime-environment'
import { WorkspaceBrowserPanel } from '@/components/layout/workspace-panels/WorkspaceBrowserPanelContainer'

export function WeworkCollaborationEmbeddedBrowserHost({
  workspaceActive,
}: {
  workspaceActive: boolean
}) {
  const { t } = useTranslation('common')
  const hostId = useId()
  const label = `workspace-browser-collaboration-${hostId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const [openRequest, setOpenRequest] = useState<EmbeddedBrowserOpenRequest | null>(null)
  const hasOpenedRef = useRef(false)
  const nativeLabelRef = useRef<string | null>(null)
  const workspaceActiveRef = useRef(workspaceActive)
  useLayoutEffect(() => {
    workspaceActiveRef.current = workspaceActive
  }, [workspaceActive])
  const open = useCallback(
    (request: EmbeddedBrowserOpenRequest) => {
      hasOpenedRef.current = true
      setOpenRequest({ ...request, label, baseLabel: label, targetLabel: label })
    },
    [label]
  )
  const onNativeLabelChange = useCallback((nativeLabel: string | null) => {
    nativeLabelRef.current = nativeLabel
  }, [])

  useEffect(() => {
    if (!isElectronRuntime() || !workspaceActive) return
    const listener = listenEmbeddedBrowserOpenRequests(request => {
      if (!workspaceActiveRef.current) return
      const baseLabel = request.baseLabel || request.label || DEFAULT_EMBEDDED_BROWSER_LABEL
      const defaultUserRequest =
        request.source === 'user' &&
        baseLabel === DEFAULT_EMBEDDED_BROWSER_LABEL &&
        (!request.targetLabel || request.targetLabel === DEFAULT_EMBEDDED_BROWSER_LABEL)
      const ownedRequest =
        request.targetLabel === label ||
        (baseLabel === label && (!request.targetLabel || request.targetLabel === label))
      if (defaultUserRequest || ownedRequest) open(request)
    })
    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [label, open, workspaceActive])

  useEffect(() => {
    if (!isElectronRuntime() || !workspaceActive) return
    const listener = listenEmbeddedBrowserPopupRequests(request => {
      if (!workspaceActiveRef.current) return
      if (request.parentLabel !== label || request.parentNativeLabel !== nativeLabelRef.current) {
        return
      }
      open({
        id: request.popupId,
        url: request.url,
        baseLabel: label,
        source: 'popup',
        disposition: 'new-tab',
        parentLabel: label,
      })
    })
    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [label, open, workspaceActive])

  useEffect(() => {
    if (!isElectronRuntime()) return
    const listener = listenEmbeddedBrowserCloseRequests(request => {
      if (request.label !== label || request.nativeLabel !== nativeLabelRef.current) return
      setOpenRequest(null)
      nativeLabelRef.current = null
      hasOpenedRef.current = false
    })
    return () => {
      void listener?.then(unlisten => unlisten())
    }
  }, [label])

  useEffect(() => {
    return () => {
      if (!hasOpenedRef.current || !isElectronRuntime()) return
      void closeEmbeddedBrowser(label, nativeLabelRef.current ?? undefined).catch(() => {})
    }
  }, [label])

  if (!openRequest) return null

  const close = () => {
    hasOpenedRef.current = false
    setOpenRequest(null)
    void closeEmbeddedBrowser(label, nativeLabelRef.current ?? undefined).catch(error => {
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
          active={workspaceActive}
          label={label}
          openRequest={openRequest}
          onNativeLabelChange={onNativeLabelChange}
        />
      </div>
    </aside>
  )
}
