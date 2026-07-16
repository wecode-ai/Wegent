import { Bot, CircleAlert, CircleCheck, UserRound } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import type { TodoDetailItem } from './TodoDetailPanel'

interface TodoMyWorkProps {
  items: TodoDetailItem[]
  onSelectItem: (item: TodoDetailItem) => void
}

interface MyWorkEntry {
  item: TodoDetailItem
  parent?: TodoDetailItem
}

export function TodoMyWork({ items, onSelectItem }: TodoMyWorkProps) {
  const { t } = useTranslation('common')
  const entries: MyWorkEntry[] = items.flatMap(parent => [
    { item: parent },
    ...(parent.children ?? []).map(item => ({ item, parent })),
  ])
  const groups = [
    {
      key: 'action',
      label: t('todo.needs_my_action', '需要我处理'),
      icon: UserRound,
      entries: entries.filter(
        ({ item }) => item.assigneeType === 'human' && !['review', 'completed'].includes(item.state)
      ),
    },
    {
      key: 'ai',
      label: t('todo.ai_running', 'AI 正在执行'),
      icon: Bot,
      entries: entries.filter(({ item }) => item.assigneeType === 'ai' && item.state === 'started'),
    },
    {
      key: 'review',
      label: t('todo.waiting_confirmation', '等待确认'),
      icon: CircleCheck,
      entries: entries.filter(({ item }) => item.state === 'review'),
    },
    {
      key: 'blocked',
      label: t('todo.blocked_items', '被阻塞'),
      icon: CircleAlert,
      entries: entries.filter(
        ({ item }) => Boolean(item.blocker) || Boolean(item.waitingFor?.length)
      ),
    },
  ]

  return (
    <div data-testid="todo-my-work" className="min-h-0 flex-1 overflow-auto bg-base p-3">
      <div className="mx-auto grid max-w-[1080px] gap-3 lg:grid-cols-2">
        {groups.map(group => {
          const Icon = group.icon
          return (
            <section
              key={group.key}
              className="overflow-hidden rounded-lg border border-border bg-surface"
            >
              <header className="flex h-10 items-center gap-2 border-b border-border px-3">
                <Icon className="h-3.5 w-3.5 text-text-muted" />
                <h2 className="text-[12px] font-semibold text-text-primary">{group.label}</h2>
                <span className="ml-auto font-mono text-[10px] text-text-muted">
                  {group.entries.length}
                </span>
              </header>
              {group.entries.length === 0 ? (
                <p className="px-3 py-5 text-[10px] text-text-muted">
                  {t('todo.no_items_in_group', '当前没有事项')}
                </p>
              ) : (
                <div className="divide-y divide-border">
                  {group.entries.map(({ item, parent }) => (
                    <button
                      key={`${group.key}-${item.id}`}
                      type="button"
                      data-testid={`todo-my-work-${group.key}-${item.id}`}
                      onClick={() => onSelectItem(item)}
                      className="flex min-h-14 w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted/50"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[11px] font-medium text-text-primary">
                          {item.title}
                        </p>
                        <p className="mt-0.5 truncate text-[9px] text-text-muted">
                          {parent
                            ? `${t('todo.belongs_to', '属于')}：${parent.title}`
                            : item.nextAction || item.objective || item.code}
                        </p>
                      </div>
                      {item.blocker && (
                        <span className="max-w-36 truncate text-[9px] text-destructive">
                          {item.blocker}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}
