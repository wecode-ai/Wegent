import { Bot, Users } from 'lucide-react'
import { ActionMenu } from '@/components/common/ActionMenu'
import { ExperimentalBadge } from '@/features/experimental-features/ExperimentalBadge'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team } from '@/types/api'

interface WorkbenchTeamSelectorProps {
  teams: Team[]
  selectedTeamId: number | null
  loading: boolean
  onTeamChange: (team: Team | null) => void
}

function teamLabel(team: Team): string {
  return team.displayName?.trim() || team.name
}

export function WorkbenchTeamSelector({
  teams,
  selectedTeamId,
  loading,
  onTeamChange,
}: WorkbenchTeamSelectorProps) {
  const { t } = useTranslation('common')
  const selectedTeam = teams.find(team => team.id === selectedTeamId) ?? null

  return (
    <ActionMenu
      ariaLabel={t('workbench.team_selector', '选择 Wegent 智能体')}
      testId="workbench-team-selector"
      icon={selectedTeam ? Users : Bot}
      triggerLabel={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="max-w-40 truncate">
            {selectedTeam ? teamLabel(selectedTeam) : 'Codex'}
          </span>
          {selectedTeam && <ExperimentalBadge testId="workbench-team-experimental-badge" />}
        </span>
      }
      placement="bottom-end"
      triggerClassName="flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm text-text-secondary hover:bg-background/70 hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
      items={[
        {
          label: 'Codex',
          icon: Bot,
          testId: 'workbench-team-option-codex',
          onSelect: () => onTeamChange(null),
        },
        ...teams.map(team => ({
          label: teamLabel(team),
          icon: Users,
          testId: `workbench-team-option-${team.id}`,
          disabled: loading,
          onSelect: () => onTeamChange(team),
        })),
      ]}
    />
  )
}
