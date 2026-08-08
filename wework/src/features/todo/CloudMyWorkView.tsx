import { useMemo, useState } from 'react'
import { CalendarDays, Clock, LayoutGrid, List } from 'lucide-react'
import type { CloudMyWorkItem } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { CloudMyWorkCalendar } from './CloudMyWorkCalendar'
import { myWorkGroupOf, type MyWorkGroupKey } from './cloudMyWorkModel'

export type MyWorkView = 'group' | 'list' | 'calendar' | 'timeline'

interface CloudMyWorkViewProps {
  items: CloudMyWorkItem[]
  onSelectItem: (item: CloudMyWorkItem) => void
  onApproveItem?: (item: CloudMyWorkItem) => void | Promise<void>
}

const GROUP_ORDER: MyWorkGroupKey[] = ['approval', 'action', 'running', 'review', 'done']

const GROUP_META: Record<MyWorkGroupKey, { dotClass: string; labelKey: string; fallback: string }> =
  {
    approval: {
      dotClass: 'bg-amber-500',
      labelKey: 'workbench.my_work_pending_approval',
      fallback: '待我批准',
    },
    action: {
      dotClass: 'bg-indigo-500',
      labelKey: 'todo.needs_my_action',
      fallback: '需要我处理',
    },
    running: {
      dotClass: 'bg-amber-500',
      labelKey: 'todo.my_work_running',
      fallback: '正在执行',
    },
    review: {
      dotClass: 'bg-violet-500',
      labelKey: 'todo.waiting_confirmation',
      fallback: '等待确认',
    },
    done: {
      dotClass: 'bg-emerald-500',
      labelKey: 'todo.state_completed',
      fallback: '已完成',
    },
  }

// Grouped view filters replicate the original my-work grouping semantics; an
// item may appear in more than one group (e.g. in-review without an active
// task shows under both "需要我处理" and "等待确认").
const GROUP_FILTERS: Record<MyWorkGroupKey, (item: CloudMyWorkItem) => boolean> = {
  approval: item => item.execution_state === 'pending_approval' && item.can_approve === true,
  action: item =>
    !item.has_active_task &&
    item.status !== 'completed' &&
    !(item.execution_state === 'pending_approval' && item.can_approve === true),
  running: item => item.has_active_task && item.status === 'in_progress',
  review: item => item.status === 'in_review',
  done: item => item.status === 'completed',
}

const PRIORITY_ORDER: Record<CloudMyWorkItem['priority'], number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
}

const PRIORITY_LABEL_KEYS: Record<CloudMyWorkItem['priority'], [string, string]> = {
  urgent: ['todo.priority_urgent', '紧急'],
  high: ['todo.priority_high', '高'],
  medium: ['todo.priority_normal', '普通'],
  low: ['todo.priority_low', '低'],
  none: ['todo.priority_none_short', '无'],
}

function startOfDay(date: Date): Date {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  return copy
}

function dueDayOf(item: CloudMyWorkItem): Date | null {
  if (!item.due_at) return null
  const parsed = new Date(item.due_at)
  return Number.isNaN(parsed.getTime()) ? null : startOfDay(parsed)
}

function dayDiffFromToday(day: Date): number {
  const today = startOfDay(new Date())
  return Math.round((day.getTime() - today.getTime()) / 86400000)
}

function compareItems(a: CloudMyWorkItem, b: CloudMyWorkItem): number {
  const dayA = dueDayOf(a)
  const dayB = dueDayOf(b)
  if (dayA && dayB && dayA.getTime() !== dayB.getTime()) return dayA.getTime() - dayB.getTime()
  if (dayA && !dayB) return -1
  if (!dayA && dayB) return 1
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]
}

interface GroupSectionProps {
  groupKey: MyWorkGroupKey
  items: CloudMyWorkItem[]
  onSelectItem: (item: CloudMyWorkItem) => void
  onApproveItem?: (item: CloudMyWorkItem) => void | Promise<void>
}

