import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { IssueDetailSearchableSelect, type RunnerEnvironment } from '@wegent/collaboration'
import { useTranslation } from '@/hooks/useTranslation'

export function AgentEnvironmentPicker({
  value,
  environments,
  onChange,
  testId,
  disabled,
  loading,
  selectionOnly = false,
  projectScoped = false,
}: {
  value: string
  environments: RunnerEnvironment[]
  onChange(value: string): void
  testId: string
  disabled: boolean
  loading: boolean
  selectionOnly?: boolean
  projectScoped?: boolean
}) {
  const { t } = useTranslation('common')
  const [showOffline, setShowOffline] = useState(false)
  const environment = environments.find(item => item.id === value)
  const environmentLabel = (item: RunnerEnvironment) =>
    `${item.name} · ${t(`workbench.runner_status_${item.status}`)}`
  const policies = [
    { value: 'policy:project_pool', label: t('workbench.runner_project_pool') },
    ...(!selectionOnly
      ? [{ value: 'policy:user_select', label: t('workbench.runner_user_select') }]
      : []),
  ]
  const selectedLabel = environment
    ? environmentLabel(environment)
    : (policies.find(option => option.value === value)?.label ??
      (value
        ? `${value}${loading ? '' : ` · ${t('workbench.runner_environment_unavailable')}`}`
        : t('workbench.runner_choose_environment')))
  const isShared = (item: RunnerEnvironment) =>
    item.project_authorized || (!projectScoped && item.owner_type === 'workspace')
  const deviceOptions = (['shared', 'personal'] as const).flatMap(group =>
    environments
      .filter(
        item =>
          (group === 'shared' ? isShared(item) : !isShared(item) && item.owner_type === 'user') &&
          (showOffline || item.status === 'online')
      )
      .sort((left, right) => Number(right.status === 'online') - Number(left.status === 'online'))
      .map(item => ({
        value: item.id,
        label: environmentLabel(item),
        section: t('workbench.runner_specify_device'),
        group: t(
          group === 'personal'
            ? 'workbench.runner_personal_devices'
            : projectScoped
              ? 'workbench.runner_project_devices'
              : 'workbench.runner_shared_devices'
        ),
        searchText: `${item.device_key} ${item.id}`,
      }))
  )

  return (
    <IssueDetailSearchableSelect
      value={value}
      options={[...policies, ...deviceOptions]}
      testId={testId}
      accessibleLabel={t('workbench.runner_environment')}
      disabled={disabled}
      className="flex h-11 w-full items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 text-left text-sm text-text-primary outline-none focus-visible:ring-2 focus-visible:ring-focus/20 disabled:opacity-50 md:h-9"
      contentClassName="w-[var(--radix-popover-trigger-width)]"
      triggerContent={
        <>
          <span className="min-w-0 flex-1 truncate">{selectedLabel}</span>
          <ChevronDown aria-hidden="true" className="h-4 w-4 shrink-0 text-text-muted" />
        </>
      }
      searchPlaceholder={t('workbench.runner_search_environments')}
      emptyLabel={t('workbench.runner_no_matching_environments')}
      footer={
        <label className="flex min-h-11 cursor-pointer items-center justify-end gap-2 rounded-lg px-2.5 text-xs text-text-secondary md:min-h-9">
          <input
            type="checkbox"
            data-testid={`${testId}-show-offline`}
            checked={showOffline}
            onChange={event => setShowOffline(event.target.checked)}
            className="h-4 w-4 accent-current"
          />
          <span>{t('workbench.runner_show_offline')}</span>
        </label>
      }
      onChange={onChange}
    />
  )
}
