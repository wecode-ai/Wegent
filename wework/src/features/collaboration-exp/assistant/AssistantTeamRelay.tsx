import { useTranslation } from '@/hooks/useTranslation'
import { navigateTo } from '@/lib/navigation'
import type { ExperienceProjectData } from '../model'
import { TeamRelay } from './TeamRelay'
import { useExperienceTeamState } from './useExperienceTeamState'

export interface AssistantTeamRelayProps {
  active: boolean
  projects: readonly ExperienceProjectData[]
}

/** The tasks surface uses the same data source as the assistant home. */
export function AssistantTeamRelay({ active, projects }: AssistantTeamRelayProps) {
  const { t } = useTranslation('collaborationExp')
  const { source, ownerId, snapshot, ready, error, refresh } = useExperienceTeamState(
    active,
    projects
  )
  return (
    <div data-testid="collaboration-exp-connected-team-relay">
      <TeamRelay
        nodes={snapshot.team}
        ready={ready}
        managementAvailable={Boolean(active && source.settings && source.deviceId)}
        onManage={roleId => {
          const query = new URLSearchParams({
            profileId: roleId ?? '@primary',
            deviceId:
              source.settings?.roles.find(role => role.id === roleId)?.executionDeviceId ??
              source.deviceId ??
              '',
            userId: String(ownerId),
            settingsRequest: String(Date.now()),
          })
          navigateTo(`/stand-in?${query}`)
        }}
      />
      {source.loading && (
        <p role="status" className="px-4 py-2 text-sm text-text-muted">
          {t('assistant.loading')}
        </p>
      )}
      {error && (
        <div role="alert" className="px-4 py-2 text-sm text-error">
          {error}
          <button
            type="button"
            data-testid="collaboration-exp-team-relay-retry"
            onClick={refresh}
            className="ml-2 min-h-11 underline md:min-h-7"
          >
            {t('assistant.retry')}
          </button>
        </div>
      )}
    </div>
  )
}
