import { ArrowRight, Bot, CheckCircle2, CircleDot, UserRound } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { User as UserProfile } from '@/types/api'
import type { TodoDetailItem, TodoViewState } from './TodoDetailPanel'

interface TodoOverviewProps {
  projectName: string
  items: TodoDetailItem[]
  user: UserProfile | null
  onOpenWorkItems: () => void
  onSelectItem: (item: TodoDetailItem) => void
}

const OVERVIEW_STATES: Array<{
  state: TodoViewState
  labelKey: string
  fallback: string
  color: string
}> = [
  { state: 'backlog', labelKey: 'todo.state_backlog', fallback: '待处理', color: '#858E97' },
  { state: 'started', labelKey: 'todo.state_started', fallback: '进行中', color: '#F59E0B' },
  { state: 'review', labelKey: 'todo.state_review', fallback: '待确认', color: '#8B5CF6' },
  {
    state: 'completed',
    labelKey: 'todo.state_completed',
    fallback: '已完成',
    color: '#10B981',
  },
]

function formatOverviewDate(value: string | number | null | undefined): string {
  if (value == null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date)
}

export function TodoOverview({
  projectName,
  items,
  user,
  onOpenWorkItems,
  onSelectItem,
}: TodoOverviewProps) {
  const { t } = useTranslation('common')
  const completedCount = items.filter(item => item.state === 'completed').length
  const completion = items.length === 0 ? 0 : Math.round((completedCount / items.length) * 100)
  const recentItems = [...items]
    .sort((left, right) => {
      const leftTime = new Date(left.updatedAt ?? left.createdAt ?? 0).getTime()
      const rightTime = new Date(right.updatedAt ?? right.createdAt ?? 0).getTime()
      return rightTime - leftTime
    })
    .slice(0, 5)
  const aiItemCount = items.filter(
    item => !item.assignee?.includes(t('todo.assignee_human', '员工'))
  ).length

  return (
    <div data-testid="todo-overview" className="min-h-0 flex-1 overflow-y-auto bg-base px-5 py-4">
      <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-4">
        <section className="flex min-h-[72px] items-center justify-between gap-6">
          <div className="min-w-0">
            <h1 className="heading-base truncate text-text-primary">{projectName}</h1>
            <p className="mt-1 text-xs text-text-muted">
              {t('todo.overview_description', '汇总当前项目的工作项状态，不改变原任务执行流程')}
            </p>
          </div>
          <div className="w-[260px] shrink-0">
            <div className="mb-2 flex items-center justify-between text-xs font-medium">
              <span className="text-text-secondary">{t('todo.overall_progress', '总体进度')}</span>
              <span className="font-mono text-primary">{completion}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-muted">
              <div
                data-testid="todo-overview-progress"
                className="h-full rounded-full bg-primary transition-[width] duration-200"
                style={{ width: `${completion}%` }}
              />
            </div>
          </div>
        </section>

        <section
          className="grid grid-cols-4 gap-2.5"
          aria-label={t('todo.project_metrics', '项目指标')}
        >
          {OVERVIEW_STATES.map(entry => {
            const count = items.filter(item => item.state === entry.state).length
            return (
              <article
                key={entry.state}
                data-testid={`todo-overview-metric-${entry.state}`}
                className="rounded-lg border border-border bg-surface p-3"
              >
                <div className="flex items-center gap-2 text-xs font-medium text-text-secondary">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  {t(entry.labelKey, entry.fallback)}
                </div>
                <div className="mt-2 text-heading-md font-medium text-text-primary">{count}</div>
                <div className="mt-1 text-xs text-text-muted">
                  {t('todo.work_item_count', { defaultValue: '{{count}} 个工作项', count })}
                </div>
              </article>
            )
          })}
        </section>

        <section className="grid min-h-[330px] grid-cols-[minmax(0,1fr)_320px] gap-3">
          <div className="overflow-hidden rounded-lg border border-border bg-surface">
            <header className="flex h-11 items-center justify-between border-b border-border px-3.5">
              <h2 className="text-xs font-semibold text-text-primary">
                {t('todo.recent_work_items', '最近工作项')}
              </h2>
              <button
                type="button"
                data-testid="todo-overview-open-work-items"
                onClick={onOpenWorkItems}
                className="flex h-8 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/10"
              >
                {t('todo.view_all', '查看全部')}
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </header>
            {recentItems.length === 0 ? (
              <div className="flex h-[260px] flex-col items-center justify-center text-center">
                <CircleDot className="h-5 w-5 text-text-muted" />
                <p className="mt-2 text-sm font-medium text-text-secondary">
                  {t('todo.no_work_items', '当前项目还没有工作项')}
                </p>
                <button
                  type="button"
                  data-testid="todo-overview-empty-open-work-items"
                  onClick={onOpenWorkItems}
                  className="mt-2 h-8 rounded-md px-2 text-xs font-medium text-primary hover:bg-primary/10"
                >
                  {t('todo.open_work_items', '打开 Work items')}
                </button>
              </div>
            ) : (
              <div>
                {recentItems.map(item => {
                  const state = OVERVIEW_STATES.find(entry => entry.state === item.state)!
                  return (
                    <button
                      key={item.id}
                      type="button"
                      data-testid={`todo-overview-item-${item.id}`}
                      onClick={() => onSelectItem(item)}
                      className="flex h-[52px] w-full items-center justify-between gap-4 border-b border-border px-3.5 text-left last:border-b-0 hover:bg-muted/60"
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <span className="shrink-0 font-mono text-xs text-text-muted">
                          {item.code}
                        </span>
                        <span className="truncate text-xs font-medium text-text-primary">
                          {item.title}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-3">
                        <span
                          className="flex items-center gap-1.5 text-xs font-medium"
                          style={{ color: state.color }}
                        >
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ backgroundColor: state.color }}
                          />
                          {t(state.labelKey, state.fallback)}
                        </span>
                        <span className="w-12 text-right text-xs text-text-muted">
                          {formatOverviewDate(item.updatedAt ?? item.createdAt)}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-3">
            <section className="rounded-lg border border-border bg-surface p-3.5">
              <h2 className="text-xs font-semibold text-text-primary">
                {t('todo.responsible_people', '负责人')}
              </h2>
              <div className="mt-3 space-y-3">
                <PersonRow
                  icon={UserRound}
                  name={user?.user_name || 'local'}
                  detail={t('todo.creator_manager', '创建者 · 管理者')}
                />
                <PersonRow
                  icon={Bot}
                  name={t('todo.assignee_ai', 'AI 智能体')}
                  detail={t('todo.ai_work_item_count', {
                    defaultValue: '执行 {{count}} 个工作项',
                    count: aiItemCount,
                  })}
                  accent
                />
              </div>
            </section>

            <section className="min-h-0 flex-1 rounded-lg border border-border bg-surface p-3.5">
              <h2 className="text-xs font-semibold text-text-primary">
                {t('todo.recent_activity', '最近运行动态')}
              </h2>
              <div className="mt-3 space-y-3">
                {recentItems.slice(0, 3).map(item => (
                  <div key={item.id} className="flex gap-2.5">
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-text-secondary">
                        {item.title}
                      </p>
                      <p className="mt-0.5 text-xs text-text-muted">
                        {formatOverviewDate(item.updatedAt ?? item.createdAt)}
                      </p>
                    </div>
                  </div>
                ))}
                {recentItems.length === 0 && (
                  <p className="text-xs text-text-muted">
                    {t('todo.no_recent_activity', '暂无运行动态')}
                  </p>
                )}
              </div>
            </section>
          </div>
        </section>
      </div>
    </div>
  )
}

function PersonRow({
  icon: Icon,
  name,
  detail,
  accent = false,
}: {
  icon: typeof UserRound
  name: string
  detail: string
  accent?: boolean
}) {
  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
          accent ? 'bg-primary/15 text-primary' : 'bg-muted text-text-secondary'
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-xs font-medium text-text-primary">{name}</span>
        <span className="block truncate text-xs text-text-muted">{detail}</span>
      </span>
    </div>
  )
}
