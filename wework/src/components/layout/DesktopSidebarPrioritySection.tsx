import { Pin } from 'lucide-react'
import type { ReactNode } from 'react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { useTranslation } from '@/hooks/useTranslation'

interface DesktopSidebarPrioritySectionProps<Item> {
  taskItems: Item[]
  getTaskKey: (item: Item) => string
  renderTaskItem: (item: Item) => ReactNode
  showPinned: boolean
  onTogglePinned: () => void
}

export function DesktopSidebarPrioritySection<Item>({
  taskItems,
  getTaskKey,
  renderTaskItem,
  showPinned,
  onTogglePinned,
}: DesktopSidebarPrioritySectionProps<Item>) {
  const { t } = useTranslation('common')

  return (
    <section data-testid="runtime-priority-section" className="mt-1">
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
            ]}
            triggerClassName="flex h-7 w-7 items-center justify-center rounded-md text-[rgb(var(--color-sidebar-text-secondary))] hover:bg-[rgb(var(--color-sidebar-hover))] hover:text-[rgb(var(--color-sidebar-text-primary))]"
          />
        </div>
      </div>
      {taskItems.length === 0 ? (
        <div
          data-testid="runtime-priority-empty"
          className="px-3 py-2 text-sm text-[rgb(var(--color-sidebar-text-muted))]"
        >
          {t('workbench.priority_filter_empty', '没有需要关注的任务')}
        </div>
      ) : (
        <div data-testid="runtime-priority-list" role="list" className="space-y-0.5">
          {taskItems.map(item => (
            <div key={getTaskKey(item)} role="listitem">
              {renderTaskItem(item)}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
