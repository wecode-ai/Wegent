import { GitBranch, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

interface WorktreeCreationStatusProps {
  className?: string
}

export function WorktreeCreationStatus({ className }: WorktreeCreationStatusProps) {
  const { t } = useTranslation('common')

  return (
    <section
      data-testid="worktree-creation-status"
      role="status"
      aria-live="polite"
      className={cn(
        'flex min-h-0 min-w-0 flex-1 items-center justify-center px-6 py-12',
        className
      )}
    >
      <div className="flex max-w-md flex-col items-center text-center">
        <div className="relative mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-text-secondary">
          <GitBranch className="h-6 w-6" aria-hidden="true" />
          <span className="absolute -bottom-1 -right-1 flex h-5 w-5 items-center justify-center rounded-full border border-border/70 bg-background">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          </span>
        </div>
        <h1 className="heading-sm text-text-primary">
          {t('workbench.worktree_creation_title', '正在创建工作树')}
        </h1>
        <p className="mt-2 text-sm leading-5 text-text-secondary">
          {t(
            'workbench.worktree_creation_description',
            '正在准备隔离的代码工作区。完成后，任务会自动开始。'
          )}
        </p>
      </div>
    </section>
  )
}
