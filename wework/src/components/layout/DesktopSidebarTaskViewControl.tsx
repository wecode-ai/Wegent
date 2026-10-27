import { ChevronDown, Columns3, ListTodo, RotateCw } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { TitlebarTooltip } from '@/components/topnav/TitlebarTooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'

export type DesktopSidebarTaskViewAction = 'priority' | 'board' | 'collapse-read'

interface DesktopSidebarTaskViewControlProps {
  action: DesktopSidebarTaskViewAction
  boardAvailable: boolean
  boardActive: boolean
  priorityActive: boolean
  priorityNeedsAttention: boolean
  priorityShortcut: string | null
  collapseReadShortcut: string | null
  hasCollapsedReadConversations: boolean
  onSelect: (action: DesktopSidebarTaskViewAction) => void
  onRun: () => void
  onExpandReadConversations: () => void
}

export function DesktopSidebarTaskViewControl({
  action,
  boardAvailable,
  boardActive,
  priorityActive,
  priorityNeedsAttention,
  priorityShortcut,
  collapseReadShortcut,
  hasCollapsedReadConversations,
  onSelect,
  onRun,
  onExpandReadConversations,
}: DesktopSidebarTaskViewControlProps) {
  const { t } = useTranslation('common')
  const collapseReadLabel = t('workbench.collapse_read_conversations', '收起已读会话')
  const priorityLabel = priorityActive
    ? t('workbench.priority_filter_turn_off', '关闭优先级筛选')
    : t('workbench.priority_filter', '按优先级筛选')
  const label =
    action === 'collapse-read'
      ? collapseReadLabel
      : action === 'board'
        ? t('workbench.work_item_create_title', '看板')
        : priorityLabel
  const active = action === 'board' ? boardActive : action === 'priority' && priorityActive
  const needsAttention = action === 'priority' && priorityNeedsAttention && !priorityActive
  const Icon = action === 'collapse-read' ? RotateCw : action === 'board' ? Columns3 : ListTodo

  return (
    <span
      data-testid="runtime-task-view-control"
      className="inline-flex shrink-0 items-center rounded-lg"
    >
      <TitlebarTooltip
        label={label}
        shortcut={
          action === 'collapse-read'
            ? (collapseReadShortcut ?? undefined)
            : action === 'priority' && !priorityActive
              ? (priorityShortcut ?? undefined)
              : undefined
        }
        align="end"
        testId="runtime-priority-filter-tooltip"
      >
        <button
          type="button"
          data-testid="runtime-priority-filter-button"
          onClick={onRun}
          aria-pressed={action === 'collapse-read' ? undefined : active}
          className={cn(
            'relative flex h-7 w-7 shrink-0 items-center justify-center rounded-l-lg text-[rgb(var(--color-sidebar-text-primary))] hover:bg-[rgb(var(--color-sidebar-hover))] focus-visible:outline-none keyboard:focus-visible:ring-1 keyboard:focus-visible:ring-blue-500',
            active && 'bg-[rgb(var(--color-sidebar-active))]'
          )}
          aria-label={
            needsAttention
              ? t('workbench.priority_filter_needs_attention', '按优先级筛选，需要关注')
              : label
          }
        >
          <Icon className="h-4 w-4" aria-hidden="true" />
          {needsAttention && (
            <span
              data-testid="runtime-priority-filter-attention-dot"
              aria-hidden="true"
              className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-primary"
            />
          )}
        </button>
      </TitlebarTooltip>
      <ActionMenu
        ariaLabel={t('workbench.task_view_menu', '任务视图')}
        testId="runtime-task-view-menu-button"
        menuTestId="runtime-task-view-menu"
        icon={ChevronDown}
        placement="bottom-end"
        showTriggerTooltip={false}
        items={[
          {
            label: t('workbench.priority_filter', '按优先级筛选'),
            icon: ListTodo,
            testId: 'runtime-task-view-priority',
            shortcut: priorityShortcut ?? undefined,
            onSelect: () => onSelect('priority'),
          },
          {
            label: collapseReadLabel,
            icon: RotateCw,
            testId: 'runtime-task-view-collapse-read',
            shortcut: collapseReadShortcut ?? undefined,
            onSelect: () => onSelect('collapse-read'),
          },
          ...(boardAvailable
            ? [
                {
                  label: t('workbench.work_item_create_title', '看板'),
                  icon: Columns3,
                  testId: 'runtime-task-view-board',
                  onSelect: () => onSelect('board'),
                },
              ]
            : []),
          ...(hasCollapsedReadConversations
            ? [
                {
                  label: t('workbench.expand_read_conversations', '展开已读会话'),
                  testId: 'runtime-task-view-expand-read',
                  onSelect: onExpandReadConversations,
                },
              ]
            : []),
        ]}
        triggerClassName="flex h-7 w-4 shrink-0 items-center justify-center rounded-r-lg text-[rgb(var(--color-sidebar-text-muted))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))] focus-visible:outline-none keyboard:focus-visible:ring-1 keyboard:focus-visible:ring-blue-500 [&_svg]:h-2.5 [&_svg]:w-2.5"
      />
    </span>
  )
}
