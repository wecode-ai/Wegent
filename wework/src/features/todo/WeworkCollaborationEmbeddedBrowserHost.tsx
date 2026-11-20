import { X } from 'lucide-react'
import { useCallback, useId, useMemo, useSyncExternalStore } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import { createCollaborationBrowserSource } from './collaborationBrowserSource'
import { WorkspaceBrowserPanel } from '@/components/layout/workspace-panels/WorkspaceBrowserPanelContainer'

export function WeworkCollaborationEmbeddedBrowserHost({
  workspaceActive,
}: {
  workspaceActive: boolean
}) {
  const { t } = useTranslation('common')
  const hostId = useId()
  const label = `workspace-browser-collaboration-${hostId.replace(/[^a-zA-Z0-9_-]/g, '-')}`
  const source = useMemo(() => createCollaborationBrowserSource(label), [label])
  const subscribe = useCallback(
    (listener: () => void) => source.subscribe(listener, workspaceActive),
    [source, workspaceActive]
  )
  const openRequest = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  if (!openRequest) return null
  const close = source.close
  const onNativeLabelChange = source.onNativeLabelChange

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
          className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/70"
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
