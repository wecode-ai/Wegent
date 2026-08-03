import { Archive, MailOpen, Pin } from 'lucide-react'
import type { ReactNode } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'
import type { DesktopSidebarPriorityRecentGroup } from './desktopSidebarPriorityView'

interface DesktopSidebarPrioritySectionProps<Item> {
  priorityItems: Item[]
  pinnedItems: Item[]
  recentGroups: DesktopSidebarPriorityRecentGroup<Item>[]
  getTaskKey: (item: Item) => string
  renderTaskItem: (item: Item) => ReactNode
  showPinned: boolean
  onTogglePinned: () => void
  canMarkAllAsRead: boolean
  canArchivePriority: boolean
  onMarkAllAsRead: () => void
  onArchivePriority: () => void
}

export function DesktopSidebarPrioritySection<Item>({
  priorityItems,
  pinnedItems,
  recentGroups,
  getTaskKey,
  renderTaskItem,
  showPinned,
  onTogglePinned,
  canMarkAllAsRead,
  canArchivePriority,
  onMarkAllAsRead,
  onArchivePriority,
}: DesktopSidebarPrioritySectionProps<Item>) {
  const { i18n, t } = useTranslation('common')
  const hasAttentionItems = priorityItems.length > 0 || pinnedItems.length > 0
  const formatRecentGroupTitle = (group: DesktopSidebarPriorityRecentGroup<Item>): string => {
    if (group.relativeDay === 'today') {
      return t('workbench.priority_filter_today', '今天')
    }
    if (group.relativeDay === 'yesterday') {
      return t('workbench.priority_filter_yesterday', '昨天')
    }
    return new Intl.DateTimeFormat(i18n.resolvedLanguage || i18n.language, {
      weekday: 'long',
    }).format(group.dayStart)
  }
  const renderList = (items: Item[], testId: string) => (
    <div data-testid={testId} role="list" className="flex flex-col gap-px">
      {items.map(item => (
        <div key={getTaskKey(item)} role="listitem">
          {renderTaskItem(item)}
        </div>
      ))}
    </div>
  )

  return (
    <div data-testid="runtime-priority-section" className="mt-1 flex flex-col px-0.5" role="list">
      <section>
        <div className="group/priority flex h-[30px] items-center px-2.5">
          <span className="text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
            {t('workbench.priority_filter_title', '优先级')}
          </span>
          <div className="ml-auto opacity-0 transition-opacity group-hover/priority:opacity-100 focus-within:opacity-100">
            <ActionMenu
              ariaLabel={t('workbench.priority_filter_options', '优先级筛选选项')}
              testId="runtime-priority-filter-options"
              placement="bottom-end"
              items={[
                {
                  label: showPinned
                    ? t('workbench.priority_filter_hide_pinned', '隐藏置顶会话')
                    : t('workbench.priority_filter_show_pinned', '显示置顶会话'),
                  icon: Pin,
                  testId: 'runtime-priority-filter-toggle-pinned',
                  onSelect: onTogglePinned,
                },
                {
                  label: t('workbench.priority_filter_mark_all_read', '全部标为已读'),
                  icon: MailOpen,
                  testId: 'runtime-priority-filter-mark-all-read',
                  disabled: !canMarkAllAsRead,
                  onSelect: onMarkAllAsRead,
                },
                {
                  label: t('workbench.priority_filter_archive', '归档优先级任务'),
                  icon: Archive,
                  testId: 'runtime-priority-filter-archive',
                  disabled: !canArchivePriority,
                  onSelect: onArchivePriority,
                },
              ]}
              triggerClassName="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
            />
          </div>
        </div>
        {!hasAttentionItems ? (
          <div
            data-testid="runtime-priority-empty"
            className="px-3 py-2 text-sm text-[rgb(var(--color-sidebar-text-muted))]"
          >
            {t('workbench.priority_filter_empty', '没有需要关注的任务')}
          </div>
        ) : (
          renderList(priorityItems, 'runtime-priority-list')
        )}
      </section>

      {pinnedItems.length > 0 && (
        <>
          <div aria-hidden="true" className="h-4 shrink-0" />
          <section data-testid="runtime-priority-pinned-section">
            <div className="flex h-[30px] items-center px-2.5 text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
              {t('workbench.pinned', '置顶')}
            </div>
            {renderList(pinnedItems, 'runtime-priority-pinned-list')}
          </section>
        </>
      )}

      {recentGroups.map(group => (
        <div key={group.dayStart}>
          <div aria-hidden="true" className="h-4 shrink-0" />
          <section data-testid={`runtime-priority-recent-section-${group.dayStart}`}>
            <div className="flex h-[30px] items-center px-2.5 text-xs font-medium leading-4 text-[rgb(var(--color-sidebar-text-muted))] opacity-75">
              {formatRecentGroupTitle(group)}
            </div>
            {renderList(group.items, `runtime-priority-recent-list-${group.dayStart}`)}
          </section>
        </div>
      ))}
    </div>
  )
}
