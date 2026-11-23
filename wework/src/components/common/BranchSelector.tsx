import { useTranslation } from '@/hooks/useTranslation'
import { normalizeGeneratedBranchName } from '@/lib/branch-name'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { LoaderCircle, Plus, Sparkles } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { BranchPicker } from './branch-selector/BranchPicker'
interface BranchSelectorProps {
  currentBranch?: string
  loading?: boolean
  onRefresh?: () => Promise<void>
  onListBranches: () => Promise<string[]>
  onCheckoutBranch: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  onGenerateBranchName?: (sourceText: string) => Promise<string>
  branchNameSource?: string
  variant: 'environment' | 'workbar'
  mobileSheet?: boolean
}

const BRANCH_NAME_GENERATION_TIMEOUT_MS = 30_000

export function BranchSelector({
  currentBranch,
  loading = false,
  onRefresh,
  onListBranches,
  onCheckoutBranch,
  onCreateBranch,
  onGenerateBranchName,
  branchNameSource = '',
  variant,
  mobileSheet = false,
}: BranchSelectorProps) {
  const { t } = useTranslation('common')
  const prefix = variant === 'environment' ? 'environment' : 'project'
  const [action, setAction] = useState<'idle' | 'switching' | 'creating' | 'generating'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [createFormOpen, setCreateFormOpen] = useState(false)
  const [newBranchName, setNewBranchName] = useState('')
  const [revision, setRevision] = useState(0)
  const close = () => {
    setRevision(count => count + 1)
    setError(null)
    setCreateFormOpen(false)
    setNewBranchName('')
    setAction('idle')
  }
  async function handleCheckout(branchName: string) {
    setError(null)
    setAction('switching')
    try {
      await onCheckoutBranch(branchName)
      close()
    } catch (nextError) {
      setError(
        nextError instanceof Error
          ? nextError.message
          : t('workbench.environment_branch_checkout_failed', '切换分支失败')
      )
      throw nextError
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
          : t('workbench.environment_branch_create_failed', '创建分支失败')
      )
    } finally {
      setAction('idle')
    }
  }

  async function handleGenerateBranchName() {
    if (!onGenerateBranchName) return
    const sourceText = branchNameSource.trim()
    if (!sourceText) {
      setError(t('workbench.environment_branch_generate_source_required', '请先输入任务描述'))
      return
    }
    setError(null)
    setAction('generating')
    console.info('[Wework] Branch name generation requested', {
      variant,
      sourceLength: sourceText.length,
    })
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    try {
      const generated = normalizeGeneratedBranchName(
        await Promise.race([
          onGenerateBranchName(sourceText),
          new Promise<never>((_, reject) => {
            timeoutId = setTimeout(
              () =>
                reject(
                  new Error(
                    t('workbench.environment_branch_generate_timeout', 'AI 生成超时，请重试')
                  )
                ),
              BRANCH_NAME_GENERATION_TIMEOUT_MS
            )
          }),
        ])
      )
      if (!generated) {
        throw new Error(t('workbench.environment_branch_generate_empty', 'AI 未生成有效分支名'))
      }
      setNewBranchName(generated)
      console.info('[Wework] Branch name generation completed', {
        variant,
        branchNameLength: generated.length,
      })
    } catch (nextError) {
      console.warn('[Wework] Branch name generation failed', {
        variant,
        error: nextError instanceof Error ? nextError.message : String(nextError),
      })
      setError(
        nextError instanceof Error
          ? nextError.message
          : t('workbench.environment_branch_generate_failed', 'AI 生成分支名失败')
      )
    } finally {
      if (timeoutId) clearTimeout(timeoutId)
      setAction('idle')
    }
  }

  return (
    <div className="min-w-0 max-w-72">
      <BranchPicker
        closeSignal={revision}
        mobileSheet={mobileSheet}
        composer={variant === 'workbar'}
        value={currentBranch ?? ''}
        label={
          loading
            ? t('common.loading', '加载中...')
            : currentBranch || t('workbench.environment_branch_select', '选择分支')
        }
        prefix={prefix}
        triggerTestId={prefix + '-branch-' + (variant === 'environment' ? 'row' : 'button')}
        accessibleLabel={t('workbench.environment_branch_menu', '切换分支')}
        onListBranches={onListBranches}
        onRefresh={onRefresh}
        onChoose={handleCheckout}
        busy={action !== 'idle'}
        error={createFormOpen ? null : error}
        onOpenChange={open => {
          if (!open) {
            setError(null)
            setCreateFormOpen(false)
            setNewBranchName('')
          }
        }}
        footer={
          <div className="pt-1">
            {' '}
            {createFormOpen ? (
              <div>
                <form className="flex items-center gap-2" onSubmit={handleCreate}>
                  <ControlInput
                    density="compact"
                    data-testid={`${prefix}-new-branch-input`}
                    value={newBranchName}
                    onChange={event => setNewBranchName(event.target.value)}
                    disabled={action === 'generating'}
                    aria-busy={action === 'generating'}
                    className="min-w-0 flex-1 disabled:cursor-wait disabled:bg-surface disabled:text-text-muted"
                    placeholder={
                      action === 'generating'
                        ? t('workbench.environment_branch_generating', 'AI 正在生成分支名…')
                        : t('workbench.environment_new_branch_placeholder', '输入新分支名')
                    }
                    autoFocus
                  />
                  {onGenerateBranchName && (
                    <ControlButton
                      variant="unstyled"
                      type="button"
                      data-testid={`${prefix}-generate-new-branch-button`}
                      disabled={action !== 'idle'}
                      onClick={() => void handleGenerateBranchName()}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
                      aria-label={t('workbench.environment_branch_generate', '使用 AI 生成分支名')}
                      title={t('workbench.environment_branch_generate', '使用 AI 生成分支名')}
                    >
                      {action === 'generating' ? (
                        <LoaderCircle className="h-4 w-4 animate-spin" />
                      ) : (
                        <Sparkles className="h-4 w-4" />
                      )}
                    </ControlButton>
                  )}
                  <ControlButton
                    variant="primary"
                    size="sm"
                    type="submit"
                    data-testid={`${prefix}-confirm-new-branch-button`}
                    disabled={!newBranchName.trim() || action !== 'idle'}
                    className="h-8 rounded-md bg-text-primary px-2 text-xs font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
                  >
                    {action === 'creating'
                      ? t('workbench.environment_branch_creating', '创建中')
                      : t('workbench.environment_branch_create_confirm', '创建')}
                  </ControlButton>
                </form>
                {action === 'generating' && (
                  <p
                    data-testid={`${prefix}-branch-generation-status`}
                    className="flex items-center gap-1.5 px-2 pt-2 text-xs text-text-secondary"
                    role="status"
                    aria-live="polite"
                  >
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin" />
                    {t('workbench.environment_branch_generating', 'AI 正在生成分支名…')}
                  </p>
                )}
                {error && (
                  <p
                    data-testid={`${prefix}-branch-generation-error`}
                    className="px-2 pt-2 text-xs text-destructive wework:text-red-500"
                    aria-live="polite"
                  >
                    {error}
                  </p>
                )}
              </div>
            ) : (
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid={`${prefix}-open-new-branch-button`}
                disabled={!onCreateBranch || action !== 'idle'}
                onClick={() => setCreateFormOpen(true)}
                className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-medium hover:bg-hover disabled:cursor-not-allowed disabled:text-text-muted"
              >
                <Plus className="h-4 w-4" />
                {t('workbench.environment_branch_create_checkout', '创建并检出新分支...')}
              </ControlButton>
            )}
          </div>
        }
      />
    </div>
  )
}
