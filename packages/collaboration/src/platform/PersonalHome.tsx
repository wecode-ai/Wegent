import type { ComponentProps, ReactNode, Ref } from 'react'
import { SelectContent, SelectItem, SelectRoot, SelectTrigger } from '../controls/SelectParts'
import { normalizeSelectValue } from '../controls/selectValue'
import { CompositedSpinner } from '../issue-detail/CompositedSpinner'
import { Button as ControlButton } from '../markdown/Button'
import { PersonalIssueErrors } from './PersonalIssueErrors'
import { PersonalIssueList } from './PersonalIssueList'
import type { PersonalHomeIssueOrder } from './usePersonalHomeIssues'

export function PersonalHome({
  list,
  createIssue,
  composerRegion,
  focusComposer,
  headerAction,
  subtitle,
  firstUse,
  hideOnMobile,
  scrollOnMobile,
  setAssignedOnly,
  setShowCompleted,
  setOrder,
}: {
  list: Omit<ComponentProps<typeof PersonalIssueList>, 'hideEmpty' | 'emptyState'>
  createIssue: ReactNode
  composerRegion?: Ref<HTMLDivElement>
  focusComposer(): void
  headerAction?: ReactNode
  subtitle?: string
  firstUse: boolean
  hideOnMobile?: boolean
  scrollOnMobile?: boolean
  setAssignedOnly(value: boolean): void
  setShowCompleted(value: boolean): void
  setOrder(value: PersonalHomeIssueOrder): void
}) {
  const { assignedOnly, showCompleted, order, state, translate: t } = list
  return (
    <section
      tabIndex={-1}
      aria-busy={state.loading}
      data-testid="personal-home-items-region"
      className={`min-w-0 flex-1 flex-col p-5 ${scrollOnMobile ? 'overflow-auto [scrollbar-gutter:stable]' : 'lg:overflow-auto lg:[scrollbar-gutter:stable]'} ${hideOnMobile ? 'hidden md:flex' : 'flex'}`}
    >
      <div className="w-full max-w-6xl">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-heading-md font-medium">{t('personalHome.title')}</h1>
            <p className="mt-2 text-base text-text-secondary">
              {subtitle ?? t('personalHome.subtitle')}
            </p>
          </div>
          {headerAction}
        </header>
        <div ref={composerRegion} className="mb-5" data-testid="personal-home-create">
          {createIssue}
        </div>
        <div
          hidden={firstUse}
          className={firstUse ? 'hidden' : 'mb-3 flex flex-wrap items-center justify-between gap-3'}
        >
          <div
            role="group"
            aria-label={t('personalHome.issueScope')}
            className="flex min-w-0 flex-wrap items-center gap-1"
          >
            {[
              { value: true, label: 'assigned' },
              { value: false, label: 'participating' },
            ].map(option => (
              <ControlButton
                variant="unstyled"
                type="button"
                key={option.label}
                data-testid={`personal-home-scope-${option.label}`}
                aria-pressed={assignedOnly === option.value}
                onClick={() => setAssignedOnly(option.value)}
                className={`min-h-11 rounded-md px-3 text-base md:min-h-8 ${assignedOnly === option.value ? 'bg-muted font-medium text-text-primary' : 'text-text-secondary hover:bg-muted'}`}
              >
                {t(`personalHome.${option.label}`)}
              </ControlButton>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <CompositedSpinner
              role="img"
              aria-label={t('personalHome.loading')}
              aria-hidden={!state.loading}
              className={`size-3 text-text-secondary ${state.loading ? '' : 'invisible'}`}
            />
            <SelectRoot
              value={normalizeSelectValue(order)}
              onValueChange={selectedValue => {
                if (selectedValue !== null) return setOrder(selectedValue as PersonalHomeIssueOrder)
              }}
            >
              <SelectTrigger
                density="compact"
                appearance="plain"
                aria-label={t('personalHome.sort')}
                data-testid="personal-home-sort"
                className="wework-native-select"
              />
              <SelectContent>
                {(['attention', 'assignment', 'activity', 'priority'] as const).map(value => (
                  <SelectItem key={value} value={String(value)}>
                    {t(`personalHome.sort_${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </SelectRoot>
            <SelectRoot
              value={normalizeSelectValue(showCompleted ? 'all' : 'open')}
              onValueChange={selectedValue => {
                if (selectedValue !== null) return setShowCompleted(selectedValue === 'all')
              }}
            >
              <SelectTrigger
                density="compact"
                appearance="plain"
                aria-label={t('personalHome.filter')}
                data-testid="personal-home-filter"
                className="wework-native-select"
              />
              <SelectContent>
                <SelectItem value="open">{t('personalHome.open')}</SelectItem>
                <SelectItem value="all">{t('personalHome.all')}</SelectItem>
              </SelectContent>
            </SelectRoot>
          </div>
        </div>
        <PersonalIssueErrors state={state} translate={t} />
        <PersonalIssueList
          hideEmpty={firstUse}
          emptyState={
            <div data-testid="personal-home-empty" className="py-6">
              <p className="text-base text-text-secondary">
                {t(
                  assignedOnly
                    ? 'personalHome.emptyAssigned'
                    : showCompleted
                      ? 'personalHome.emptyParticipation'
                      : 'personalHome.emptyUnfinished'
                )}
              </p>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="personal-home-empty-action"
                className="mt-2 min-h-11 rounded-md px-2 text-sm text-text-primary hover:bg-muted md:min-h-8"
                onClick={() => {
                  if (assignedOnly || !showCompleted) {
                    setAssignedOnly(false)
                    setShowCompleted(true)
                  } else {
                    focusComposer()
                  }
                }}
              >
                {t(
                  assignedOnly || !showCompleted
                    ? 'personalHome.viewAllParticipation'
                    : 'personalHome.startWriting'
                )}
              </ControlButton>
            </div>
          }
          {...list}
        />
        {state.hasMore && (
          <ControlButton
            variant="unstyled"
            type="button"
            data-testid="personal-home-load-more"
            disabled={!state.canLoadMore}
            onClick={() => void state.loadMore()}
            className="min-h-11 rounded-md px-3 text-sm text-text-secondary hover:bg-muted md:min-h-8"
          >
            {t('personalHome.loadMore')}
          </ControlButton>
        )}
      </div>
    </section>
  )
}
