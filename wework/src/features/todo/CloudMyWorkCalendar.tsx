import { useMemo } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import zhCnLocale from '@fullcalendar/core/locales/zh-cn'
import type { CloudMyWorkItem } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { myWorkGroupOf, type MyWorkGroupKey } from './cloudMyWorkModel'
import './cloud-my-work-calendar.css'

interface CloudMyWorkCalendarProps {
  items: CloudMyWorkItem[]
  onSelectItem: (item: CloudMyWorkItem) => void
}

// Status colors mirror the group dot classes used across the my-work views.
const GROUP_EVENT_COLORS: Record<MyWorkGroupKey, string> = {
  action: '#6366f1',
  running: '#f59e0b',
  review: '#8b5cf6',
  done: '#10b981',
}

export function CloudMyWorkCalendar({ items, onSelectItem }: CloudMyWorkCalendarProps) {
  const { t, i18n } = useTranslation('common')

  const datedItems = useMemo(
    () =>
      items.filter(item => {
        if (!item.due_at) return false
        return !Number.isNaN(new Date(item.due_at).getTime())
      }),
    [items]
  )

  const events = useMemo(
    () =>
      datedItems.map(item => ({
        id: item.id,
        title: item.title,
        start: item.due_at as string,
        allDay: true,
        backgroundColor: GROUP_EVENT_COLORS[myWorkGroupOf(item)],
        borderColor: 'transparent',
        extendedProps: { item },
      })),
    [datedItems]
  )

  return (
    <div>
      <div
        data-testid="my-work-calendar"
        className="cloud-my-work-calendar rounded-2xl border border-border bg-background p-4 shadow-sm"
      >
        <FullCalendar
          plugins={[dayGridPlugin]}
          initialView="dayGridMonth"
          locale={(i18n.language ?? '').startsWith('zh') ? zhCnLocale : undefined}
          height="auto"
          headerToolbar={{
            left: 'prev,next today',
            center: 'title',
            right: 'dayGridMonth,dayGridWeek',
          }}
          buttonText={{
            today: t('todo.my_work_today', '今天'),
            month: t('todo.my_work_month', '月'),
            week: t('todo.my_work_week', '周'),
          }}
          events={events}
          eventContent={arg => (
            <span className="flex min-w-0 items-baseline gap-1">
              <span className="my-work-event-id shrink-0">{arg.event.id}</span>
              <span className="min-w-0 truncate">{arg.event.title}</span>
            </span>
          )}
          eventClick={info => {
            const item = info.event.extendedProps.item as CloudMyWorkItem | undefined
            if (item) onSelectItem(item)
          }}
        />
      </div>
      <p className="mt-3 text-xs text-text-muted">
        {t('todo.my_work_calendar_note', '日历仅展示设置了截止日期的任务。')}
      </p>
    </div>
  )
}
