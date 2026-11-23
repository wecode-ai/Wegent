import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { branchMatchesQuery } from '@wegent/chat-core/workspace-branches'
import { SearchableSelect } from '@wegent/collaboration/controls/SearchableSelect'
import { Button } from '@wegent/collaboration/markdown/Button'
import { ChevronDown, GitBranch, X } from 'lucide-react'
import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'

export function BranchPicker({
  value,
  label,
  prefix,
  triggerTestId,
  accessibleLabel,
  onListBranches,
  onChoose,
  onOpenChange,
  footer,
  error: actionError,
  busy = false,
  closeSignal = 0,
  mobileSheet = false,
  composer = false,
  activateSelected = false,
}: {
  value: string
  label: string
  prefix: string
  triggerTestId: string
  accessibleLabel: string
  onListBranches(): Promise<string[]>
  onChoose(branch: string): Promise<void> | void
  onOpenChange?(open: boolean): void
  footer?: ReactNode
  error?: string | null
  busy?: boolean
  closeSignal?: number
  mobileSheet?: boolean
  composer?: boolean
  activateSelected?: boolean
}) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const [openRevision, setOpenRevision] = useState<number | null>(null)
  const open = openRevision === closeSignal
  const setOpen = (next: boolean) => setOpenRevision(next ? closeSignal : null)
  const [query, setQuery] = useState('')
  const branchResource = useMemo(
    () => createAsyncResource(prefix, onListBranches, { refreshOnSubscribe: true }),
    [prefix, onListBranches]
  )
  const snapshot = useSyncExternalStore(
    open ? branchResource.subscribe : subscribeIdleResource,
    open ? branchResource.getSnapshot : getIdleResourceSnapshot
  )
  const branches = snapshot.data ?? []
  const loading = open && (snapshot.status === 'idle' || snapshot.status === 'loading')
  const [selectionError, setError] = useState<string | null>(null)
  const error =
    selectionError ??
    (snapshot.status === 'error'
      ? snapshot.error instanceof Error
        ? snapshot.error.message
        : t('workbench.environment_branch_load_failed', '分支加载失败')
      : null)
  const selecting = useRef(false)
  const changeOpen = (next: boolean) => {
    if (!next && (selecting.current || busy)) return
    if (next) setError(null)
    setOpen(next)
    onOpenChange?.(next)
  }
  const choose = async (branch: string) => {
    if (selecting.current || busy) return
    selecting.current = true
    setError(null)
    try {
      const result = onChoose(branch)
      if (result) await result
      setOpen(false)
      onOpenChange?.(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      selecting.current = false
    }
  }
  return (
    <SearchableSelect
      activateSelected={activateSelected}
      modal={mobileSheet && isMobile}
      value={value}
      options={(loading || error ? [] : branches)
        .filter(branch => branchMatchesQuery(branch, query))
        .map(branch => ({
          value: branch,
          label: branch,
          icon: <GitBranch className="h-4 w-4 shrink-0" aria-hidden="true" />,
          disabled: busy,
          testId: prefix + '-branch-option',
        }))}
      onChange={branch => {
        void choose(branch)
      }}
      testId={triggerTestId}
      menuTestId={prefix + '-branch-menu'}
      searchTestId={prefix + '-branch-search-input'}
      emptyTestId={prefix + '-branch-empty'}
      accessibleLabel={accessibleLabel}
      searchPlaceholder={t('workbench.environment_branch_search', '搜索分支')}
      emptyLabel={t('workbench.environment_branch_empty_results', '没有匹配的分支')}
      triggerContent={
        <>
          <GitBranch
            className={
              composer ? 'h-4 w-4 shrink-0' : 'h-[18px] w-[18px] shrink-0 text-text-secondary'
            }
            aria-hidden="true"
          />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
        </>
      }
      appearance={composer ? 'composer' : 'plain'}
      className={composer ? 'w-full' : 'h-9 w-full gap-3 rounded-md px-0 hover:bg-muted'}
      open={open}
      onOpenChange={changeOpen}
      query={query}
      onSearchChange={setQuery}
      filter={false}
      searchStatus={
        loading ? (
          <p role="status" className="px-3 py-2 text-sm text-text-secondary">
            {t('common.loading', '加载中...')}
          </p>
        ) : error || actionError ? (
          <div role="alert" className="px-3 py-2 text-sm text-destructive">
            {error || actionError}
            {error && (
              <Button
                variant="ghost"
                type="button"
                data-testid={prefix + '-branch-retry'}
                onClick={() => {
                  setError(null)
                  void branchResource.reload()
                }}
              >
                {t('common.retry', '重试')}
              </Button>
            )}
          </div>
        ) : undefined
      }
      renderOptions={list => (
        <div data-testid={prefix + '-branch-list'} className="min-h-0 overflow-auto">
          {list}
        </div>
      )}
      header={
        <div className="flex items-center justify-between gap-2 px-2 py-1 md:hidden">
          <span className="text-sm font-medium">{accessibleLabel}</span>
          <Button
            variant="ghost"
            size="icon"
            type="button"
            data-testid={prefix + '-branch-mobile-close-button'}
            aria-label={t('workbench.close_menu', '关闭菜单')}
            disabled={busy}
            onClick={() => changeOpen(false)}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      }
      footer={footer}
    />
  )
}
