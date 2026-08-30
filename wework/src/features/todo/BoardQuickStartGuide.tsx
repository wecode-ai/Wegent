import { Check, ChevronDown, ChevronUp, ListChecks } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface StoredQuickStartState {
  started: boolean
  detailsOpened: boolean
  collapsed: boolean
  dismissed: boolean
  completed: boolean
}

interface BoardQuickStartGuideProps {
  storageKey: string
  itemKind: 'issue' | 'task'
  hasCreatedItem: boolean
  hasAdvancedItem: boolean
  detailOpened: boolean
  onCreateItem: () => void
  onOpenFirstItem: () => void
}

const initialQuickStartState: StoredQuickStartState = {
  started: false,
  detailsOpened: false,
  collapsed: false,
  dismissed: false,
  completed: false,
}

function readQuickStartState(storageKey: string): StoredQuickStartState | null {
  try {
    const raw = localStorage.getItem(storageKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredQuickStartState>
    return {
      started: parsed.started === true,
      detailsOpened: parsed.detailsOpened === true,
      collapsed: parsed.collapsed === true,
      dismissed: parsed.dismissed === true,
      completed: parsed.completed === true,
    }
  } catch {
    return null
  }
}

function writeQuickStartState(storageKey: string, state: StoredQuickStartState): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(state))
  } catch {
    // The guide must never block the board when local storage is unavailable.
  }
}

export function BoardQuickStartGuide({
  storageKey,
  itemKind,
  hasCreatedItem,
  hasAdvancedItem,
  detailOpened,
  onCreateItem,
  onOpenFirstItem,
}: BoardQuickStartGuideProps) {
  const { t } = useTranslation('common')
  const [state, setState] = useState<StoredQuickStartState>(() => {
    const stored = readQuickStartState(storageKey)
    if (stored) return stored
    if (hasCreatedItem) return initialQuickStartState
    const started = { ...initialQuickStartState, started: true }
    writeQuickStartState(storageKey, started)
    return started
  })
  const [showCompletion, setShowCompletion] = useState(false)

  useEffect(() => {
    if (!detailOpened || !state.started || state.detailsOpened) return
    const timeout = window.setTimeout(() => {
      setState(current => {
        if (!current.started || current.detailsOpened) return current
        const next = { ...current, detailsOpened: true }
        writeQuickStartState(storageKey, next)
        return next
      })
    }, 0)
    return () => window.clearTimeout(timeout)
  }, [detailOpened, state.detailsOpened, state.started, storageKey])

  const completedStepCount = useMemo(
    () => Number(hasCreatedItem) + Number(state.detailsOpened) + Number(hasAdvancedItem),
    [hasAdvancedItem, hasCreatedItem, state.detailsOpened]
  )
  const allStepsCompleted = completedStepCount === 3

  useEffect(() => {
    if (!state.started || state.completed || !allStepsCompleted) return
    const completionTimeout = window.setTimeout(() => {
      setState(current => {
        if (current.completed) return current
        const next = { ...current, completed: true }
        writeQuickStartState(storageKey, next)
        return next
      })
      setShowCompletion(true)
    }, 0)
    return () => window.clearTimeout(completionTimeout)
  }, [allStepsCompleted, state.completed, state.started, storageKey])

  useEffect(() => {
    if (!showCompletion) return
    const timeout = window.setTimeout(() => setShowCompletion(false), 5000)
    return () => window.clearTimeout(timeout)
  }, [showCompletion])

  if (!state.started || state.dismissed || (state.completed && !showCompletion)) return null

  const itemLabel =
    itemKind === 'task' ? t('todo.quick_start_task', '任务') : t('todo.quick_start_issue', 'Issue')
  const updateState = (patch: Partial<StoredQuickStartState>) => {
    setState(current => {
      const next = { ...current, ...patch }
      writeQuickStartState(storageKey, next)
      return next
    })
  }

  if (showCompletion) {
    return (
      <div
        data-testid="cloud-board-quick-start-complete"
        role="status"
        className="mx-6 mb-3 flex min-h-10 items-center gap-2 rounded-xl border border-border bg-muted/50 px-3 text-sm text-text-secondary"
      >
        <Check className="h-4 w-4 text-green-600 dark:text-green-400" aria-hidden="true" />
        <span>{t('todo.quick_start_completed', '快速上手已完成，可以继续推进工作了。')}</span>
      </div>
    )
  }

  return (
    <section
      data-testid="cloud-board-quick-start"
      className="mx-6 mb-3 rounded-xl border border-border bg-muted/40"
      aria-label={t('todo.quick_start_title', '快速上手')}
    >
      <div className="flex min-h-10 items-center gap-2 px-3">
        <ListChecks className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
        <span className="text-sm font-medium text-text-primary">
          {t('todo.quick_start_title', '快速上手')}
        </span>
        <span className="text-xs text-text-muted" aria-live="polite">
          {t('todo.quick_start_progress', '{{completed}}/3', {
            completed: completedStepCount,
          })}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          data-testid="cloud-board-quick-start-dismiss"
          onClick={() => updateState({ dismissed: true })}
          className="h-7 rounded-lg px-2 text-xs text-text-muted transition hover:bg-background hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
        >
          {t('todo.quick_start_dismiss', '不再显示')}
        </button>
        <button
          type="button"
          data-testid="cloud-board-quick-start-toggle"
          aria-expanded={!state.collapsed}
          onClick={() => updateState({ collapsed: !state.collapsed })}
          className="flex h-7 items-center gap-1 rounded-lg px-2 text-xs text-text-secondary transition hover:bg-background hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30"
        >
          {state.collapsed
            ? t('todo.quick_start_expand', '展开')
            : t('todo.quick_start_collapse', '收起')}
          {state.collapsed ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
          )}
        </button>
      </div>
      {!state.collapsed ? (
        <ol className="grid gap-px border-t border-border bg-border lg:grid-cols-3">
          <QuickStartStep
            testId="cloud-board-quick-start-create"
            complete={hasCreatedItem}
            title={t('todo.quick_start_create_title', '创建第一个 {{item}}', {
              item: itemLabel,
            })}
            description={t(
              'todo.quick_start_create_description',
              '记录一个需要推进的问题、目标或交付。'
            )}
            actionLabel={t('todo.quick_start_create_action', '新建 {{item}}', {
              item: itemLabel,
            })}
            onAction={onCreateItem}
          />
          <QuickStartStep
            testId="cloud-board-quick-start-open"
            complete={state.detailsOpened}
            title={t('todo.quick_start_open_title', '打开详情')}
            description={t(
              'todo.quick_start_open_description',
              '查看描述、负责人、执行进展和交付结果。'
            )}
            actionLabel={t('todo.quick_start_open_action', '查看详情')}
            actionDisabled={!hasCreatedItem}
            onAction={onOpenFirstItem}
          />
          <QuickStartStep
            testId="cloud-board-quick-start-advance"
            complete={hasAdvancedItem}
            title={t('todo.quick_start_advance_title', '推进到下一阶段')}
            description={t(
              'todo.quick_start_advance_description',
              '把卡片从收集箱拖到待开始，状态会自动同步。'
            )}
          />
        </ol>
      ) : null}
    </section>
  )
}

