import { MyWorkView } from '@wegent/collaboration'
import { CalendarDays, Clock, LayoutGrid, List } from 'lucide-react'
import type { CloudMyWorkItem } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { CloudMyWorkCalendar } from './CloudMyWorkCalendar'
import { isExecutionActive } from './executionStatus'

interface CloudMyWorkViewProps {
  items: CloudMyWorkItem[]
  onSelectItem: (item: CloudMyWorkItem) => void
  onApproveItem?: (item: CloudMyWorkItem) => void | Promise<void>
}

const icons = {
  group: LayoutGrid,
  list: List,
  calendar: CalendarDays,
  timeline: Clock,
}

export function CloudMyWorkView({ items, onSelectItem, onApproveItem }: CloudMyWorkViewProps) {
  const { t, i18n } = useTranslation('common')

  return (
    <MyWorkView
      items={items}
      locale={i18n.language}
      translate={(key, fallback) => t(key, fallback)}
      icons={icons}
      isExecutionStateActive={isExecutionActive}
      onSelectItem={onSelectItem}
      onApproveItem={onApproveItem}
      renderCalendar={props => <CloudMyWorkCalendar {...props} />}
    />
  )
}
