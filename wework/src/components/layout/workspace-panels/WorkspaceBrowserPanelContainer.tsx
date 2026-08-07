import { Globe2, Loader2, Plus, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  closeEmbeddedBrowser,
  closeEmbeddedBrowsers,
  isEmbeddedBrowserLabelTransferred,
  relabelEmbeddedBrowser,
  setEmbeddedBrowserActiveTab,
} from '@/lib/embedded-browser'
import { cn } from '@/lib/utils'
import {
  MAX_BROWSER_LIVE_WEBVIEWS,
  closeBrowserTab,
  createBrowserTab,
  findBrowserTabForLru,
  selectBrowserTab,
  suspendBrowserTab,
  type BrowserTab,
  type BrowserTabCollection,
} from '@/features/browser-tabs/browserTabs'
import { WorkspaceBrowserTabPanel, type WorkspaceBrowserPanelProps } from './WorkspaceBrowserPanel'

export const WORKSPACE_BROWSER_NEW_TAB_EVENT = 'wework:workspace-browser-new-tab'

export function WorkspaceBrowserPanel(props: WorkspaceBrowserPanelProps) {
  const { t } = useTranslation('common')
  const baseLabel = props.label ?? 'workspace-browser'
  const { onFaviconChange, onTabsChange, onTitleChange, openRequest } = props
  const [collection, setCollection] = useState<BrowserTabCollection>(() => {
    const tab = createBrowserTab(baseLabel, { id: 'base', label: baseLabel })
    return { tabs: [tab], activeTabId: tab.id }
  })
  const [openRequestTarget, setOpenRequestTarget] = useState<{
    id: string
    tabId: string
  } | null>(null)
  const handledOpenRequestIdRef = useRef<string | null>(null)
  const labelsRef = useRef<string[]>([])

  const updateTab = useCallback((tabId: string, update: Partial<BrowserTab>) => {
    setCollection(current => ({
      ...current,
      tabs: current.tabs.map(tab => (tab.id === tabId ? { ...tab, ...update } : tab)),
    }))
  }, [])

  const reclaimCapacity = useCallback(
    async (excludeTabId?: string) => {
      const candidate = findBrowserTabForLru(
        collection.tabs,
        MAX_BROWSER_LIVE_WEBVIEWS,
        excludeTabId
      )
      if (!candidate) {
        return (
          collection.tabs.filter(tab => !tab.suspended && tab.nativeLabel).length <
          MAX_BROWSER_LIVE_WEBVIEWS
        )
      }

      await closeEmbeddedBrowser(candidate.label).catch(error => {
        console.error('Failed to suspend embedded browser tab:', error)
      })
      setCollection(current => ({
        ...current,
        tabs: current.tabs.map(tab => (tab.id === candidate.id ? suspendBrowserTab(tab) : tab)),
      }))
      return true
    },
    [collection.tabs]
  )

  useEffect(() => {
    const request = openRequest
    if (!request || request.id === handledOpenRequestIdRef.current) return
    handledOpenRequestIdRef.current = request.id
    let disposed = false
    queueMicrotask(() => {
      if (disposed) return
      const opensInNewTab =
        request.disposition === 'new-tab' || request.source === 'user' || request.source === 'popup'
      if (!opensInNewTab) {
        setCollection(current => ({
          ...current,
          tabs: current.tabs.map(tab =>
            tab.id === current.activeTabId
              ? { ...tab, url: request.url, status: 'loading', suspended: false }
              : tab
          ),
        }))
        setOpenRequestTarget({ id: request.id, tabId: collection.activeTabId })
        return
      }
      void Promise.resolve().then(async () => {
        const canOpen = await reclaimCapacity(collection.activeTabId)
        if (!canOpen || disposed) return
        const seed = createBrowserTab(baseLabel)
        const tab = createBrowserTab(baseLabel, {
          id: seed.id,
          label: baseLabel + '--tab-' + seed.id.slice(0, 8),
          url: request.url,
        })
        setCollection(current => ({
          tabs: [...current.tabs, tab],
          activeTabId: tab.id,
        }))
        setOpenRequestTarget({ id: request.id, tabId: tab.id })
      })
    })
    return () => {
      disposed = true
    }
  }, [baseLabel, collection.activeTabId, openRequest, reclaimCapacity])

  const addTab = useCallback(() => {
    void reclaimCapacity(collection.activeTabId).then(canOpen => {
      if (!canOpen) return
      const seed = createBrowserTab(baseLabel)
      const tab = createBrowserTab(baseLabel, {
        id: seed.id,
        label: baseLabel + '--tab-' + seed.id.slice(0, 8),
      })
      setCollection(current => ({
        tabs: [...current.tabs, tab],
        activeTabId: tab.id,
      }))
    })
  }, [baseLabel, collection.activeTabId, reclaimCapacity])

  useEffect(() => {
    const handleNewTab = () => addTab()
    window.addEventListener(WORKSPACE_BROWSER_NEW_TAB_EVENT, handleNewTab)
    return () => window.removeEventListener(WORKSPACE_BROWSER_NEW_TAB_EVENT, handleNewTab)
  }, [addTab])

  const selectTab = useCallback((tabId: string) => {
    setCollection(current => selectBrowserTab(current, tabId))
  }, [])

  useEffect(() => {
    const active = collection.tabs.find(tab => tab.id === collection.activeTabId)
    if (!active || typeof setEmbeddedBrowserActiveTab !== 'function') return
    void setEmbeddedBrowserActiveTab(baseLabel, active.label).catch(error => {
      // The native tab may not exist yet for an idle or suspended logical tab.
      if (active.status !== 'idle' && !active.suspended) {
        console.error('Failed to synchronize active embedded browser tab:', error)
      }
    })
  }, [baseLabel, collection.activeTabId, collection.tabs])

  useEffect(() => {
    labelsRef.current = collection.tabs.map(tab => tab.label)
    onTabsChange?.({
      activeLabel: collection.tabs.find(tab => tab.id === collection.activeTabId)?.label ?? null,
      baseLabel,
      labels: collection.tabs.map(tab => tab.label),
      hasActiveDownload: collection.tabs.some(
        tab => tab.hasActiveDownload && !tab.suspended && Boolean(tab.nativeLabel)
      ),
    })
  }, [baseLabel, collection.activeTabId, collection.tabs, onTabsChange])

  useEffect(() => {
    return () => {
      const labelsToClose = labelsRef.current.filter(
        label => !isEmbeddedBrowserLabelTransferred(label)
      )
      void closeEmbeddedBrowsers(labelsToClose).catch(error => {
        console.error('Failed to close embedded browser tabs:', error)
      })
    }
  }, [])

  const closeTab = useCallback(
    (tabId: string) => {
      const target = collection.tabs.find(tab => tab.id === tabId)
      if (!target || collection.tabs.length <= 1) return
      if (
        target.hasActiveDownload &&
        !window.confirm(t('workbench.browser_close_tab_with_download_confirm'))
      ) {
        return
      }

      if (target.label === baseLabel) {
        const replacement = collection.tabs.find(tab => tab.id !== tabId)
        if (!replacement) return
        void closeEmbeddedBrowser(target.label)
          .then(() => relabelEmbeddedBrowser(replacement.label, baseLabel))
          .then(() => {
            setCollection(current => {
              const next = closeBrowserTab(current, tabId)
              return {
                ...next,
                tabs: next.tabs.map(tab =>
                  tab.id === replacement.id ? { ...tab, label: baseLabel, baseLabel } : tab
                ),
              }
            })
          })
          .catch(error => {
            console.error('Failed to close base browser tab:', error)
          })
        return
      }

      setCollection(current => closeBrowserTab(current, tabId))
    },
    [baseLabel, collection, t]
  )

  const activeTab = collection.tabs.find(tab => tab.id === collection.activeTabId)
  const handleTitleChange = useCallback(
    (tabId: string, title: string | null) => {
      updateTab(tabId, { title })
      if (tabId === collection.activeTabId) onTitleChange?.(title)
    },
    [collection.activeTabId, onTitleChange, updateTab]
  )
  const handleFaviconChange = useCallback(
    (tabId: string, faviconUrl: string | null) => {
      updateTab(tabId, { faviconUrl })
      if (tabId === collection.activeTabId) onFaviconChange?.(faviconUrl)
    },
    [collection.activeTabId, onFaviconChange, updateTab]
  )

  useEffect(() => {
    onTitleChange?.(activeTab?.title ?? null)
    onFaviconChange?.(activeTab?.faviconUrl ?? null)
  }, [activeTab?.faviconUrl, activeTab?.id, activeTab?.title, onFaviconChange, onTitleChange])

  return (
    <div
      data-testid="workspace-browser-tabs-panel"
      className={cn(
        'flex h-full min-h-0 w-full flex-col bg-background text-text-primary',
        !props.active && 'hidden'
      )}
    >
      <BrowserTabStrip
        tabs={collection.tabs}
        activeTabId={collection.activeTabId}
        onAdd={addTab}
        onSelect={selectTab}
        onClose={closeTab}
      />
      <div className="min-h-0 flex-1">
        {collection.tabs.map(tab => (
          <div key={tab.id} className={tab.id === collection.activeTabId ? 'h-full' : 'hidden'}>
            <WorkspaceBrowserTabPanel
              {...props}
              active={props.active && tab.id === collection.activeTabId}
              label={tab.label}
              openRequest={
                openRequestTarget?.tabId === tab.id && openRequestTarget.id === openRequest?.id
                  ? {
                      ...openRequest,
                      label: tab.label,
                      targetLabel: tab.label,
                    }
                  : null
              }
              onNativeLabelChange={nativeLabel => updateTab(tab.id, { nativeLabel })}
              onDownloadActivityChange={hasActiveDownload =>
                updateTab(tab.id, { hasActiveDownload })
              }
              onTitleChange={title => handleTitleChange(tab.id, title)}
              onFaviconChange={faviconUrl => handleFaviconChange(tab.id, faviconUrl)}
            />
          </div>
        ))}
      </div>
    </div>
  )
}

