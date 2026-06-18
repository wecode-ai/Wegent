import { Check, ChevronDown, GitBranch, Search, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import {
  calculateFloatingMenuLayout,
  getFloatingMenuVisibleBounds,
  type FloatingMenuPlacement,
} from '@/lib/floating-menu'
import { cn } from '@/lib/utils'
import { useOutsideClick } from './useOutsideClick'

interface WorktreeBranchSelectorProps {
  currentBranch?: string
  selectedBranch?: string | null
  loading?: boolean
  onListBranches: () => Promise<string[]>
  onSelectBranch: (branchName: string) => void
}

const WORKTREE_BRANCH_MENU_MAX_HEIGHT = 360

function branchMatchesQuery(branch: string, query: string): boolean {
  const normalizedBranch = branch.toLowerCase()
  const normalizedQuery = query.trim().toLowerCase()
  if (!normalizedQuery || normalizedBranch.includes(normalizedQuery)) return true

  let queryIndex = 0
  for (const character of normalizedBranch) {
    if (character === normalizedQuery[queryIndex]) {
      queryIndex += 1
      if (queryIndex === normalizedQuery.length) return true
    }
  }
  return false
}

export function WorktreeBranchSelector({
  currentBranch,
  selectedBranch,
  loading = false,
  onListBranches,
  onSelectBranch,
}: WorktreeBranchSelectorProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [desktopMenuLayout, setDesktopMenuLayout] = useState<{
    placement: FloatingMenuPlacement
    maxHeight: number
  }>({
    placement: 'below',
    maxHeight: WORKTREE_BRANCH_MENU_MAX_HEIGHT,
  })
  const effectiveBranch = selectedBranch?.trim() || currentBranch?.trim() || ''
  const branchLabel = loading
    ? t('workbench.project_worktree_branch_loading')
    : effectiveBranch || t('workbench.project_worktree_branch_empty')
  const filteredBranches = useMemo(
    () => branches.filter(branch => branchMatchesQuery(branch, query)),
    [branches, query]
  )

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])

  useOutsideClick(containerRef, open, close)

  const updateDesktopMenuLayout = useCallback(() => {
    if (!open || isMobile || typeof window === 'undefined') return

    const triggerRect = triggerRef.current?.getBoundingClientRect()
    if (!triggerRect) return

    const nextLayout = calculateFloatingMenuLayout({
      triggerRect,
      visibleBounds: getFloatingMenuVisibleBounds(containerRef.current),
      preferredPlacement: 'below',
      maxHeight: WORKTREE_BRANCH_MENU_MAX_HEIGHT,
    })

    setDesktopMenuLayout(current =>
      current.placement === nextLayout.placement && current.maxHeight === nextLayout.maxHeight
        ? current
        : nextLayout
    )
  }, [isMobile, open])

  useEffect(() => {
    if (!open) return

    let cancelled = false
    async function loadBranches() {
      setBranchesLoading(true)
      setError(null)
      try {
        const items = await onListBranches()
        if (!cancelled) setBranches(items)
      } catch (loadError) {
        if (cancelled) return
        setBranches([])
        setError(
          loadError instanceof Error
            ? loadError.message
            : t('workbench.project_worktree_branch_load_failed')
        )
      } finally {
        if (!cancelled) setBranchesLoading(false)
      }
    }

    void loadBranches()
    return () => {
      cancelled = true
    }
  }, [onListBranches, open, t])

  useEffect(() => {
    if (!open || isMobile) return
    searchInputRef.current?.focus()
  }, [isMobile, open])

  useLayoutEffect(() => {
    if (!open || isMobile) return

    updateDesktopMenuLayout()
  }, [isMobile, open, updateDesktopMenuLayout])

  useEffect(() => {
    if (!open || isMobile) return

    window.addEventListener('resize', updateDesktopMenuLayout)
    window.addEventListener('scroll', updateDesktopMenuLayout, true)
    return () => {
      window.removeEventListener('resize', updateDesktopMenuLayout)
      window.removeEventListener('scroll', updateDesktopMenuLayout, true)
    }
  }, [isMobile, open, updateDesktopMenuLayout])

  useEffect(() => {
    if (!open) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [close, open])

  const handleSelectBranch = (branch: string) => {
    onSelectBranch(branch)
    close()
    triggerRef.current?.focus()
  }

  return (
    <div ref={containerRef} className="relative">
      {open && isMobile && <div className="fixed inset-0 z-modal bg-black/25" onClick={close} />}
      {open && (
        <div
          data-testid="project-worktree-branch-menu"
          data-mobile={isMobile ? 'true' : undefined}
          className={cn(
            isMobile
              ? 'fixed inset-x-0 bottom-0 z-modal flex max-h-[45dvh] flex-col rounded-t-[28px] border border-border bg-background shadow-[0_-18px_48px_rgba(0,0,0,0.18)]'
              : 'absolute left-0 z-popover flex w-64 flex-col overflow-hidden rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
            !isMobile && (desktopMenuLayout.placement === 'below' ? 'top-11' : 'bottom-11')
          )}
          style={isMobile ? undefined : { maxHeight: desktopMenuLayout.maxHeight }}
        >
          {isMobile && (
            <>
              <div className="mx-auto mt-3 h-1 w-11 shrink-0 rounded-full bg-border" />
              <div className="flex shrink-0 items-center justify-between px-5 pb-3 pt-4">
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-text-primary">
                    {t('workbench.project_worktree_branch_title')}
                  </h2>
                  <p className="mt-1 truncate text-xs text-text-muted">{branchLabel}</p>
                </div>
                <button
                  type="button"
                  data-testid="project-worktree-branch-mobile-close-button"
                  aria-label={t('workbench.close_menu')}
                  onClick={close}
                  className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-text-primary"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </>
          )}
          <div className={cn('min-h-0 flex flex-1 flex-col', isMobile && 'px-5 pb-5')}>
            <label
              className={cn(
                'flex h-9 shrink-0 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-text-secondary',
                isMobile && 'h-11 rounded-2xl text-base'
              )}
            >
              <Search className="h-4 w-4 shrink-0" />
              <input
                ref={searchInputRef}
                data-testid="project-worktree-branch-search-input"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('workbench.project_worktree_branch_search')}
                className={cn(
                  'min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-text-primary outline-none placeholder:text-text-muted',
                  isMobile && 'text-base leading-5'
                )}
              />
            </label>
            <div className="mt-2 shrink-0 px-2 text-xs font-medium leading-5 text-text-muted">
              {t('workbench.project_worktree_branch_title')}
            </div>
            <div
              data-testid="project-worktree-branch-list"
              className={cn(
                'min-h-0 flex-1 overflow-y-auto',
                isMobile ? 'max-h-[28dvh]' : 'max-h-56'
              )}
            >
              {branchesLoading && (
                <p className="px-2 py-3 text-[13px] text-text-muted">
                  {t('workbench.project_worktree_branch_loading')}
                </p>
              )}
              {!branchesLoading && error && (
                <p className="px-2 py-3 text-[13px] text-danger">{error}</p>
              )}
              {!branchesLoading &&
                !error &&
                filteredBranches.map(branch => (
                  <button
                    key={branch}
                    type="button"
                    data-testid="project-worktree-branch-option"
                    onClick={() => handleSelectBranch(branch)}
                    className="flex min-h-9 w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-[13px] text-text-primary hover:bg-muted"
                  >
                    <GitBranch className="h-4 w-4 shrink-0 text-text-secondary" />
                    <span className="min-w-0 flex-1 truncate">{branch}</span>
                    {branch === effectiveBranch && (
                      <Check className="h-4 w-4 shrink-0 text-text-primary" />
                    )}
                  </button>
                ))}
              {!branchesLoading && !error && filteredBranches.length === 0 && (
                <p
                  data-testid="project-worktree-branch-empty"
                  className="px-2 py-3 text-[13px] text-text-muted"
                >
                  {t('workbench.project_worktree_branch_empty_results')}
                </p>
              )}
            </div>
          </div>
        </div>
      )}
      <button
        ref={triggerRef}
        type="button"
        data-testid="project-worktree-branch-button"
        onClick={() => setOpen(current => !current)}
        className={cn(
          'flex h-9 min-w-[44px] items-center gap-2 rounded-full px-2 text-[13px] font-medium leading-[18px] text-text-secondary transition-[background-color,color,box-shadow] hover:bg-background hover:text-text-primary hover:shadow-[0_10px_28px_rgba(0,0,0,0.14)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          open && 'bg-background text-text-primary shadow-[0_10px_28px_rgba(0,0,0,0.14)]'
        )}
        aria-expanded={open}
        aria-label={t('workbench.project_worktree_branch_title')}
      >
        <GitBranch className="h-4 w-4 shrink-0" />
        <span className="max-w-[8rem] truncate">{branchLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0" />
      </button>
    </div>
  )
}
