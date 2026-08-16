import { ArrowUpRight, Circle, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectSpaceApi } from '@/features/todo/projectSpaceSelection'
import { useTranslation } from '@/hooks/useTranslation'
import type { RuntimeTaskAddress } from '@/types/api'
import { cn } from '@/lib/utils'

interface WorkItemContextPanelProps {
  api: ProjectSpaceApi
  project: CloudProject
  item: CloudLoopItem
  currentTask: RuntimeTaskAddress
  onOpenBoard: () => void
  onOpenTask: (address: RuntimeTaskAddress) => Promise<void> | void
}

const statusLabelKeys: Record<CloudLoopItem['status'], string> = {
  inbox: 'workbench.work_item_status_inbox',
  pending: 'workbench.work_item_status_pending',
  in_progress: 'workbench.work_item_status_in_progress',
  in_review: 'workbench.work_item_status_in_review',
  completed: 'workbench.work_item_status_completed',
}

interface WorkItemTaskExecution {
  id: number
  title: string
  linkedAt: string
  address: RuntimeTaskAddress
}

function bindingExecution(
  binding: Awaited<ReturnType<ProjectSpaceApi['listTaskBindings']>>[number]
) {
  return {
    id: binding.id,
    title: binding.task_title ?? '',
    linkedAt: binding.linked_at,
    address: {
      deviceId: binding.device_id,
      taskId: binding.task_id,
    },
  }
}

export function WorkItemContextPanel({
  api,
  project,
  item,
  currentTask,
  onOpenBoard,
  onOpenTask,
}: WorkItemContextPanelProps) {
  const { t } = useTranslation('common')
  const [executions, setExecutions] = useState<WorkItemTaskExecution[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void api
      .listTaskBindings(item.id)
      .then(bindings => {
        if (!active) return
        setExecutions(
          bindings
            .map(bindingExecution)
            .sort((left, right) => right.linkedAt.localeCompare(left.linkedAt))
        )
      })
      .catch(cause => {
        if (!active) return
        setError(
          cause instanceof Error
            ? cause.message
            : t('workbench.work_item_executions_load_failed', '加载任务执行记录失败')
        )
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [api, item.id, project.id, t])

  const currentExecutionId = useMemo(
    () =>
      executions.find(
        execution =>
          execution.address.deviceId === currentTask.deviceId &&
          execution.address.taskId === currentTask.taskId
      )?.id ?? null,
    [currentTask.deviceId, currentTask.taskId, executions]
  )
  const priorityLabel = {
    none: t('todo.status_history_unset', '未设置'),
    low: t('todo.priority_low', '低'),
    medium: t('todo.priority_normal', '普通'),
    high: t('todo.priority_high', '高'),
    urgent: t('todo.priority_urgent', '紧急'),
  }[item.priority]

  return (
    <section
      data-testid="work-item-context-panel"
      className="flex min-h-0 flex-1 flex-col bg-background"
    >
      <header className="flex min-h-14 shrink-0 items-center border-b border-border px-4 py-2">
        <div className="min-w-0">
          <div className="text-xs text-text-muted">{t('workbench.work_item', '工作空间')}</div>
          <div className="truncate text-sm font-semibold text-text-primary">
            {item.id} · {item.title}
          </div>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <dl className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-3 gap-y-3 text-sm">
          <dt className="text-text-muted">{t('workbench.status', '状态')}</dt>
          <dd className="font-medium text-text-primary">
            {t(statusLabelKeys[item.status] ?? '', item.status)}
          </dd>
          <dt className="text-text-muted">{t('workbench.project', '项目')}</dt>
          <dd className="truncate font-medium text-text-primary">{project.name}</dd>
          <dt className="text-text-muted">{t('workbench.priority', '优先级')}</dt>
          <dd className="font-medium text-text-primary">{priorityLabel}</dd>
        </dl>

        {item.description ? (
          <section className="mt-5">
            <h3 className="text-xs font-semibold text-text-muted">
              {t('workbench.description', '描述')}
            </h3>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-6 text-text-secondary">
              {item.description}
            </p>
          </section>
        ) : null}

        <section className="mt-6">
          <h3 className="text-xs font-semibold text-text-muted">
            {t('workbench.task_executions', '任务执行')}
          </h3>
          <div className="mt-2 space-y-1.5">
            {loading ? (
              <div
                data-testid="work-item-executions-loading"
                className="flex h-20 items-center justify-center text-text-muted"
              >
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : error ? (
              <p data-testid="work-item-executions-error" className="text-sm text-red-500">
                {error}
              </p>
            ) : executions.length === 0 ? (
              <p className="py-4 text-sm text-text-muted">
                {t('workbench.no_task_executions', '暂无任务执行记录')}
              </p>
            ) : (
              executions.map(execution => {
                const address = execution.address
                const current = execution.id === currentExecutionId
                return (
                  <button
                    key={execution.id}
                    type="button"
                    data-testid={`work-item-execution-${execution.id}`}
                    onClick={() => {
                      setError(null)
                      void Promise.resolve(onOpenTask(address)).catch(cause => {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : t('workbench.work_item_execution_open_failed', '打开任务执行失败')
                        )
                      })
                    }}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left',
                      current ? 'border-primary/40 bg-primary/5' : 'border-border hover:bg-muted/60'
                    )}
                  >
                    <Circle className="h-4 w-4 shrink-0 text-primary" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-text-primary">
                        {execution.title || t('workbench.untitled_task', '未命名任务')}
                      </span>
                      <span className="block truncate text-xs text-text-muted">
                        {t('workbench.task_execution', '任务执行')}
                        {current ? ` · ${t('workbench.current', '当前')}` : ''}
                      </span>
                    </span>
                    <ArrowUpRight className="h-4 w-4 shrink-0 text-text-muted" />
                  </button>
                )
              })
            )}
          </div>
        </section>
      </div>

      <footer className="shrink-0 border-t border-border p-3">
        <button
          type="button"
          data-testid="work-item-open-board"
          onClick={onOpenBoard}
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {t('workbench.open_in_work_item_board', '在工作空间中查看')}
          <ArrowUpRight className="h-4 w-4" />
        </button>
      </footer>
    </section>
  )
}
