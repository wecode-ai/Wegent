import { Search, X } from 'lucide-react'
import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { cn } from '@/lib/utils'
import { columns, priorityBadgeClasses } from './todoShared'
import {
  emptyTaskSearchFilters,
  hasTaskSearchFilters,
  searchTasks,
  type TaskSearchFilters,
} from './taskSearch'

interface TaskSearchPanelProps {
  items: CloudLoopItem[]
  members: CloudProjectMember[]
  query: string
  filters: TaskSearchFilters
  tags: string[]
  onQueryChange: (query: string) => void
  onFiltersChange: (filters: TaskSearchFilters) => void
  onSelect: (item: CloudLoopItem) => void
}

const selectClass =
  'h-8 rounded-lg border border-border bg-background px-2 text-xs text-text-secondary outline-none focus:border-text-muted'

export function TaskSearchPanel({
  items,
  members,
  query,
  filters,
  tags,
  onQueryChange,
  onFiltersChange,
  onSelect,
}: TaskSearchPanelProps) {
  const results = searchTasks(items, query, filters, members)
  const active = Boolean(query.trim()) || hasTaskSearchFilters(filters)

  return (
    <div
      data-testid="cloud-project-task-search-panel"
      className="absolute right-6 top-12 z-30 w-[560px] max-w-[calc(100vw-48px)] rounded-xl border border-border bg-background p-3 shadow-xl"
    >
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
        <input
          autoFocus
          data-testid="cloud-project-task-search-input"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="搜索任务编号、标题、内容、标签或成员"
          className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-9 text-sm outline-none focus:border-text-muted"
        />
        {active && (
          <button
            type="button"
            data-testid="cloud-project-task-search-clear"
            onClick={() => {
              onQueryChange('')
              onFiltersChange(emptyTaskSearchFilters)
            }}
            className="absolute right-2 top-1.5 flex h-6 w-6 items-center justify-center rounded-md text-text-muted hover:bg-muted"
            aria-label="清除搜索"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <select
          data-testid="cloud-task-filter-status"
          value={filters.status ?? ''}
          onChange={event =>
            onFiltersChange({
              ...filters,
              status: (event.target.value || null) as CloudLoopItem['status'] | null,
            })
          }
          className={selectClass}
          aria-label="按状态筛选"
        >
          <option value="">全部状态</option>
          {columns.map(column => (
            <option key={column.status} value={column.status}>
              {column.label}
            </option>
          ))}
        </select>
        <select
          data-testid="cloud-task-filter-priority"
          value={filters.priority ?? ''}
          onChange={event =>
            onFiltersChange({
              ...filters,
              priority: (event.target.value || null) as CloudLoopItem['priority'] | null,
            })
          }
          className={selectClass}
          aria-label="按优先级筛选"
        >
          <option value="">全部优先级</option>
          <option value="none">普通</option>
          <option value="low">低</option>
          <option value="medium">中</option>
          <option value="high">高</option>
          <option value="urgent">紧急</option>
        </select>
        <select
          data-testid="cloud-task-filter-tag"
          value={filters.tag ?? ''}
          onChange={event => onFiltersChange({ ...filters, tag: event.target.value || null })}
          className={selectClass}
          aria-label="按标签筛选"
        >
          <option value="">全部标签</option>
          {tags.map(tag => (
            <option key={tag} value={tag}>
              {tag}
            </option>
          ))}
        </select>
        <select
          data-testid="cloud-task-filter-assignee"
          value={filters.assigneeUserId ?? ''}
          onChange={event =>
            onFiltersChange({
              ...filters,
              assigneeUserId: event.target.value ? Number(event.target.value) : null,
            })
          }
          className={selectClass}
          aria-label="按负责人筛选"
        >
          <option value="">全部负责人</option>
          {members.map(member => (
            <option key={member.user_id} value={member.user_id}>
              {member.user_name}
            </option>
          ))}
        </select>
        <select
          data-testid="cloud-task-filter-creator"
          value={filters.creatorUserId ?? ''}
          onChange={event =>
            onFiltersChange({
              ...filters,
              creatorUserId: event.target.value ? Number(event.target.value) : null,
            })
          }
          className={selectClass}
          aria-label="按创建人筛选"
        >
          <option value="">全部创建人</option>
          {members.map(member => (
            <option key={member.user_id} value={member.user_id}>
              {member.user_name}
            </option>
          ))}
        </select>
        <select
          data-testid="cloud-task-filter-due"
          value={filters.due}
          onChange={event =>
            onFiltersChange({ ...filters, due: event.target.value as TaskSearchFilters['due'] })
          }
          className={selectClass}
          aria-label="按截止时间筛选"
        >
          <option value="any">全部截止时间</option>
          <option value="with_due_date">有截止时间</option>
          <option value="overdue">已逾期</option>
          <option value="no_due_date">无截止时间</option>
        </select>
        <select
          data-testid="cloud-task-filter-children"
          value={filters.children}
          onChange={event =>
            onFiltersChange({
              ...filters,
              children: event.target.value as TaskSearchFilters['children'],
            })
          }
          className={selectClass}
          aria-label="按子任务筛选"
        >
          <option value="any">全部任务层级</option>
          <option value="with_children">有子任务</option>
          <option value="without_children">无子任务</option>
        </select>
      </div>
      <div className="mt-3 max-h-[420px] overflow-y-auto">
        {!active ? (
          <p className="px-3 py-8 text-center text-sm text-text-muted">输入关键词或选择筛选条件</p>
        ) : results.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-text-muted">没有匹配的任务</p>
        ) : (
          <>
            <p className="px-2 pb-1 text-xs text-text-muted">{results.length} 个结果</p>
            {results.map(({ item, parentPath }) => (
              <button
                key={item.id}
                type="button"
                data-testid={`cloud-task-search-result-${item.id}`}
                disabled={item.can_view_detail === false}
                onClick={() => onSelect(item)}
                className="flex w-full items-start gap-3 rounded-lg px-2 py-2.5 text-left hover:bg-muted/60 disabled:cursor-default disabled:opacity-60"
              >
                <span className="mt-0.5 shrink-0 font-mono text-xs text-text-muted">{item.id}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{item.title}</span>
                  <span className="mt-0.5 block truncate text-xs text-text-muted">
                    {item.can_view_detail === false
                      ? '仅创建人可查看详情'
                      : parentPath.length > 0
                        ? parentPath.join(' / ')
                        : '顶层任务'}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-text-muted">
                  {columns.find(column => column.status === item.status)?.label}
                </span>
                {item.priority !== 'none' && (
                  <span
                    className={cn(
                      'shrink-0 rounded-full px-1.5 py-0.5 text-xs',
                      priorityBadgeClasses[item.priority]
                    )}
                  >
                    {item.priority}
                  </span>
                )}
              </button>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