function BrowserTabStrip({
  tabs,
  activeTabId,
  onAdd,
  onSelect,
  onClose,
}: {
  tabs: BrowserTab[]
  activeTabId: string
  onAdd: () => void
  onSelect: (tabId: string) => void
  onClose: (tabId: string) => void
}) {
  const { t } = useTranslation('common')
  const newTabLabel = t('workbench.browser_new_tab', 'New tab')
  return (
    <div
      data-testid="browser-tab-strip"
      role="tablist"
      className="flex h-8 shrink-0 items-center gap-1 overflow-x-auto border-b border-border bg-surface px-1"
    >
      {tabs.map(tab => {
        const title = tab.title || tab.url || newTabLabel
        return (
          <div
            key={tab.id}
            data-testid={'browser-tab-' + tab.id}
            role="tab"
            aria-selected={tab.id === activeTabId}
            tabIndex={tab.id === activeTabId ? 0 : -1}
            title={title}
            className={cn(
              'group flex h-7 min-w-24 max-w-40 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-text-secondary',
              tab.id === activeTabId && 'bg-background text-text-primary shadow-sm',
              tab.id !== activeTabId && 'hover:bg-muted'
            )}
            onClick={() => onSelect(tab.id)}
            onMouseDown={event => {
              if (event.button === 1) {
                event.preventDefault()
                onClose(tab.id)
              }
            }}
          >
            {tab.status === 'loading' ? (
              <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" />
            ) : (
              <Globe2 className="h-3.5 w-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{title}</span>
            <button
              type="button"
              data-testid={'browser-tab-close-' + tab.id}
              aria-label={t('workbench.browser_close_tab', 'Close tab')}
              className="hidden h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-muted group-hover:flex"
              onClick={event => {
                event.stopPropagation()
                onClose(tab.id)
              }}
              disabled={tabs.length <= 1}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        data-testid="browser-tab-add"
        aria-label={newTabLabel}
        title={newTabLabel}
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-muted hover:text-text-primary"
        onClick={onAdd}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  )
}
