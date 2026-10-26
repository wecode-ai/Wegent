import { ChevronRight, LayoutDashboard, ListTodo, Loader2, Plus, Search, X } from 'lucide-react'
import { useMemo, useState } from 'react'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { useDialogKeyboard } from '@/hooks/useDialogKeyboard'
import { useTranslation } from '@/hooks/useTranslation'
import { sameProjectSpace, projectSpaceRef } from './projectSpaceSelection'

interface TaskBoardAssociationDialogProps {
  project: CloudProject | null
  currentProject: CloudProject | null
  items: CloudLoopItem[]
  loading: boolean
  pending: boolean
  onClose: () => void
  onCreate: () => void
  onSelect: (item: CloudLoopItem) => void
}

type AssociationChoice = { kind: 'create' } | { kind: 'existing'; item: CloudLoopItem }

export function TaskBoardAssociationDialog({
  project,
  currentProject,
  items,
  loading,
  pending,
  onClose,
  onCreate,
  onSelect,
}: TaskBoardAssociationDialogProps) {
  const { t } = useTranslation('common')
  const [query, setQuery] = useState('')
  const [moveChoice, setMoveChoice] = useState<AssociationChoice | null>(null)
  const dialogRef = useDialogKeyboard<HTMLDivElement>(
    () => {
      if (!pending && !moveChoice) onClose()
    },
    Boolean(project),
    '[data-testid="task-board-association-search"]'
  )

  const moving =
    Boolean(currentProject && project) &&
    !sameProjectSpace(projectSpaceRef(currentProject!), projectSpaceRef(project!))
  const candidates = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase()
    return items
      .filter(item => item.can_view_detail !== false && item.can_edit !== false)
      .filter(item =>
        normalized ? `${item.id} ${item.title}`.toLocaleLowerCase().includes(normalized) : true
      )
  }, [items, query])

  if (!project) return null

  const execute = (choice: AssociationChoice) => {
    if (choice.kind === 'create') {
      onCreate()
      return
    }
    onSelect(choice.item)
  }
  const choose = (choice: AssociationChoice) => {
    if (moving) {
      setMoveChoice(choice)
      return
    }
    execute(choice)
  }

  return (
    <>
      <div
        className="fixed inset-0 z-modal flex items-center justify-center bg-black/35 px-4"
        onMouseDown={event => {
          if (event.currentTarget === event.target && !pending) onClose()
        }}
      >
        <section
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="task-board-association-title"
          aria-describedby="task-board-association-description"
          data-testid="task-board-association-dialog"
          className="grid h-[min(640px,calc(100dvh-48px))] w-full max-w-[600px] grid-rows-[auto_auto_minmax(6rem,1fr)_auto] overflow-x-hidden overflow-y-auto overscroll-contain rounded-[20px] border border-border bg-popover text-text-primary shadow-lg"
        >
          <header className="relative px-5 pb-5 pt-5">
            <div className="flex items-center gap-2 pr-12 md:pr-9">
              <LayoutDashboard className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <h2 id="task-board-association-title" className="heading-sm min-w-0 truncate">
                {t('workbench.task_board_association_title', { name: project.name })}
              </h2>
            </div>
            <p
              id="task-board-association-description"
              className="mt-2 pr-12 text-sm text-text-muted md:pr-9"
            >
              {t('workbench.task_board_association_description')}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="task-board-association-close"
              disabled={pending}
              onClick={onClose}
              aria-label={t('workbench.close', '关闭')}
              className="absolute right-4 top-4 h-11 w-11 rounded-lg text-text-muted md:h-8 md:w-8"
            >
              <X aria-hidden="true" />
            </Button>
          </header>

          <div className="px-5 pb-3">
            <div className="mb-2 flex items-center justify-between gap-3 text-xs text-text-muted">
              <label htmlFor="task-board-association-search">
                {t('workbench.task_board_association_existing', '关联已有看板任务')}
              </label>
              {!loading && <span className="tabular-nums">{candidates.length}</span>}
            </div>
            <div className="flex h-11 items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 focus-within:border-focus md:h-10">
              <Search className="h-4 w-4 shrink-0 text-text-muted" aria-hidden="true" />
              <input
                id="task-board-association-search"
                data-testid="task-board-association-search"
                value={query}
                disabled={pending}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('workbench.task_board_association_search', '搜索任务编号或标题')}
                className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-text-muted disabled:opacity-45"
              />
            </div>
          </div>

          <div
            data-testid="task-board-association-list"
            aria-busy={loading}
            className="min-h-0 overflow-y-auto overscroll-contain px-3 pb-3 [scrollbar-gutter:stable]"
          >
            {loading ? (
              <div
                data-testid="task-board-association-loading"
                role="status"
                className="flex min-h-full flex-col items-center justify-center gap-3 px-5 py-8 text-center text-sm text-text-muted"
              >
                <Loader2
                  className="h-5 w-5 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
                <p>{t('workbench.task_board_association_loading', '正在加载看板任务…')}</p>
              </div>
            ) : candidates.length === 0 ? (
              <div
                data-testid="task-board-association-empty"
                role="status"
                className="flex min-h-full flex-col items-center justify-center gap-3 px-5 py-8 text-center text-sm text-text-muted"
              >
                <ListTodo className="h-6 w-6" aria-hidden="true" />
                <div>
                  <p className="text-text-secondary">
                    {query.trim()
                      ? t('workbench.task_board_association_no_results')
                      : t('workbench.task_board_association_empty', '没有可关联的看板任务')}
                  </p>
                  <p className="mt-1 text-xs">{t('workbench.task_board_association_empty_hint')}</p>
                </div>
              </div>
            ) : (
              candidates.map(item => (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`task-board-association-item-${item.id}`}
                  disabled={pending}
                  onClick={() => choose({ kind: 'existing', item })}
                  className="group flex w-full items-center gap-3 rounded-lg px-3 py-3 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus disabled:opacity-45"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-base">{item.title}</span>
                    <span className="mt-1 block truncate font-mono text-xs text-text-muted">
                      {item.id}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-text-muted">
                    {t(`workbench.cloud_todo_status_${item.status}`, item.status)}
                  </span>
                  <ChevronRight
                    className="h-4 w-4 shrink-0 text-text-muted opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"
                    aria-hidden="true"
                  />
                </button>
              ))
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-muted/20 px-5 py-4">
            <p className="min-w-0 flex-1 text-xs text-text-muted">
              {t('workbench.task_board_association_create_description')}
            </p>
            <Button
              type="button"
              size="sm"
              data-testid="task-board-association-create"
              disabled={pending}
              onClick={() => choose({ kind: 'create' })}
              className="h-11 rounded-lg md:h-9"
            >
              <Plus aria-hidden="true" />
              {t('workbench.task_board_association_create', '新建看板任务')}
            </Button>
          </footer>
        </section>
      </div>

      <ConfirmDialog
        open={Boolean(moveChoice)}
        title={t('workbench.task_board_move_title', '移动任务关联')}
        description={t('workbench.task_board_move_description', {
          source: currentProject?.name ?? '',
          target: project.name,
        })}
        cancelLabel={t('common.cancel', '取消')}
        confirmLabel={t('workbench.task_board_move_confirm', '移动')}
        confirmTestId="task-board-move-confirm"
        pending={pending}
        onClose={() => setMoveChoice(null)}
        onConfirm={() => {
          if (!moveChoice) return
          const choice = moveChoice
          setMoveChoice(null)
          execute(choice)
        }}
      />
    </>
  )
}
