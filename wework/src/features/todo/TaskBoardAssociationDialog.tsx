import { LayoutDashboard, Plus, Search, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useEscapeKey } from '@/hooks/useEscapeKey'
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
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const previousFocusRef = useRef<HTMLElement | null>(null)
  const [query, setQuery] = useState('')
  const [moveChoice, setMoveChoice] = useState<AssociationChoice | null>(null)

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

  useEscapeKey(() => {
    if (!pending && !moveChoice) onClose()
  })

  useEffect(() => {
    if (!project) return
    previousFocusRef.current = document.activeElement as HTMLElement | null
    const frame = window.requestAnimationFrame(() => {
      dialogRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
    })
    return () => {
      window.cancelAnimationFrame(frame)
      previousFocusRef.current?.focus()
      previousFocusRef.current = null
    }
  }, [project])

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
          data-testid="task-board-association-dialog"
          className="flex max-h-[min(42rem,calc(100vh-3rem))] w-full max-w-[34rem] flex-col overflow-hidden rounded-2xl border border-border bg-popover text-text-primary shadow-xl"
        >
          <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
            <LayoutDashboard className="h-4 w-4 shrink-0 text-text-secondary" aria-hidden="true" />
            <h2
              id="task-board-association-title"
              className="min-w-0 flex-1 truncate text-base font-medium"
            >
              {t('workbench.task_board_association_title', { name: project.name })}
            </h2>
            <button
              type="button"
              data-testid="task-board-association-close"
              disabled={pending}
              onClick={onClose}
              aria-label={t('workbench.close', '关闭')}
              className="flex h-7 w-7 items-center justify-center rounded-lg text-text-muted hover:bg-muted hover:text-text-primary disabled:opacity-45"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="min-h-0 overflow-y-auto p-3">
            <button
              type="button"
              data-testid="task-board-association-create"
              disabled={pending}
              onClick={() => choose({ kind: 'create' })}
              className="flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left hover:bg-muted disabled:opacity-45"
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted text-text-secondary">
                <Plus className="h-4 w-4" />
              </span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">
                  {t('workbench.task_board_association_create', '新建看板任务')}
                </span>
                <span className="mt-0.5 block text-xs leading-5 text-text-muted">
                  {t(
                    'workbench.task_board_association_create_description',
                    '使用当前任务的标题和状态创建卡片并建立关联'
                  )}
                </span>
              </span>
            </button>

            <div className="my-2 border-t border-border" />
            <div className="px-2 pb-2 pt-1 text-xs font-medium text-text-muted">
              {t('workbench.task_board_association_existing', '关联已有看板任务')}
            </div>
            <div className="relative px-1">
              <Search className="absolute left-4 top-2.5 h-4 w-4 text-text-muted" />
              <input
                data-testid="task-board-association-search"
                value={query}
                disabled={pending}
                onChange={event => setQuery(event.target.value)}
                placeholder={t('workbench.task_board_association_search', '搜索任务编号或标题')}
                className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-sm outline-none focus:border-text-muted disabled:opacity-45"
              />
            </div>

            <div className="mt-2">
              {loading ? (
                <p
                  data-testid="task-board-association-loading"
                  className="px-3 py-8 text-center text-sm text-text-muted"
                >
                  {t('workbench.task_board_association_loading', '正在加载看板任务…')}
                </p>
              ) : candidates.length === 0 ? (
                <p
                  data-testid="task-board-association-empty"
                  className="px-3 py-8 text-center text-sm text-text-muted"
                >
                  {t('workbench.task_board_association_empty', '没有可关联的看板任务')}
                </p>
              ) : (
                candidates.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`task-board-association-item-${item.id}`}
                    disabled={pending}
                    onClick={() => choose({ kind: 'existing', item })}
                    className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted disabled:opacity-45"
                  >
                    <span className="w-28 shrink-0 truncate font-mono text-xs text-text-muted">
                      {item.id}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">{item.title}</span>
                    <span className="shrink-0 text-xs text-text-muted">
                      {t(`workbench.cloud_todo_status_${item.status}`, item.status)}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
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
