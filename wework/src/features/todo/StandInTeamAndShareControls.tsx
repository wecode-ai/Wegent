import type {
  PersonalStandInSettings,
  StandInRole,
  StandInShareEntry,
  StandInTeam,
} from '@/api/personalStandIn'
import type { StandInExecutorApi } from '@/api/standIn'
import { StandInShareControl } from './StandInShareDialog'
import { StandInTeamControl } from './StandInTeamsDialog'

export function StandInTeamAndShareControls({
  api,
  settings,
  active,
  roles,
  selected,
  beforeOpen,
  onOpenTeam,
  onOpenShare,
}: {
  api: StandInExecutorApi
  settings: PersonalStandInSettings
  active: boolean
  roles: StandInRole[]
  selected?: StandInTeam
  beforeOpen(open: () => void): void
  onOpenTeam(team: StandInTeam): void
  onOpenShare(entry: StandInShareEntry): void
}) {
  return (
    <>
      <StandInTeamControl
        api={api}
        settings={settings}
        active={active}
        roles={roles}
        selected={selected}
        beforeOpen={beforeOpen}
        onOpenTeam={onOpenTeam}
      />
      {api.sharing && settings.userId > 0 && (
        <StandInShareControl
          api={api.sharing}
          settings={settings}
          active={active}
          roles={roles}
          beforeOpen={beforeOpen}
          onOpenShare={onOpenShare}
        />
      )}
    </>
  )
}
