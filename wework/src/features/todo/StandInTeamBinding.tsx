import { useMemo, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { StandInSettingsError } from './StandInSettingsLayout'

export function StandInTeamBinding({
  api,
  userId,
  deviceId,
  value,
  disabled,
  onChange,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  value?: string | null
  disabled: boolean
  onChange(teamRef: string | null): void
}) {
  const { t } = useTranslation('common')
  const catalog = useMemo(
    () =>
      createAsyncResource(
        JSON.stringify([userId, deviceId]),
        async () =>
          (
            await api.personalGet(userId, deviceId, {
              deviceSettingsOnly: true,
              includeTeams: true,
            })
          ).bindableTeams
      ),
    [api, userId, deviceId]
  )
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  if (snapshot.status === 'error')
    return (
      <StandInSettingsError
        error={getStandInErrorMessage(snapshot.error, 'load_environment_failed')}
        retry={{ testId: 'stand-in-team-binding-retry', onClick: () => void catalog.reload() }}
      />
    )
  if (!snapshot.data) return null
  const selected = value?.startsWith('LA-') ? value : 'own'
  const options = [
    { value: 'own', label: t('standIn.workspace.execution_agent_default') },
    ...snapshot.data.map(team => ({ value: team.id, label: team.name })),
  ]
  if (!options.some(option => option.value === selected))
    options.push({ value: selected, label: selected })
  return (
    <div className="grid gap-1">
      <span className="text-sm font-medium">{t('standIn.workspace.execution_agent')}</span>
      <SelectField
        testId="stand-in-team-binding"
        accessibleLabel={t('standIn.workspace.execution_agent')}
        options={options}
        value={selected}
        disabled={disabled}
        onChange={next => onChange(next === 'own' ? null : next)}
      />
    </div>
  )
}
