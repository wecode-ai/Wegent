import { useMemo, useSyncExternalStore } from 'react'
import { createAsyncResource } from '@wegent/chat-core/async-resource'
import { SelectField } from '@wegent/collaboration/controls/SelectField'
import type { StandInExecutorApi } from '@/api/standIn'
import { useTranslation } from '@/hooks/useTranslation'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { StandInSettingsError } from './StandInSettingsLayout'

export function StandInCreateTeam({
  api,
  userId,
  deviceId,
  teamRef,
  disabled,
  onSelect,
}: {
  api: StandInExecutorApi
  userId: number
  deviceId: string
  teamRef?: string | null
  disabled: boolean
  onSelect(team: { id: string; name: string } | undefined): void
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
          ).bindableTeams ?? []
      ),
    [api, userId, deviceId]
  )
  const snapshot = useSyncExternalStore(catalog.subscribe, catalog.getSnapshot)
  const teams = snapshot.data ?? []
  return (
    <div className="grid gap-2">
      <span className="text-text-secondary">{t('standIn.personal.create_team_source')}</span>
      <SelectField
        testId="stand-in-create-team"
        accessibleLabel={t('standIn.personal.create_team_source')}
        options={[
          { value: 'new', label: t('standIn.personal.create_new_team') },
          ...teams.map(team => ({ value: team.id, label: team.name })),
        ]}
        value={teamRef || 'new'}
        disabled={disabled || snapshot.status === 'loading'}
        onChange={value => onSelect(teams.find(team => team.id === value))}
      />
      {snapshot.status === 'error' && (
        <StandInSettingsError
          error={getStandInErrorMessage(snapshot.error, 'load_environment_failed')}
          retry={{ testId: 'stand-in-create-team-retry', onClick: () => void catalog.reload() }}
        />
      )}
    </div>
  )
}
