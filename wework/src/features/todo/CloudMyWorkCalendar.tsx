import { useMemo } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/daygrid'
import zhCnLocale from '@fullcalendar/core/locales/zh-cn'
import { buildMyWorkCalendarEntries, MY_WORK_GROUP_EVENT_COLORS } from '@wegent/collaboration'
import type { CloudMyWorkItem } from '@/api/deliveries'
import { useTranslation } from '@/hooks/useTranslation'
import { isExecutionActive } from './executionStatus'
import './cloud-my-work-calendar.css'

interface CloudMyWorkCalendarProps {
  items: readonly CloudMyWorkItem[]
  onSelectItem: (item: CloudMyWorkItem) => void
}

export function CloudMyWorkCalendar({ items, onSelectItem }: CloudMyWorkCalendarProps) {
  const { t, i18n } = useTranslation('common')

  const events = useMemo(
    () =>
      buildMyWorkCalendarEntries(items, isExecutionActive).map(entry => ({
        id: entry.id,
        title: entry.title,
        start: entry.start,
        allDay: true,
        backgroundColor: MY_WORK_GROUP_EVENT_COLORS[entry.group],
        borderColor: 'transparent',
        extendedProps: { item: entry.item },
      })),
    [items]
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
