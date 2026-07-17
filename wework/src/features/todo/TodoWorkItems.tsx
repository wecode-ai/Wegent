import { useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Ellipsis,
  ListChecks,
  ListFilterPlus,
  Plus,
  RotateCcw,
  Signal,
  X,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { TodoDetailItem, TodoViewState } from './TodoDetailPanel'
import {
  countActiveTodoFilters,
  DEFAULT_TODO_FILTERS,
  type TodoAssigneeFilter,
  type TodoDisplaySettings,
  type TodoFilters,
  type TodoLayout,
  type TodoOrder,
  type TodoPriorityFilter,
  type TodoUpdatedFilter,
} from './todoViewSettings'

interface TodoWorkItemsProps {
  items: TodoDetailItem[]
  layout: TodoLayout
  filters: TodoFilters
  display: TodoDisplaySettings
  filtersOpen: boolean
  displayOpen: boolean
  onFiltersChange: (filters: TodoFilters) => void
  onDisplayChange: (display: TodoDisplaySettings) => void
  onCloseDisplay: () => void
  onSelectItem: (item: TodoDetailItem) => void
  onCreate: (state: TodoViewState) => void
}

const STATES: TodoViewState[] = ['backlog', 'started', 'review', 'completed']
const STATE_META: Record<TodoViewState, { labelKey: string; fallback: string; color: string }> = {
  backlog: { labelKey: 'todo.state_backlog', fallback: '待处理', color: '#858E97' },
  started: { labelKey: 'todo.state_started', fallback: '进行中', color: '#F59E0B' },
  review: { labelKey: 'todo.state_review', fallback: '待确认', color: '#8B5CF6' },
  completed: { labelKey: 'todo.state_completed', fallback: '已完成', color: '#10B981' },
}

const PRIORITY_RANK: Record<Exclude<TodoPriorityFilter, 'all'>, number> = {
  urgent: 5,
  high: 4,
  normal: 3,
  low: 2,
  none: 1,
}

export function TodoWorkItems({
  items,
  layout,
  filters,
  display,
  filtersOpen,
  displayOpen,
  onFiltersChange,
  onDisplayChange,
  onCloseDisplay,
  onSelectItem,
  onCreate,
}: TodoWorkItemsProps) {
  const filteredItems = useMemo(
    () => filterAndSortItems(items, filters, display.order),
    [display.order, filters, items]
  )

  return (
    <section className="relative flex min-h-0 flex-1 flex-col" data-testid="todo-work-items">
      {filtersOpen && <TodoFilterBar filters={filters} onChange={onFiltersChange} />}
      {layout === 'board' ? (
        <TodoBoard
          items={filteredItems}
          stateFilter={filters.state}
          display={display}
          onSelectItem={onSelectItem}
          onCreate={onCreate}
        />
      ) : (
        <TodoList
          items={filteredItems}
          stateFilter={filters.state}
          display={display}
          onSelectItem={onSelectItem}
          onCreate={onCreate}
        />
      )}
      {displayOpen && (
        <TodoDisplayPanel display={display} onChange={onDisplayChange} onClose={onCloseDisplay} />
      )}
    </section>
  )
}

function TodoFilterBar({
  filters,
  onChange,
}: {
  filters: TodoFilters
  onChange: (filters: TodoFilters) => void
}) {
  const { t } = useTranslation('common')
  const activeCount = countActiveTodoFilters(filters)
  return (
    <div
      data-testid="todo-filter-row"
      className="flex min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-[#E3E6E8] bg-white px-3.5 py-2 dark:border-border dark:bg-background"
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="flex h-[30px] items-center gap-1.5 rounded-md border border-[#DDE1E4] bg-[#F7F8F9] px-2 text-xs font-semibold text-[#5D666E] dark:border-border dark:bg-muted dark:text-text-secondary">
          <ListFilterPlus className="h-3.5 w-3.5" />
          {t('todo.filter_conditions', '筛选条件')}
        </span>
        <FilterSelect
          testId="todo-filter-state"
          label={t('todo.status', '状态')}
          value={filters.state}
          onChange={value => onChange({ ...filters, state: value as TodoFilters['state'] })}
          options={[
            { value: 'all', label: t('todo.all', '全部') },
            ...STATES.map(state => ({
              value: state,
              label: t(STATE_META[state].labelKey, STATE_META[state].fallback),
            })),
          ]}
        />
        <FilterSelect
          testId="todo-filter-assignee"
          label={t('todo.assignee', '负责人')}
          value={filters.assignee}
          onChange={value => onChange({ ...filters, assignee: value as TodoAssigneeFilter })}
          options={[
            { value: 'all', label: t('todo.all', '全部') },
            { value: 'ai', label: t('todo.assignee_ai', 'AI 智能体') },
            { value: 'human', label: t('todo.assignee_human', '员工') },
            { value: 'unassigned', label: t('todo.assignee_unassigned_short', '未指定') },
          ]}
        />
        <FilterSelect
          testId="todo-filter-priority"
          label={t('todo.priority', '优先级')}
          value={filters.priority}
          onChange={value => onChange({ ...filters, priority: value as TodoPriorityFilter })}
          options={[
            { value: 'all', label: t('todo.all', '全部') },
            { value: 'urgent', label: t('todo.priority_urgent', '紧急') },
            { value: 'high', label: t('todo.priority_high', '高') },
            { value: 'normal', label: t('todo.priority_normal', '普通') },
            { value: 'low', label: t('todo.priority_low', '低') },
            { value: 'none', label: t('todo.priority_none_short', '无') },
          ]}
        />
        <FilterSelect
          testId="todo-filter-updated"
          label={t('todo.updated_at', '更新时间')}
          value={filters.updated}
          onChange={value => onChange({ ...filters, updated: value as TodoUpdatedFilter })}
          options={[
            { value: 'all', label: t('todo.any_time', '不限') },
            { value: '7d', label: t('todo.last_7_days', '近 7 天') },
            { value: '30d', label: t('todo.last_30_days', '近 30 天') },
          ]}
        />
      </div>
      {activeCount > 0 && (
        <button
          type="button"
          data-testid="todo-filter-clear"
          onClick={() => onChange(DEFAULT_TODO_FILTERS)}
          className="flex h-[30px] shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-semibold text-[#68717A] hover:bg-[#F2F4F5] dark:hover:bg-muted"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t('todo.clear_all', '清除全部')}
        </button>
      )}
    </div>
  )
}

