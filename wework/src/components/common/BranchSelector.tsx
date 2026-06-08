import {
  Check,
  ChevronDown,
  GitBranch,
  Plus,
  Search,
  X,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface BranchSelectorProps {
  currentBranch?: string
  loading?: boolean
  onRefresh?: () => Promise<void>
  onListBranches: () => Promise<string[]>
  onCheckoutBranch: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  variant: 'environment' | 'workbar'
  mobileSheet?: boolean
}

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

export function BranchSelector({
  currentBranch,
  loading = false,
  onRefresh,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
  variant,
  mobileSheet = false,
}: BranchSelectorProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const rootRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const [branches, setBranches] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [branchesLoading, setBranchesLoading] = useState(false)
  const [action, setAction] = useState<'idle' | 'switching' | 'creating'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [createFormOpen, setCreateFormOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const prefix = variant === 'environment' ? 'environment' : 'project'
  const useMobileSheet = mobileSheet && isMobile && variant === 'workbar'
  const filteredBranches = useMemo(
    () => branches.filter(branch => branchMatchesQuery(branch, query)),
    [branches, query],
  )

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setError(null)
    setCreateFormOpen(false)
    setNewBranchName('')
  }, [])

  useEffect(() => {
    if (!open) return

    function handlePointerDown(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') close()
    }

    if (!useMobileSheet) {
      document.addEventListener('pointerdown', handlePointerDown)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [close, open, useMobileSheet])

  async function handleToggle() {
    if (open) {
      close()
      return
    }

    setOpen(true)
    setError(null)
    setBranchesLoading(true)
    try {
      await onRefresh?.()
      setBranches(await onListBranches())
    } catch (nextError) {
      setBranches([])
      setError(
        nextError instanceof Error
          ? nextError.message
          : t('workbench.environment_branch_load_failed', '分支加载失败'),
      )
    } finally {
      setBranchesLoading(false)
    }
  }

  async function handleCheckout(branchName: string) {
    if (branchName === currentBranch) {
      close()
      return
    }

    setError(null)
    setAction('switching')
    try {
      await onCheckoutBranch(branchName)
      close()
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t('workbench.environment_branch_checkout_failed', '切换分支失败'),
      )
    } finally {
      setAction('idle')
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const branchName = newBranchName.trim()
    if (!branchName || !onCreateBranch) return

    setError(null)
    setAction('creating')
    try {
      await onCreateBranch(branchName)
      close()
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t('workbench.environment_branch_create_failed', '创建分支失败'),
      )
    } finally {
      setAction('idle')
    }
  }

  const branchLabel = loading
    ? t('common.loading', '加载中...')
    : currentBranch || t('workbench.environment_branch_empty', '暂无分支')

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-testid={`${prefix}-branch-${variant === 'environment' ? 'row' : 'button'}`}
        onClick={() => void handleToggle()}
        className={cn(
          variant === 'environment'
            ? 'flex h-9 w-full items-center gap-3 rounded-md text-left text-[13px] text-text-primary hover:bg-hover'
            : 'flex h-9 min-w-[44px] items-center gap-2 rounded-full px-2 text-[13px] font-medium leading-[18px] text-text-secondary transition-[background-color,color,box-shadow] hover:bg-background hover:text-text-primary hover:shadow-[0_10px_28px_rgba(0,0,0,0.14)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
          open && variant === 'workbar' &&
            'bg-background text-text-primary shadow-[0_10px_28px_rgba(0,0,0,0.14)]',
        )}
        aria-label={t('workbench.environment_branch_menu', '切换分支')}
        aria-expanded={open}
      >
        <GitBranch className={variant === 'environment' ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
        <span className="min-w-0 flex-1 truncate">{branchLabel}</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-text-secondary" />
      </button>

      {open && useMobileSheet && (
        <div className="fixed inset-0 z-modal bg-black/25" onClick={close} />
      )}

      {open && (
        <div
          data-testid={`${prefix}-branch-menu`}
          data-mobile={useMobileSheet ? 'true' : undefined}
          className={cn(
            useMobileSheet
              ? 'fixed inset-x-0 bottom-0 z-modal flex max-h-[56dvh] flex-col rounded-t-[28px] border border-border bg-background px-5 pb-2 text-text-primary shadow-[0_-18px_48px_rgba(0,0,0,0.18)]'
              : 'absolute z-system-popover w-[320px] rounded-2xl border border-border bg-background px-3 py-3 text-text-primary shadow-[0_18px_44px_rgba(0,0,0,0.18)]',
            !useMobileSheet && (
              variant === 'environment'
                ? 'right-[calc(100%-44px)] top-[38px]'
                : 'bottom-11 left-0'
            ),
          )}
        >
          {useMobileSheet && (
            <>
              <div className="mx-auto mt-2 h-1 w-11 shrink-0 rounded-full bg-border" />
              <div className="flex shrink-0 items-center justify-between pb-2 pt-3">
                <div className="min-w-0">
                  <h2 className="text-base font-semibold text-text-primary">
                    {t('workbench.environment_branch_menu', '切换分支')}
                  </h2>
                  <p className="truncate text-xs text-text-muted">{branchLabel}</p>
                </div>
                <button
                  type="button"
                  data-testid={`${prefix}-branch-mobile-close-button`}
                  aria-label={t('workbench.close_menu', '关闭菜单')}
                  onClick={close}
                  className="flex h-10 w-10 items-center justify-center rounded-full bg-surface text-text-primary"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </>
          )}
          <label className={cn(
            'flex h-9 items-center gap-2 rounded-lg px-2 text-text-muted',
            useMobileSheet && 'h-10 shrink-0 rounded-2xl bg-surface px-4',
          )}>
            <Search className="h-4 w-4 shrink-0" />
            <input
              data-testid={`${prefix}-branch-search-input`}
              value={query}
              onChange={event => setQuery(event.target.value)}
              className={cn(
                'min-w-0 flex-1 bg-transparent text-sm text-text-primary outline-none placeholder:text-text-muted',
                useMobileSheet && 'text-base leading-5',
              )}
              placeholder={t('workbench.environment_branch_search', '搜索分支')}
              autoFocus={!useMobileSheet}
            />
          </label>
          <h3 className={cn(
            'mt-3 px-2 text-xs font-medium text-text-secondary',
            useMobileSheet && 'mt-2',
          )}>
            {t('workbench.environment_branches', '分支')}
          </h3>
          <div className={cn(
            'mt-2 max-h-[220px] overflow-y-auto',
            useMobileSheet && 'scrollbar-none min-h-0 max-h-[260px] space-y-1 pb-1',
          )}>
            {branchesLoading && (
              <p className="px-2 py-3 text-sm text-text-muted">
                {t('common.loading', '加载中...')}
              </p>
            )}
            {!branchesLoading && error && (
              <p className="px-2 py-3 text-xs text-red-500">{error}</p>
            )}
            {!branchesLoading && !error && filteredBranches.map(branch => (
              <button
                type="button"
                key={branch}
                data-testid={`${prefix}-branch-option`}
                disabled={action !== 'idle'}
                onClick={() => void handleCheckout(branch)}
                className={cn(
                  'flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-text-primary hover:bg-hover disabled:cursor-not-allowed disabled:opacity-60',
                  useMobileSheet && 'h-10 text-base',
                )}
              >
                <GitBranch className="h-4 w-4 shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate">{branch}</span>
                {branch === currentBranch && (
                  <Check className="h-4 w-4 shrink-0 text-text-secondary" />
                )}
              </button>
            ))}
            {!branchesLoading && !error && filteredBranches.length === 0 && (
              <p className="px-2 py-3 text-sm text-text-muted">
                {t('workbench.environment_branch_empty_results', '没有匹配的分支')}
              </p>
            )}
          </div>
          <div className={cn(
            'mt-2 border-t border-border pt-2',
            useMobileSheet && 'mt-1 pt-1',
          )}>
            {createFormOpen ? (
              <form className="flex items-center gap-2" onSubmit={handleCreate}>
                <input
                  data-testid={`${prefix}-new-branch-input`}
                  value={newBranchName}
                  onChange={event => setNewBranchName(event.target.value)}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-sm outline-none focus:border-primary"
                  placeholder={t('workbench.environment_new_branch_placeholder', '输入新分支名')}
                  autoFocus={!useMobileSheet}
                />
                <button
                  type="submit"
                  data-testid={`${prefix}-confirm-new-branch-button`}
                  disabled={!newBranchName.trim() || action === 'creating'}
                  className="h-8 rounded-md bg-primary px-2 text-xs font-medium text-primary-contrast disabled:opacity-50"
                >
                  {action === 'creating'
                    ? t('workbench.environment_branch_creating', '创建中')
                    : t('workbench.environment_branch_create_confirm', '创建')}
                </button>
              </form>
            ) : (
              <button
                type="button"
                data-testid={`${prefix}-open-new-branch-button`}
                disabled={!onCreateBranch || action !== 'idle'}
                onClick={() => setCreateFormOpen(true)}
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
              >
                <Plus className="h-4 w-4" />
                {t('workbench.environment_branch_create_checkout', '创建并检出新分支...')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