function GroupSection({ groupKey, items, onSelectItem, onApproveItem }: GroupSectionProps) {
  const { t } = useTranslation('common')
  const meta = GROUP_META[groupKey]
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm">
      <header className="flex items-center gap-2 border-b border-border px-4 py-3">
        <span className={cn('h-2 w-2 rounded-full', meta.dotClass)} />
        <h2 className="text-sm font-semibold">{t(meta.labelKey, meta.fallback)}</h2>
        <span className="text-xs text-text-muted">{items.length}</span>
      </header>
      <div className="divide-y divide-border">
        {items.map(item => (
          <div
            key={item.id}
            data-testid={`my-work-group-${groupKey}-${item.id}`}
            onClick={() => onSelectItem(item)}
            className="group relative flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 transition-colors hover:bg-muted/60"
          >
            <span className="shrink-0 font-mono text-xs text-text-muted">{item.id}</span>
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{item.title}</span>
            <span className="shrink-0 text-xs text-text-muted transition-opacity group-hover:opacity-0">
              {item.project_name}
            </span>
            {groupKey === 'approval' && onApproveItem ? (
              <button
                type="button"
                data-testid={`my-work-approve-${item.id}`}
                onClick={event => {
                  event.stopPropagation()
                  void onApproveItem(item)
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-lg bg-text-primary px-2.5 py-1 text-xs font-medium text-background opacity-0 transition-opacity group-hover:opacity-100 hover:opacity-90 focus-visible:opacity-100"
              >
                {t('workbench.my_work_approve', '批准')}
              </button>
            ) : null}
          </div>
        ))}
      </div>
    </section>
  )
}

function ListView({
  items,
  onSelectItem,
}: { items: CloudMyWorkItem[] } & Pick<CloudMyWorkViewProps, 'onSelectItem'>) {
  const { t, i18n } = useTranslation('common')
  const sorted = useMemo(() => [...items].sort(compareItems), [items])
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(i18n.language, { month: 'short', day: 'numeric' }),
    [i18n.language]
  )
  return (
    <div
      data-testid="my-work-list"
      className="overflow-hidden rounded-2xl border border-border bg-background shadow-sm"
    >
      <div className="grid grid-cols-[minmax(0,1fr)_110px_120px_80px_90px] items-center gap-3 border-b border-border bg-muted/30 px-4 py-2 text-xs text-text-muted">
        <span>{t('todo.my_work_col_task', '任务')}</span>
        <span>{t('todo.my_work_col_project', '项目')}</span>
        <span>{t('todo.status', '状态')}</span>
        <span>{t('todo.priority', '优先级')}</span>
        <span>{t('todo.my_work_col_due', '截止日期')}</span>
      </div>
      <div className="divide-y divide-border">
        {sorted.map(item => {
          const group = myWorkGroupOf(item)
          const due = dueDayOf(item)
          const [priorityKey, priorityFallback] = PRIORITY_LABEL_KEYS[item.priority]
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`my-work-list-row-${item.id}`}
              onClick={() => onSelectItem(item)}
              className="grid w-full grid-cols-[minmax(0,1fr)_110px_120px_80px_90px] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-muted/60"
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <span className="shrink-0 font-mono text-xs text-text-muted">{item.id}</span>
                <span className="min-w-0 truncate text-sm font-medium">{item.title}</span>
              </span>
              <span className="truncate text-xs text-text-muted">{item.project_name}</span>
              <span className="flex items-center gap-1.5 text-xs text-text-secondary">
                <span
                  className={cn('h-1.5 w-1.5 shrink-0 rounded-full', GROUP_META[group].dotClass)}
                />
                {t(GROUP_META[group].labelKey, GROUP_META[group].fallback)}
              </span>
              <span
                className={cn(
                  'text-xs',
                  item.priority === 'urgent' || item.priority === 'high'
                    ? 'font-medium text-destructive'
                    : 'text-text-secondary'
                )}
              >
                {t(priorityKey, priorityFallback)}
              </span>
              <span className="text-xs text-text-muted">
                {due ? dateFormatter.format(due) : '—'}
              </span>
            </button>
          )
        })}
      </div>
      {sorted.length === 0 && (
        <p className="px-4 py-8 text-center text-xs text-text-muted">
          {t('todo.no_items_in_group', '当前没有事项')}
        </p>
      )}
    </div>
  )
}