function QuickStartStep({
  testId,
  complete,
  title,
  description,
  actionLabel,
  actionDisabled = false,
  onAction,
}: {
  testId: string
  complete: boolean
  title: string
  description: string
  actionLabel?: string
  actionDisabled?: boolean
  onAction?: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <li
      data-testid={testId}
      data-complete={complete}
      className="flex min-h-24 items-start gap-3 bg-background px-3 py-3 first:rounded-bl-xl last:rounded-br-xl"
    >
      <span
        className={[
          'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs',
          complete
            ? 'border-green-600/30 bg-green-600/10 text-green-700 dark:text-green-300'
            : 'border-border text-text-muted',
        ].join(' ')}
        aria-label={
          complete
            ? t('todo.quick_start_step_completed', '已完成')
            : t('todo.quick_start_step_pending', '未完成')
        }
      >
        {complete ? <Check className="h-3 w-3" aria-hidden="true" /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-text-primary">{title}</span>
        <span className="mt-1 block text-xs leading-4 text-text-muted">{description}</span>
        {actionLabel && !complete ? (
          <button
            type="button"
            data-testid={`${testId}-action`}
            disabled={actionDisabled}
            onClick={onAction}
            className="mt-2 h-7 rounded-lg bg-muted px-2.5 text-xs font-medium text-text-secondary transition hover:bg-text-primary/10 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus/30 disabled:opacity-40"
          >
            {actionLabel}
          </button>
        ) : null}
      </span>
    </li>
  )
}
