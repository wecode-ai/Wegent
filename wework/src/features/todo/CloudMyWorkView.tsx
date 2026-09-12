import { MyWorkView, type MyWorkItem } from '@wegent/collaboration'
import { CalendarDays, Clock, LayoutGrid, List } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { CloudMyWorkCalendar } from './CloudMyWorkCalendar'
import { isExecutionActive } from './executionStatus'

interface CloudMyWorkViewProps<T extends MyWorkItem> {
  items: readonly T[]
  title?: string
  onSelectItem: (item: T) => void
  onApproveItem?: (item: T) => void | Promise<void>
}

const icons = {
  group: LayoutGrid,
  list: List,
  calendar: CalendarDays,
  timeline: Clock,
}

export function CloudMyWorkView<T extends MyWorkItem>({
  items,
  title,
  onSelectItem,
  onApproveItem,
}: CloudMyWorkViewProps<T>) {
  const { t, i18n } = useTranslation('common')

  return (
    <MyWorkView
      items={items}
      locale={i18n.language}
      translate={(key, fallback) => (key === 'todo.my_work' && title ? title : t(key, fallback))}
      icons={icons}
      isExecutionStateActive={isExecutionActive}
      onSelectItem={onSelectItem}
      onApproveItem={onApproveItem}
      renderCalendar={props => <CloudMyWorkCalendar {...props} />}
    />
  )
}