function TimelineView({
  items,
  onSelectItem,
}: { items: CloudMyWorkItem[] } & Pick<CloudMyWorkViewProps, 'onSelectItem'>) {
  const { t, i18n } = useTranslation('common')
  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        month: 'short',
        day: 'numeric',
        weekday: 'short',
      }),
    [i18n.language]
  )
  const days = useMemo(() => {
    const byDay = new Map<string, { day: Date | null; entries: CloudMyWorkItem[] }>()
    for (const item of [...items].sort(compareItems)) {
      const day = dueDayOf(item)
      const key = day ? String(day.getTime()) : 'none'
      const bucket = byDay.get(key) ?? { day, entries: [] }
      bucket.entries.push(item)
      byDay.set(key, bucket)
    }
    return [...byDay.entries()]
      .sort(([keyA], [keyB]) => {
        if (keyA === 'none') return 1
        if (keyB === 'none') return -1
        return Number(keyA) - Number(keyB)
      })
      .map(([, bucket]) => bucket)
  }, [items])

  function dayLabel(day: Date): string {
    const diff = dayDiffFromToday(day)
    const relative =
      diff === 0
        ? t('todo.my_work_today', '今天')
        : diff === 1
          ? t('todo.my_work_tomorrow', '明天')
          : diff === -1
            ? t('todo.my_work_yesterday', '昨天')
            : null
    const formatted = dateFormatter.format(day)
    return relative ? `${relative} · ${formatted}` : formatted
  }

  return (
    <div data-testid="my-work-timeline">
      {days.map((bucket, index) => (
        <div key={bucket.day ? bucket.day.getTime() : 'none'} className="relative pl-6 pb-6">
          {index < days.length - 1 && (
            <span className="absolute bottom-0 left-[5px] top-6 w-px bg-border" aria-hidden />
          )}
          <h3 className="mb-2 text-sm font-semibold">
            {bucket.day ? dayLabel(bucket.day) : t('todo.my_work_no_due_date', '无截止日期')}
          </h3>
          <div className="space-y-2">
            {bucket.entries.map(item => {
              const group = myWorkGroupOf(item)
              const [priorityKey, priorityFallback] = PRIORITY_LABEL_KEYS[item.priority]
              return (
                <div key={item.id} className="relative">
                  <span
                    aria-hidden
                    className={cn(
                      'absolute -left-6 top-4 h-2 w-2 rounded-full ring-2 ring-background',
                      GROUP_META[group].dotClass
                    )}
                  />
                  <button
                    type="button"
                    data-testid={`my-work-timeline-item-${item.id}`}
                    onClick={() => onSelectItem(item)}
                    className="w-full rounded-xl border border-border bg-background px-4 py-2.5 text-left shadow-sm transition-colors hover:bg-muted/60"
                  >
                    <span className="flex min-w-0 items-center gap-2.5">
                      <span className="shrink-0 font-mono text-xs text-text-muted">{item.id}</span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-xs text-text-secondary">
                        {t(priorityKey, priorityFallback)}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-text-muted">
                      {item.project_name} ·{' '}
                      {t(GROUP_META[group].labelKey, GROUP_META[group].fallback)}
                    </span>
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      ))}
      {days.length === 0 && (
        <p className="px-2 py-8 text-center text-xs text-text-muted">
          {t('todo.no_items_in_group', '当前没有事项')}
        </p>
      )}
    </div>
  )
}

const VIEW_TABS: Array<{
  key: MyWorkView
  icon: typeof LayoutGrid
  labelKey: string
  fallback: string
}> = [
  { key: 'group', icon: LayoutGrid, labelKey: 'todo.my_work_view_group', fallback: '分组' },
  { key: 'list', icon: List, labelKey: 'todo.my_work_view_list', fallback: '列表' },
  { key: 'calendar', icon: CalendarDays, labelKey: 'todo.my_work_view_calendar', fallback: '日历' },
  { key: 'timeline', icon: Clock, labelKey: 'todo.my_work_view_timeline', fallback: '时间线' },
]

export function CloudMyWorkView({ items, onSelectItem, onApproveItem }: CloudMyWorkViewProps) {
  const { t } = useTranslation('common')
  const [view, setView] = useState<MyWorkView>('group')

  return (
    <div className="relative min-h-0 flex-1" data-testid="cloud-my-work-view">
      <div className="h-full overflow-y-auto px-8 pb-24 pt-7">
        <div className="mx-auto max-w-[960px]">
          <h1 className="text-heading-md font-semibold">{t('todo.my_work', '我的工作')}</h1>
          <p className="mt-1 text-sm text-text-muted">
            {t('todo.my_work_subtitle', '跨项目空间查看需要你处理的任务和本地执行。')}
          </p>
          <div className="mt-6">
            {view === 'group' && (
              <div className="grid grid-cols-2 gap-4" data-testid="my-work-groups">
                {GROUP_ORDER.map(groupKey => (
                  <GroupSection
                    key={groupKey}
                    groupKey={groupKey}
                    items={items.filter(GROUP_FILTERS[groupKey])}
                    onSelectItem={onSelectItem}
                    onApproveItem={onApproveItem}
                  />
                ))}
              </div>
            )}
            {view === 'list' && <ListView items={items} onSelectItem={onSelectItem} />}
            {view === 'calendar' && (
              <CloudMyWorkCalendar items={items} onSelectItem={onSelectItem} />
            )}
            {view === 'timeline' && <TimelineView items={items} onSelectItem={onSelectItem} />}
          </div>
          <p className="mt-5 text-xs text-text-muted">
            {t(
              'todo.my_work_scope_note',
              '这里只汇总与你相关的项目任务；未关联任务的普通本地会话不会出现。'
            )}
          </p>
        </div>
      </div>

      <div className="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center">
        <div
          role="tablist"
          aria-label={t('todo.my_work_view_switcher', '视图切换')}
          className="pointer-events-auto flex gap-0.5 rounded-xl border border-border bg-background p-1 shadow-lg"
        >
          {VIEW_TABS.map(tab => {
            const Icon = tab.icon
            const active = view === tab.key
            return (
              <button
                key={tab.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-testid={`my-work-view-tab-${tab.key}`}
                onClick={() => setView(tab.key)}
                className={cn(
                  'flex h-8 items-center gap-1.5 rounded-lg px-3 text-sm font-medium transition-colors',
                  active
                    ? 'bg-text-primary text-background'
                    : 'text-text-secondary hover:bg-muted/60 hover:text-text-primary'
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {t(tab.labelKey, tab.fallback)}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}
