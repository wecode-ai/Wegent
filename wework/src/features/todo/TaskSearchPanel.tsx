import type { CloudLoopItem, CloudProjectMember } from '@/api/deliveries'
import { cn } from '@/lib/utils'
import {
  SelectContent,
  SelectItem,
  SelectRoot,
  SelectTrigger,
} from '@wegent/collaboration/controls/SelectParts'
import { normalizeSelectValue } from '@wegent/collaboration/controls/selectValue'
import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { Search, X } from 'lucide-react'
import {
  emptyTaskSearchFilters,
  hasTaskSearchFilters,
  searchTasks,
  type TaskSearchFilters,
} from './taskSearch'
import { columns, priorityBadgeClasses } from './todoShared'

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
      className="electron-titlebar-interactive-region absolute right-6 top-12 z-30 w-[560px] max-w-[calc(100vw-48px)] rounded-xl border border-border bg-background p-3 shadow-xl"
    >
      <div className="relative">
        <Search className="absolute left-3 top-2.5 h-4 w-4 text-text-muted" />
        <ControlInput
          autoFocus
          data-testid="cloud-project-task-search-input"
          value={query}
          onChange={event => onQueryChange(event.target.value)}
          placeholder="搜索任务编号、标题、内容、标签或成员"
          className="h-9 w-full pl-9 pr-9 focus:border-text-muted"
        />
        {active && (
          <ControlButton
            variant="unstyled"
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
          </ControlButton>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <SelectRoot
          value={normalizeSelectValue(filters.status ?? '')}
          onValueChange={selectedValue => {
            if (selectedValue !== null)
              return onFiltersChange({
                ...filters,
                status: (selectedValue || null) as CloudLoopItem['status'] | null,
              })
          }}
        >
          <SelectTrigger
            density="compact"
            data-testid="cloud-task-filter-status"
            className="text-xs text-text-secondary focus:border-text-muted"
            aria-label="按状态筛选"
          />
          <SelectContent>
            <SelectItem value="">全部状态</SelectItem>
            {columns.map(column => (
              <SelectItem key={column.status} value={String(column.status)}>
                {column.label}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        <SelectRoot
          value={normalizeSelectValue(filters.priority ?? '')}
          onValueChange={selectedValue => {
            if (selectedValue !== null)
              return onFiltersChange({
                ...filters,
                priority: (selectedValue || null) as CloudLoopItem['priority'] | null,
              })
          }}
        >
          <SelectTrigger
            density="compact"
            data-testid="cloud-task-filter-priority"
            className="text-xs text-text-secondary focus:border-text-muted"
            aria-label="按优先级筛选"
          />
          <SelectContent>
            <SelectItem value="">全部优先级</SelectItem>
            <SelectItem value="none">普通</SelectItem>
            <SelectItem value="low">低</SelectItem>
            <SelectItem value="medium">中</SelectItem>
            <SelectItem value="high">高</SelectItem>
            <SelectItem value="urgent">紧急</SelectItem>
          </SelectContent>
        </SelectRoot>
        <SelectRoot
          value={normalizeSelectValue(filters.tag ?? '')}
          onValueChange={selectedValue => {
            if (selectedValue !== null)
              return onFiltersChange({ ...filters, tag: selectedValue || null })
          }}
        >
          <SelectTrigger
            density="compact"
            data-testid="cloud-task-filter-tag"
            className="text-xs text-text-secondary focus:border-text-muted"
            aria-label="按标签筛选"
          />
          <SelectContent>
            <SelectItem value="">全部标签</SelectItem>
            {tags.map(tag => (
              <SelectItem key={tag} value={String(tag)}>
                {tag}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        <SelectRoot
          value={normalizeSelectValue(filters.assigneeUserId ?? '')}
          onValueChange={selectedValue => {
            if (selectedValue !== null)
              return onFiltersChange({
                ...filters,
                assigneeUserId: selectedValue ? Number(selectedValue) : null,
              })
          }}
        >
          <SelectTrigger
            density="compact"
            data-testid="cloud-task-filter-assignee"
            className="text-xs text-text-secondary focus:border-text-muted"
            aria-label="按负责人筛选"
          />
          <SelectContent>
            <SelectItem value="">全部负责人</SelectItem>
            {members.map(member => (
              <SelectItem key={member.user_id} value={String(member.user_id)}>
                {member.user_name}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        <SelectRoot
          value={normalizeSelectValue(filters.creatorUserId ?? '')}
          onValueChange={selectedValue => {
            if (selectedValue !== null)
              return onFiltersChange({
                ...filters,
                creatorUserId: selectedValue ? Number(selectedValue) : null,
              })
          }}
        >
          <SelectTrigger
            density="compact"
            data-testid="cloud-task-filter-creator"
            className="text-xs text-text-secondary focus:border-text-muted"
            aria-label="按创建人筛选"
          />
          <SelectContent>
            <SelectItem value="">全部创建人</SelectItem>
            {members.map(member => (
              <SelectItem key={member.user_id} value={String(member.user_id)}>
                {member.user_name}
              </SelectItem>
            ))}
          </SelectContent>
        </SelectRoot>
        <SelectRoot
          value={normalizeSelectValue(filters.due)}
          onValueChange={selectedValue => {
            if (selectedValue !== null)
              return onFiltersChange({ ...filters, due: selectedValue as TaskSearchFilters['due'] })
          }}
        >
          <SelectTrigger
            density="compact"
            data-testid="cloud-task-filter-due"
            className="text-xs text-text-secondary focus:border-text-muted"
            aria-label="按截止时间筛选"
          />
          <SelectContent>
            <SelectItem value="any">全部截止时间</SelectItem>
            <SelectItem value="with_due_date">有截止时间</SelectItem>
            <SelectItem value="overdue">已逾期</SelectItem>
            <SelectItem value="no_due_date">无截止时间</SelectItem>
          </SelectContent>
        </SelectRoot>
        <SelectRoot
          value={normalizeSelectValue(filters.children)}
          onValueChange={selectedValue => {
            if (selectedValue !== null)
              return onFiltersChange({
                ...filters,
                children: selectedValue as TaskSearchFilters['children'],
              })
          }}
        >
          <SelectTrigger
            density="compact"
            data-testid="cloud-task-filter-children"
            className="text-xs text-text-secondary focus:border-text-muted"
            aria-label="按子任务筛选"
          />
          <SelectContent>
            <SelectItem value="any">全部任务层级</SelectItem>
            <SelectItem value="with_children">有子任务</SelectItem>
            <SelectItem value="without_children">无子任务</SelectItem>
          </SelectContent>
        </SelectRoot>
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
              <ControlButton
                variant="unstyled"
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
              </ControlButton>
            ))}
          </>
        )}
      </div>
    </div>
  )
}