function FilterSelect({
  testId,
  label,
  value,
  options,
  onChange,
}: {
  testId: string
  label: string
  value: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}) {
  const selected = options.find(option => option.value === value)?.label ?? value
  return (
    <label className="relative flex h-[30px] items-center gap-1.5 rounded-md border border-[#DDE1E4] bg-[#F7F8F9] px-2 pr-7 text-xs text-[#596169] dark:border-border dark:bg-muted dark:text-text-secondary">
      <span className="text-[#858D95]">{label}</span>
      <span className="font-semibold text-[#30363C] dark:text-text-primary">{selected}</span>
      <ChevronDown className="pointer-events-none absolute right-2 h-3 w-3 text-[#899199]" />
      <select
        data-testid={testId}
        value={value}
        onChange={event => onChange(event.target.value)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
        aria-label={`${label}: ${selected}`}
      >
        {options.map(option => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function TodoDisplayPanel({
  display,
  onChange,
  onClose,
}: {
  display: TodoDisplaySettings
  onChange: (display: TodoDisplaySettings) => void
  onClose: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <div
      data-testid="todo-display-panel"
      className="absolute right-3 top-2 z-20 flex w-[300px] flex-col overflow-hidden rounded-lg border border-[#D9DEE2] bg-white shadow-[0_8px_24px_rgba(31,41,55,0.14)] dark:border-border dark:bg-background"
    >
      <header className="flex h-11 items-center justify-between border-b border-[#E6E9EB] px-3.5 dark:border-border">
        <span className="text-xs font-semibold text-[#30363C] dark:text-text-primary">
          {t('todo.display_settings', '显示设置')}
        </span>
        <button
          type="button"
          data-testid="todo-display-close"
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#7D858C] hover:bg-[#F2F4F5] dark:hover:bg-muted"
          aria-label={t('workbench.close', '关闭')}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </header>
      <div className="space-y-3 px-3.5 py-3">
        <DisplaySection title={t('todo.card_properties', '卡片显示属性')}>
          <DisplayToggle
            testId="todo-display-assignee"
            label={t('todo.assignee', '负责人')}
            checked={display.showAssignee}
            onChange={checked => onChange({ ...display, showAssignee: checked })}
          />
          <DisplayToggle
            testId="todo-display-priority"
            label={t('todo.priority', '优先级')}
            checked={display.showPriority}
            onChange={checked => onChange({ ...display, showPriority: checked })}
          />
          <DisplayToggle
            testId="todo-display-updated"
            label={t('todo.updated_at', '更新时间')}
            checked={display.showUpdated}
            onChange={checked => onChange({ ...display, showUpdated: checked })}
          />
          <DisplayToggle
            testId="todo-display-objective"
            label={t('todo.goal', '目标')}
            checked={display.showObjective}
            onChange={checked => onChange({ ...display, showObjective: checked })}
          />
        </DisplaySection>
        <div className="h-px bg-[#E8EBED] dark:bg-border" />
        <DisplaySection title={t('todo.grouping', '分组方式')}>
          <div className="flex h-8 items-center gap-2 rounded-md border border-[#DDE1E4] bg-[#F7F8F9] px-2.5 text-xs font-semibold text-[#414950] dark:border-border dark:bg-muted dark:text-text-secondary">
            <span className="h-2.5 w-2.5 rounded-full bg-[#14B8A6]" />
            {t('todo.group_by_state', '按状态分组')}
          </div>
          <DisplayToggle
            testId="todo-display-empty-groups"
            label={t('todo.show_empty_groups', '显示空分组')}
            checked={display.showEmptyGroups}
            onChange={checked => onChange({ ...display, showEmptyGroups: checked })}
          />
        </DisplaySection>
        <div className="h-px bg-[#E8EBED] dark:bg-border" />
        <DisplaySection title={t('todo.order_by', '排序')}>
          {(
            [
              ['manual', t('todo.order_manual', '手动排序')],
              ['updated', t('todo.order_updated', '最近更新')],
              ['priority', t('todo.order_priority', '优先级')],
            ] as Array<[TodoOrder, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              data-testid={`todo-display-order-${value}`}
              onClick={() => onChange({ ...display, order: value })}
              className={cn(
                'flex h-8 w-full items-center justify-between rounded-md px-2.5 text-xs text-[#596169] hover:bg-[#F2F4F5] dark:text-text-secondary dark:hover:bg-muted',
                display.order === value &&
                  'bg-[#E8F8F5] font-semibold text-[#0F766E] dark:bg-primary/10 dark:text-primary'
              )}
            >
              {label}
              {display.order === value && <Check className="h-3.5 w-3.5" />}
            </button>
          ))}
        </DisplaySection>
      </div>
      <footer className="border-t border-[#E8EBED] bg-[#FAFBFB] px-3.5 py-2 text-xs text-[#8B939A] dark:border-border dark:bg-background">
        {t('todo.display_saved_per_project', '设置仅影响当前项目视图，并自动保存')}
      </footer>
    </div>
  )
}

function DisplaySection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-semibold text-[#818990]">{title}</h3>
      {children}
    </section>
  )
}

function DisplayToggle({
  testId,
  label,
  checked,
  onChange,
}: {
  testId: string
  label: string
  checked: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className="flex h-7 w-full items-center justify-between text-xs text-[#414950] dark:text-text-secondary"
    >
      {label}
      <span
        className={cn(
          'relative h-[17px] w-[30px] rounded-full bg-[#D7DCDF] transition-colors',
          checked && 'bg-[#14B8A6]'
        )}
      >
        <span
          className={cn(
            'absolute left-0.5 top-0.5 h-[13px] w-[13px] rounded-full bg-white transition-transform',
            checked && 'translate-x-[13px]'
          )}
        />
      </span>
    </button>
  )
}

function TodoBoard({
  items,
  stateFilter,
  display,
  onSelectItem,
  onCreate,
}: {
  items: TodoDetailItem[]
  stateFilter: TodoFilters['state']
  display: TodoDisplaySettings
  onSelectItem: (item: TodoDetailItem) => void
  onCreate: (state: TodoViewState) => void
}) {
  const [collapsedStates, setCollapsedStates] = useState<Set<TodoViewState>>(new Set())
  const states = (stateFilter === 'all' ? STATES : [stateFilter]).filter(
    state => display.showEmptyGroups || items.some(item => item.state === state)
  )
  return (
    <div
      data-testid="todo-board-scroll"
      className="min-h-0 flex-1 overflow-auto bg-[#F7F8F9] p-3 dark:bg-background"
    >
      <div data-testid="todo-board-grid" className="flex min-h-full min-w-[900px] gap-2.5">
        {states.map(state => (
          <TodoColumn
            key={state}
            state={state}
            items={items.filter(item => item.state === state)}
            display={display}
            collapsed={collapsedStates.has(state)}
            onToggleCollapsed={() =>
              setCollapsedStates(current => {
                const next = new Set(current)
                if (next.has(state)) next.delete(state)
                else next.add(state)
                return next
              })
            }
            onSelectItem={onSelectItem}
            onCreate={() => onCreate(state)}
          />
        ))}
      </div>
    </div>
  )
}

function TodoColumn({
  state,
  items,
  display,
  collapsed,
  onToggleCollapsed,
  onSelectItem,
  onCreate,
}: {
  state: TodoViewState
  items: TodoDetailItem[]
  display: TodoDisplaySettings
  collapsed: boolean
  onToggleCollapsed: () => void
  onSelectItem: (item: TodoDetailItem) => void
  onCreate: () => void
}) {
  const { t } = useTranslation('common')
  const [menuOpen, setMenuOpen] = useState(false)
  const meta = STATE_META[state]
  if (collapsed) {
    return (
      <section
        data-testid={`todo-column-${state}`}
        className="flex w-10 shrink-0 flex-col items-center rounded-md bg-[#F0F2F3] py-2 dark:bg-muted"
      >
        <button
          type="button"
          data-testid={`todo-column-expand-${state}`}
          onClick={onToggleCollapsed}
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-white dark:hover:bg-background"
          aria-label={t('todo.expand_column', '展开列')}
        >
          <ChevronRight className="h-3.5 w-3.5 text-[#727B83]" />
        </button>
        <span className="mt-2 h-2.5 w-2.5 rounded-full" style={{ backgroundColor: meta.color }} />
        <span className="mt-2 font-mono text-xs text-[#7A838B]">{items.length}</span>
        <span className="mt-2 [writing-mode:vertical-rl] text-xs font-semibold text-[#596169] dark:text-text-secondary">
          {t(meta.labelKey, meta.fallback)}
        </span>
      </section>
    )
  }
  return (
    <section data-testid={`todo-column-${state}`} className="relative min-w-[210px] flex-1 basis-0">
      <header className="flex h-[34px] items-center justify-between px-1.5">
        <div className="flex items-center gap-2">
          <span className="h-3 w-3 rounded-full" style={{ backgroundColor: meta.color }} />
          <span className="text-xs font-semibold text-[#30363C] dark:text-text-primary">
            {t(meta.labelKey, meta.fallback)}
          </span>
          <span className="font-mono text-xs text-[#7A838B]">{items.length}</span>
        </div>
        <div className="flex items-center gap-1.5 text-[#808890]">
          <button
            type="button"
            data-testid={`todo-column-add-${state}`}
            onClick={onCreate}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-[#EAECED]"
            aria-label={t('todo.create_action', '新建 TODO')}
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            data-testid={`todo-column-more-${state}`}
            onClick={() => setMenuOpen(value => !value)}
            aria-expanded={menuOpen}
            className="flex h-6 w-6 items-center justify-center rounded hover:bg-[#EAECED]"
            aria-label={t('workbench.more', '更多')}
          >
            <Ellipsis className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      {menuOpen && (
        <div
          data-testid={`todo-column-menu-${state}`}
          className="absolute right-0 top-8 z-10 w-36 rounded-md border border-[#DDE1E4] bg-white p-1 shadow-lg dark:border-border dark:bg-background"
        >
          <button
            type="button"
            data-testid={`todo-column-menu-add-${state}`}
            onClick={() => {
              setMenuOpen(false)
              onCreate()
            }}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-xs text-[#4F575F] hover:bg-[#F2F4F5] dark:text-text-secondary dark:hover:bg-muted"
          >
            <Plus className="h-3.5 w-3.5" />
            {t('todo.create_action', '新建 TODO')}
          </button>
          <button
            type="button"
            data-testid={`todo-column-menu-collapse-${state}`}
            onClick={() => {
              setMenuOpen(false)
              onToggleCollapsed()
            }}
            className="flex h-8 w-full items-center gap-2 rounded px-2 text-xs text-[#4F575F] hover:bg-[#F2F4F5] dark:text-text-secondary dark:hover:bg-muted"
          >
            <ChevronDown className="h-3.5 w-3.5" />
            {t('todo.collapse_column', '收起列')}
          </button>
        </div>
      )}
      <div className="space-y-2.5">
        {items.map(item => (
          <TodoCard
            key={item.id}
            item={item}
            display={display}
            onClick={() => onSelectItem(item)}
          />
        ))}
        <button
          type="button"
          data-testid={`todo-column-bottom-add-${state}`}
          onClick={onCreate}
          className="flex h-[34px] w-full items-center gap-2 rounded-md px-2 text-xs text-[#7B848C] hover:bg-[#ECEEEF] hover:text-[#4E565E]"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('todo.add_work_item', '添加工作项')}
        </button>
      </div>
    </section>
  )
}

function TodoList({
  items,
  stateFilter,
  display,
  onSelectItem,
  onCreate,
}: {
  items: TodoDetailItem[]
  stateFilter: TodoFilters['state']
  display: TodoDisplaySettings
  onSelectItem: (item: TodoDetailItem) => void
  onCreate: (state: TodoViewState) => void
}) {
  const { t } = useTranslation('common')
  const states = (stateFilter === 'all' ? STATES : [stateFilter]).filter(
    state => display.showEmptyGroups || items.some(item => item.state === state)
  )
  return (
    <div
      data-testid="todo-list-view"
      className="min-h-0 flex-1 overflow-auto bg-[#F7F8F9] p-3 dark:bg-background"
    >
      <div className="min-w-[760px] overflow-hidden rounded-lg border border-[#DDE1E4] bg-white dark:border-border dark:bg-surface">
        {states.map(state => {
          const stateItems = items.filter(item => item.state === state)
          const meta = STATE_META[state]
          return (
            <section key={state} data-testid={`todo-list-group-${state}`}>
              <header className="flex h-10 items-center justify-between border-b border-[#E7EAEC] bg-[#F7F8F9] px-3 dark:border-border dark:bg-muted">
                <span className="flex items-center gap-2 text-xs font-semibold text-[#3C444B] dark:text-text-primary">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: meta.color }}
                  />
                  {t(meta.labelKey, meta.fallback)}
                  <span className="font-mono text-xs text-[#879098]">{stateItems.length}</span>
                </span>
                <button
                  type="button"
                  data-testid={`todo-list-add-${state}`}
                  onClick={() => onCreate(state)}
                  className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-[#68717A] hover:bg-white dark:hover:bg-background"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t('todo.create_action', '新建 TODO')}
                </button>
              </header>
              {stateItems.length === 0 ? (
                <div className="flex h-12 items-center px-4 text-xs text-[#9AA2A9]">
                  {t('todo.no_matching_items', '暂无符合条件的 TODO')}
                </div>
              ) : (
                stateItems.map(item => (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`todo-list-item-${item.id}`}
                    onClick={() => onSelectItem(item)}
                    className="grid h-12 w-full grid-cols-[86px_minmax(240px,1fr)_120px_110px_90px] items-center gap-3 border-b border-[#EEF0F1] px-3 text-left text-xs last:border-b-0 hover:bg-[#FAFBFB] dark:border-border dark:hover:bg-muted"
                  >
                    <span className="font-mono font-semibold text-[#879098]">{item.code}</span>
                    <span className="truncate text-xs font-semibold text-[#30363C] dark:text-text-primary">
                      {item.title}
                    </span>
                    <span className="truncate text-[#68717A] dark:text-text-secondary">
                      {display.showAssignee ? item.assignee || item.runtime : '—'}
                    </span>
                    <span className="text-[#68717A] dark:text-text-secondary">
                      {display.showPriority ? item.priority || '—' : '—'}
                    </span>
                    <span className="text-[#8A9299]">
                      {display.showUpdated ? formatShortDate(item.updatedAt) : '—'}
                    </span>
                  </button>
                ))
              )}
            </section>
          )
        })}
      </div>
    </div>
  )
}

function TodoCard({
  item,
  display,
  onClick,
}: {
  item: TodoDetailItem
  display: TodoDisplaySettings
  onClick: () => void
}) {
  const labelColor = item.runtime.toLowerCase().includes('codex') ? '#14B8A6' : '#9B6BE8'
  const initials = item.assigneeType === 'human' ? 'HY' : 'AI'
  return (
    <button
      type="button"
      data-testid={`todo-card-${item.id}`}
      onClick={onClick}
      className="flex min-h-[150px] w-full flex-col gap-2.5 rounded-lg border border-[#DDE1E4] bg-white p-3 text-left shadow-[0_1px_3px_rgba(17,24,39,0.06)] transition-colors hover:border-[#BFC6CB] dark:border-border dark:bg-surface"
    >
      <span className="font-mono text-xs font-semibold text-[#858D95]">{item.code}</span>
      <span className="line-clamp-2 min-h-[36px] text-sm font-semibold leading-[1.35] text-[#262B30] dark:text-text-primary">
        {item.title}
      </span>
      {display.showObjective && item.objective && (
        <span className="line-clamp-2 text-xs leading-4 text-[#6F7880]">{item.objective}</span>
      )}
      {(display.showPriority || display.showAssignee) && (
        <span className="flex min-w-0 items-center gap-1.5">
          {display.showPriority && (
            <span className="flex h-[22px] items-center gap-1 rounded-[5px] border border-[#E2E5E7] bg-[#F7F8F9] px-1.5 text-xs font-semibold text-[#626A72] dark:border-border dark:bg-muted dark:text-text-secondary">
              <Signal className="h-3 w-3" />
              {item.priority || '—'}
            </span>
          )}
          {display.showAssignee && (
            <span className="flex h-[22px] min-w-0 items-center gap-1 rounded-[5px] border border-[#E2E5E7] bg-[#F7F8F9] px-1.5 text-xs font-semibold text-[#626A72] dark:border-border dark:bg-muted dark:text-text-secondary">
              <span
                className="h-[7px] w-[7px] shrink-0 rounded-full"
                style={{ backgroundColor: labelColor }}
              />
              <span className="truncate">{item.assignee || item.runtime}</span>
            </span>
          )}
        </span>
      )}
      <span className="mt-auto flex w-full items-center justify-between">
        <span className="flex min-w-0 items-center gap-1 text-xs text-[#727B83]">
          <CircleDot className="h-3 w-3 shrink-0" />
          <span className="max-w-[120px] truncate">{item.workspace}</span>
          {display.showUpdated && (
            <>
              <ListChecks className="ml-1 h-3 w-3 shrink-0" />
              <span>{formatShortDate(item.updatedAt)}</span>
            </>
          )}
        </span>
        {display.showAssignee && (
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-white bg-[#DDF8F2] text-xs font-bold text-[#0F766E]">
            {initials}
          </span>
        )}
      </span>
    </button>
  )
}

function filterAndSortItems(
  items: TodoDetailItem[],
  filters: TodoFilters,
  order: TodoOrder
): TodoDetailItem[] {
  const cutoffDays = filters.updated === '7d' ? 7 : filters.updated === '30d' ? 30 : null
  const cutoff = cutoffDays == null ? null : Date.now() - cutoffDays * 24 * 60 * 60 * 1000
  const filtered = items.filter(item => {
    if (filters.state !== 'all' && item.state !== filters.state) return false
    if (filters.assignee !== 'all' && item.assigneeType !== filters.assignee) return false
    if (filters.priority !== 'all' && (item.priorityValue ?? 'none') !== filters.priority)
      return false
    if (cutoff != null) {
      const updatedAt = item.updatedAt == null ? NaN : new Date(item.updatedAt).getTime()
      if (!Number.isFinite(updatedAt) || updatedAt < cutoff) return false
    }
    return true
  })
  if (order === 'manual') return filtered
  return [...filtered].sort((left, right) => {
    if (order === 'updated') return timestamp(right.updatedAt) - timestamp(left.updatedAt)
    return (
      PRIORITY_RANK[right.priorityValue ?? 'none'] - PRIORITY_RANK[left.priorityValue ?? 'none']
    )
  })
}

function timestamp(value: string | number | null | undefined): number {
  if (value == null) return 0
  const result = new Date(value).getTime()
  return Number.isFinite(result) ? result : 0
}

function formatShortDate(value: string | number | null | undefined): string {
  if (value == null) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(date)
}
