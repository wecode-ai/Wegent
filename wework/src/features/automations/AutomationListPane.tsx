import { Button } from '@/components/ui/button'
import {
  Bell,
  ChevronDown,
  Clock,
  PauseCircle,
  CircleAlert,
  ClipboardList,
  FileSearch,
  Loader2,
  Plus,
  Search,
} from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { Automation, AutomationSchedule } from '@/types/automation'
import type { AutomationDraft } from './automationDraft'
export type StatusFilter = 'all' | 'active' | 'paused'

export function AutomationListPane({
  automations,
  allAutomations,
  query,
  statusFilter,
  selectedAutomationId,
  locale,
  loading,
  error,
  detailOpen,
  mobileDetailOpen,
  onQueryChange,
  onFilterChange,
  onSelect,
  onCreate,
  onClearError,
  onReviewTemplate,
  calendar = false,
}: {
  automations: Automation[]
  allAutomations: Automation[]
  query: string
  statusFilter: StatusFilter
  selectedAutomationId: string | null
  locale: string
  loading: boolean
  error: string | null
  detailOpen: boolean
  mobileDetailOpen: boolean
  onQueryChange: (query: string) => void
  onFilterChange: (filter: StatusFilter) => void
  onSelect: (automation: Automation) => void
  onCreate: (
    template?: Pick<AutomationDraft, 'name' | 'prompt' | 'cronExpression' | 'cronTime'>
  ) => void
  onClearError: () => void
  onReviewTemplate?: () => void
  calendar?: boolean
}) {
  const { t } = useTranslation('common')
  return (
    <aside
      data-testid="automation-list-pane"
      className={cn(
        'w-full overflow-y-auto bg-background',
        detailOpen ? 'shrink-0 border-r border-border md:w-[430px] xl:w-[500px]' : 'min-w-0 flex-1',
        mobileDetailOpen && 'hidden md:block'
      )}
    >
      <div className="px-4 pb-10 pt-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1">
            {(['all', 'active', 'paused'] as const).map(filter => (
              <button
                key={filter}
                type="button"
                data-testid={`automation-filter-${filter}`}
                aria-pressed={statusFilter === filter}
                onClick={() => onFilterChange(filter)}
                className={cn(
                  'h-8 rounded-lg px-2.5 text-sm transition-colors',
                  statusFilter === filter
                    ? 'bg-surface font-medium'
                    : 'text-text-secondary hover:bg-surface'
                )}
              >
                {filter === 'all'
                  ? t('todo.all', '全部')
                  : filter === 'active'
                    ? t('todo.automation_filter_active', '已开启')
                    : t('todo.automation_filter_paused', '已暂停')}
              </button>
            ))}
          </div>
          <Button
            size="sm"
            type="button"
            data-testid="create-automation-button"
            onClick={() => onCreate()}
            className="h-8"
          >
            {t(calendar ? 'standIn.workspace.calendar_create' : 'todo.automation_create')}
            {calendar ? (
              <Plus aria-hidden="true" className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <div className="relative mb-5 mt-5">
          <Search className="pointer-events-none absolute left-3 top-2 h-4 w-4 text-text-secondary" />
          <input
            data-testid="automation-search-input"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            placeholder={t('todo.automations_search', '搜索已安排任务')}
            className="h-8 w-full rounded-full border border-border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
          />
        </div>
        {error ? <AutomationError error={error} onClear={onClearError} /> : null}
        {loading ? (
          <div className="flex h-40 items-center justify-center" data-testid="automations-loading">
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </div>
        ) : automations.length ? (
          <section className="flex flex-col gap-1" data-testid="automation-list">
            {automations.map(automation => (
              <AutomationRow
                key={automation.id}
                automation={automation}
                locale={locale}
                selected={selectedAutomationId === automation.id}
                onOpen={() => onSelect(automation)}
              />
            ))}
          </section>
        ) : (
          <p className="py-12 text-center text-sm text-text-secondary">
            {t(
              calendar
                ? query || statusFilter !== 'all'
                  ? 'standIn.workspace.calendar_no_results'
                  : 'standIn.workspace.calendar_saved_empty'
                : 'todo.automations_no_results'
            )}
          </p>
        )}
        {onReviewTemplate ? (
          <Button
            variant="ghost"
            data-testid="stand-in-weekly-review-template"
            onClick={onReviewTemplate}
          >
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t('standIn.onboarding.review_add')}
          </Button>
        ) : null}
        {!calendar && statusFilter === 'all' && !query && allAutomations.length > 0 ? (
          <>
            <div className="my-4 border-t border-border" />
            <AutomationSuggestions onSelect={onCreate} compact />
          </>
        ) : null}
      </div>
    </aside>
  )
}

export function AutomationEmptyState({
  loading,
  error,
  query,
  onQueryChange,
  onCreate,
  onClearError,
  onReviewTemplate,
  calendar = false,
}: {
  loading: boolean
  error: string | null
  query: string
  onQueryChange: (query: string) => void
  onCreate: (
    template?: Pick<AutomationDraft, 'name' | 'prompt' | 'cronExpression' | 'cronTime'>
  ) => void
  onClearError: () => void
  onReviewTemplate?: () => void
  calendar?: boolean
}) {
  const { t } = useTranslation('common')
  if (calendar)
    return (
      <div className="min-w-0 flex-1 overflow-y-auto py-3" data-testid="stand-in-calendar-empty">
        <Button
          size="sm"
          type="button"
          data-testid="create-automation-button"
          onClick={() => onCreate()}
          className="h-8"
        >
          <Plus aria-hidden="true" className="h-4 w-4" />
          {t('standIn.workspace.calendar_create')}
        </Button>
        {onReviewTemplate ? (
          <Button
            variant="ghost"
            data-testid="stand-in-weekly-review-template"
            onClick={onReviewTemplate}
          >
            {t('standIn.onboarding.review')}
          </Button>
        ) : null}
        {error ? <AutomationError error={error} onClear={onClearError} /> : null}
        {loading ? (
          <p role="status" className="py-5 text-sm text-text-muted">
            {t('standIn.loading')}
          </p>
        ) : !error ? (
          <p className="py-5 text-sm text-text-muted">{t('standIn.workspace.calendar_empty')}</p>
        ) : null}
      </div>
    )
  return (
    <div className="relative min-w-0 flex-1 overflow-y-auto">
      <button
        type="button"
        data-testid="create-automation-button"
        onClick={() => onCreate()}
        className="absolute right-4 top-[max(8px,env(safe-area-inset-top))] z-chrome inline-flex h-11 items-center gap-1.5 rounded-full bg-text-primary px-4 text-sm font-medium text-background hover:opacity-85 md:top-4 md:h-8 md:px-3.5"
      >
        {t('todo.automation_create', '创建')}
        <ChevronDown className="h-3.5 w-3.5" />
      </button>
      <div className="mx-auto w-full max-w-[660px] px-5 pb-16 pt-[61px] md:px-0">
        <header className="mb-[23px]">
          <h1 className="text-heading-lg font-normal tracking-[-0.02em]">
            {t('todo.automations_title', '已安排的任务')}
          </h1>
          <p className="mt-0.5 text-base text-text-secondary">
            {t('todo.automations_description', '让 Wework 安排任务、设置提醒或监测更新')}
          </p>
        </header>
        <div className="relative mb-[26px]">
          <Search className="pointer-events-none absolute left-3 top-[7px] h-4 w-4 text-text-secondary" />
          <input
            data-testid="automation-search-input"
            value={query}
            onChange={event => onQueryChange(event.target.value)}
            placeholder={t('todo.automations_search', '搜索已安排任务')}
            className="h-[30px] w-full rounded-full border border-border bg-background pl-9 pr-3 text-sm outline-none placeholder:text-text-tertiary focus:border-text-tertiary"
          />
        </div>
        {error ? <AutomationError error={error} onClear={onClearError} /> : null}
        {loading ? (
          <div className="flex h-40 items-center justify-center" data-testid="automations-loading">
            <Loader2 className="h-5 w-5 animate-spin text-text-tertiary" />
          </div>
        ) : (
          <AutomationSuggestions onSelect={onCreate} />
        )}
      </div>
    </div>
  )
}

function AutomationError({ error, onClear }: { error: string; onClear: () => void }) {
  return (
    <button
      type="button"
      data-testid="automation-error"
      onClick={onClear}
      className="mb-4 flex w-full items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/5 px-3 py-2 text-left text-sm text-red-600 dark:text-red-400"
    >
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">{error}</span>
    </button>
  )
}

function AutomationSuggestions({
  onSelect,
  compact = false,
}: {
  onSelect: (
    template: Pick<AutomationDraft, 'name' | 'prompt' | 'cronExpression' | 'cronTime'>
  ) => void
  compact?: boolean
}) {
  const { t } = useTranslation('common')
  const suggestions = [
    {
      name: t('todo.automation_daily_brief', '每日简报'),
      description: t(
        'todo.automation_daily_brief_prompt',
        '给我一份晨间简报，包含我的日程安排、重要未读邮件，以及今天需要我关注的事项。'
      ),
      schedule: t('todo.automation_daily_brief_schedule', '工作日 8:00'),
      cronExpression: '0 8 * * 1-5',
      cronTime: '08:00',
      icon: Bell,
      iconClassName: 'text-blue-500',
    },
    {
      name: t('todo.automation_weekly_review', '每周回顾'),
      description: t(
        'todo.automation_weekly_review_prompt',
        '每周五将你最近的工作整理成简明的状态更新'
      ),
      schedule: t('todo.automation_weekly_review_schedule', '星期五（时间：16:00）'),
      cronExpression: '0 16 * * 5',
      cronTime: '16:00',
      icon: ClipboardList,
      iconClassName: 'text-violet-500',
    },
    {
      name: t('todo.automation_follow_up', '跟进监控'),
      description: t(
        'todo.automation_follow_up_prompt',
        '查看最近的电子邮箱和日历活动，并标记需要你关注的事项'
      ),
      schedule: t('todo.automation_follow_up_schedule', '工作日 9:00'),
      cronExpression: '0 9 * * 1-5',
      cronTime: '09:00',
      icon: FileSearch,
      iconClassName: 'text-emerald-600',
    },
  ]
  return (
    <section data-testid="automation-suggestions">
      <h2 className="mb-2 px-1 text-sm font-medium text-text-secondary">
        {t('todo.automation_suggestions', '建议')}
      </h2>
      <div className="flex flex-col gap-0.5">
        {suggestions.slice(compact ? 1 : 0).map((suggestion, index) => {
          const Icon = suggestion.icon
          return (
            <button
              key={suggestion.name}
              type="button"
              data-testid={`automation-suggestion-${compact ? index + 1 : index}`}
              onClick={() =>
                onSelect({
                  name: suggestion.name,
                  prompt: suggestion.description,
                  cronExpression: suggestion.cronExpression,
                  cronTime: suggestion.cronTime,
                })
              }
              className="group flex min-h-[65px] w-full items-center gap-3 rounded-lg px-1.5 py-2 text-left hover:bg-surface"
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center">
                <Icon className={cn('h-[18px] w-[18px]', suggestion.iconClassName)} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="truncate text-sm font-medium">{suggestion.name}</span>
                  <span className="truncate text-xs text-text-tertiary">{suggestion.schedule}</span>
                </span>
                <span className="block truncate text-xs text-text-secondary">
                  {suggestion.description}
                </span>
              </span>
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100">
                <Plus className="h-4 w-4" />
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}

function AutomationRow({
  automation,
  locale,
  selected,
  onOpen,
}: {
  automation: Automation
  locale: string
  selected: boolean
  onOpen: () => void
}) {
  const { t } = useTranslation('common')
  return (
    <article data-testid={`automation-row-${automation.id}`}>
      <button
        type="button"
        data-testid={`automation-open-${automation.id}`}
        onClick={onOpen}
        className={cn(
          'flex min-h-[58px] w-full items-start gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-surface',
          selected && 'bg-surface'
        )}
      >
        {automation.enabled ? (
          <Clock aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-text-secondary" />
        ) : (
          <PauseCircle aria-hidden="true" className="mt-1 h-4 w-4 shrink-0 text-text-tertiary" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex items-center justify-between gap-3">
            <span className="truncate text-sm font-medium">{automation.name}</span>
            <span className="shrink-0 rounded-md bg-muted px-2 py-0.5 text-xs text-text-secondary">
              {t(
                automation.enabled
                  ? 'todo.automation_filter_active'
                  : 'todo.automation_filter_paused'
              )}
            </span>
          </span>
          <span
            className="mt-1 block text-sm text-text-secondary"
            title={automation.schedule.type === 'cron' ? automation.schedule.expression : undefined}
          >
            {formatScheduleSummary(automation.schedule, locale, t, automation.timezone)}
          </span>
          {automation.enabled && (
            <span className="mt-1 block text-xs text-text-tertiary">
              {t('todo.automation_next_run_at', {
                time:
                  formatNextRun(automation.nextRunAt, locale, automation.timezone) ??
                  t('todo.automation_waiting_schedule'),
              })}
            </span>
          )}
        </span>
      </button>
    </article>
  )
}

function formatScheduleSummary(
  schedule: AutomationSchedule,
  locale: string,
  t: ReturnType<typeof useTranslation>['t'],
  timezone: string
): string {
  if (schedule.type === 'interval') {
    return locale.startsWith('zh')
      ? `每 ${schedule.value} ${schedule.unit === 'minutes' ? '分钟' : schedule.unit === 'hours' ? '小时' : '天'}`
      : `Every ${schedule.value} ${schedule.unit}`
  }
  if (schedule.type === 'one_time') {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: timezone,
    }).format(new Date(schedule.executeAt))
  }
  const parts = schedule.expression.trim().split(/\s+/)
  if (
    parts.length === 5 &&
    /^\d+$/.test(parts[0]) &&
    /^\d+$/.test(parts[1]) &&
    parts[2] === '*' &&
    parts[3] === '*'
  ) {
    const time = `${String(Number(parts[1])).padStart(2, '0')}:${String(Number(parts[0])).padStart(2, '0')}`
    if (parts[4] === '1-5') return locale.startsWith('zh') ? `工作日 ${time}` : `Weekdays ${time}`
    if (parts[4] === '*') return locale.startsWith('zh') ? `每天 ${time}` : `Daily ${time}`
    if (/^[0-7]$/.test(parts[4])) {
      const day = new Intl.DateTimeFormat(locale, {
        weekday: locale.startsWith('zh') ? 'short' : 'long',
        timeZone: 'UTC',
      }).format(new Date(Date.UTC(2023, 0, 1 + (Number(parts[4]) % 7))))
      return t('todo.automation_weekly_at', { day, time })
    }
  }
  return t('todo.automation_custom_schedule')
}

function formatNextRun(
  value: string | null | undefined,
  locale: string,
  timezone: string
): string | null {
  if (!value) return null
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: timezone,
    timeZoneName: 'short',
  }).format(new Date(value))
}
